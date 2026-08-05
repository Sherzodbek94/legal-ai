import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  DeliveryError,
  classifyHttpStatus,
  parseRetryAfter,
} from './delivery-error';

export interface SmsResult {
  providerMessageId?: string;
}

/**
 * The envelope every DevSMS endpoint answers with.
 *
 * `success` is the field that decides the outcome — see `unwrap` for why the
 * HTTP status is not enough on its own.
 */
interface DevSmsEnvelope<T> {
  success?: boolean;
  error?: string;
  message?: string;
  data?: T;
}

/**
 * Numeric fields are typed loosely on purpose.
 *
 * The published examples show them as JSON numbers (`"balance": 950`), but the
 * live API answers with decimal strings (`"balance": "400.00"`). A `typeof x ===
 * 'number'` check against this payload is therefore dead code that always
 * skips — which is how the balance warning below was silently doing nothing
 * until a real response was compared against the documentation.
 */
interface SendData {
  /** DevSMS's own row id. Accepted by `get_status.php` as `sms_id`. */
  sms_id?: number | string;
  /** Upstream gateway's id. Accepted by `get_status.php` as `request_id`. */
  request_id?: string;
  status?: string;
  parts_count?: number | string;
  /** What this message cost, in the same units as `balance`. */
  total_cost?: number | string;
  /** Credit left after this message — the only warning before sending stops. */
  balance?: number | string;
}

interface StatusData {
  status?: string;
}

/**
 * DevSMS.uz SMS delivery.
 *
 * A gateway that fronts the operators behind one account. It authenticates with
 * a **static bearer token** issued from the dashboard, which is why this client
 * is a fraction of the size of the Eskiz one it replaced: there is no login
 * call, no ~30-day token to refresh, and therefore no Redis token cache and no
 * cross-replica lock to stop six pods re-authenticating at once. The token is
 * configuration, not state.
 *
 * What does need care here is the response envelope — see `unwrap`.
 */
@Injectable()
export class DevSmsService {
  private readonly logger = new Logger(DevSmsService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get baseUrl(): string {
    return this.config
      .get<string>('DEVSMS_BASE_URL', 'https://devsms.uz/api')
      .replace(/\/+$/, '');
  }

  private get token(): string {
    return this.config.get<string>('DEVSMS_TOKEN', '');
  }

  /**
   * Sender id agreed with the operator.
   *
   * `4546` is the shared TEST sender, which only delivers to numbers registered
   * on the account. Leaving it as the default in production means messages are
   * accepted and silently not delivered — so it is logged as a warning on use.
   */
  private get from(): string {
    return this.config.get<string>('DEVSMS_FROM', '4546');
  }

  /**
   * Which upstream gateway DevSMS should route through.
   *
   * Left empty by default so the account's own default applies. Worth setting
   * only when an account has several gateways and the choice matters.
   */
  private get gatewayType(): string {
    return this.config.get<string>('DEVSMS_TYPE', '');
  }

  /**
   * Business name substituted into the OTP template.
   *
   * Not a sender id — the sender is DevSMS's own approved one. This is the name
   * that appears inside the message text, and it is what their AI moderation
   * judges. A name it rejects is charged for and not delivered, so `sendOtp`
   * checks the documented 2–50 character bound before spending anything.
   */
  private get serviceName(): string {
    return this.config.get<string>('DEVSMS_SERVICE_NAME', 'LegalTech');
  }

  /**
   * Which pre-approved OTP template to use: 1 confirms an action, 2 resets a
   * password, 3 registers, 4 signs in. Defaults to 4 because one code here does
   * both jobs — a first code to an unknown number creates the account — and
   * "kirish" reads correctly for a returning user and a new one alike.
   */
  private get otpTemplate(): number {
    // Coerced rather than asserted: `numericConfig` normally turns this into a
    // number, but a value that reaches ConfigService by another route is still a
    // string, and `Number.isInteger('4')` is false. Garbage becomes NaN and is
    // rejected loudly by the caller rather than silently defaulting — a typo'd
    // template would otherwise send the wrong message for months.
    const raw = this.config.get<number | string>('DEVSMS_OTP_TEMPLATE', 4);
    return typeof raw === 'number' ? raw : Number(raw);
  }

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  /**
   * Sends arbitrary text.
   *
   * Uzbek operators moderate message templates, so text that has not been
   * approved on the account may be accepted here and never delivered. Fine for
   * notifications, which are not time-critical and can be chased through
   * another channel. Not fine for a login code — use `sendOtp` for those.
   */
  async send(phone: string, message: string): Promise<SmsResult> {
    const normalized = this.prepare(phone);

    if (this.from === '4546') {
      this.logger.warn(
        'Sending via DevSMS\'s default sender (4546) with unmoderated text; delivery is not guaranteed',
      );
    }

    return this.dispatch(
      {
        phone: normalized,
        message,
        from: this.from,
        ...(this.gatewayType ? { type: this.gatewayType } : {}),
      },
      'send',
    );
  }

  /**
   * Sends a one-time code through DevSMS's pre-approved OTP templates.
   *
   * The reason this exists separately from `send`: the message text is not ours
   * to choose. Operators here require templates to be approved before they will
   * carry them, and getting a custom one approved — or a branded sender id —
   * takes weeks. `universal_otp` borrows a template that is already approved, so
   * only the business name and the code are ours to supply and a new account can
   * deliver codes on day one.
   *
   * The cost of that is a fixed wording: the expiry hint the old text carried
   * ("Kod 5 daqiqa amal qiladi") is gone, because the template has no room for
   * it. The UI states the expiry anyway, which is where it is actually readable.
   */
  async sendOtp(phone: string, code: string): Promise<SmsResult> {
    const normalized = this.prepare(phone);

    // Both bounds are the gateway's, and both are checked here rather than
    // discovered from a rejection — DevSMS documents that a message refused
    // over the business name is still billed, and a code that costs money and
    // never arrives is the worst outcome available.
    const name = this.serviceName.trim();
    if (name.length < 2 || name.length > 50) {
      throw new DeliveryError(
        `DEVSMS_SERVICE_NAME must be 2-50 characters; got ${name.length}`,
        'misconfigured',
      );
    }

    if (!/^\d{4,8}$/.test(code)) {
      // Almost always OTP_CODE_LENGTH set outside the range the template
      // accepts, which is a configuration error rather than a bad request.
      throw new DeliveryError(
        `DevSMS OTP templates take a 4-8 digit code; got ${code.length} digits`,
        'misconfigured',
      );
    }

    const template = this.otpTemplate;
    if (!Number.isInteger(template) || template < 1 || template > 4) {
      throw new DeliveryError(
        `DEVSMS_OTP_TEMPLATE must be 1, 2, 3 or 4; got ${template}`,
        'misconfigured',
      );
    }

    return this.dispatch(
      {
        phone: normalized,
        type: 'universal_otp',
        template_type: template,
        service_name: name,
        // No `from`: the template carries DevSMS's own approved sender, and
        // overriding it is what would put the message back in front of a
        // moderator.
        otp_code: code,
      },
      'OTP send',
    );
  }

  /** Shared preflight: refuse early rather than pay to be told. */
  private prepare(phone: string): string {
    if (!this.isConfigured()) {
      throw new DeliveryError('DEVSMS_TOKEN is not configured', 'misconfigured');
    }

    const normalized = normalizeUzbekPhone(phone);
    if (!normalized) {
      // Permanent: the number will not become valid on a retry, and each attempt
      // is billable.
      throw new DeliveryError(
        `"${phone}" is not a valid Uzbekistan mobile number`,
        'permanent',
      );
    }

    return normalized;
  }

  /** One POST to `send_sms.php`, whichever kind of message it carries. */
  private async dispatch(
    payload: Record<string, unknown>,
    what: string,
  ): Promise<SmsResult> {
    try {
      const response = await firstValueFrom(
        this.http.post<DevSmsEnvelope<SendData>>(
          `${this.baseUrl}/send_sms.php`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/json',
            },
            timeout: 15_000,
          },
        ),
      );

      const data = this.unwrap(response.data, what);

      // Nothing is wrong with THIS message — it was sent. The next one may not
      // be, and an OTP that cannot be delivered locks people out of the product
      // entirely, so the warning is worth raising while there is still time to
      // act on it. The trigger is "cannot afford another message like this one"
      // rather than "balance is zero", which fires one message too late.
      const balance = toNumber(data?.balance);
      const cost = toNumber(data?.total_cost);
      if (balance !== null && balance < (cost ?? 1)) {
        this.logger.error(
          `DevSMS balance is down to ${balance} and the last message cost ${
            cost ?? 'an unknown amount'
          }; sending is about to start failing`,
        );
      }

      // `sms_id` is DevSMS's own id and is what `get_status.php` keys on first;
      // `request_id` is the upstream gateway's and works there too, so it is a
      // usable fallback if a response ever omits the former.
      const id = data?.sms_id ?? data?.request_id;

      return { providerMessageId: id === undefined ? undefined : String(id) };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw this.toDeliveryError(error as AxiosError<DevSmsEnvelope<unknown>>);
    }
  }

  /**
   * Checks a message's delivery state.
   *
   * SMS is the only channel here that reports actual delivery rather than just
   * acceptance, which is worth reconciling: "the gateway took it" and "the phone
   * received it" are different facts and only the second one means the user was
   * told.
   */
  async getStatus(providerMessageId: string): Promise<string | null> {
    try {
      // Both id forms are valid query keys; the numeric one is `sms_id`, the
      // uuid one is `request_id`. Sending the wrong key returns "not found",
      // which would read as a lost message rather than a mislabelled lookup.
      const params = /^\d+$/.test(providerMessageId)
        ? { sms_id: providerMessageId }
        : { request_id: providerMessageId };

      const response = await firstValueFrom(
        this.http.get<DevSmsEnvelope<StatusData>>(
          `${this.baseUrl}/get_status.php`,
          {
            headers: { Authorization: `Bearer ${this.token}` },
            params,
            timeout: 10_000,
          },
        ),
      );

      return this.unwrap(response.data, 'status')?.status ?? null;
    } catch (error) {
      this.logger.warn(
        `Could not read DevSMS status for ${providerMessageId}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
      return null;
    }
  }

  /**
   * Reads the payload out of the envelope, or throws.
   *
   * THE important function in this file. DevSMS reports failures in the body —
   * `{"success": false, "error": "..."}` — and does not guarantee a non-2xx
   * status alongside it. Trusting the HTTP status alone would make a refused
   * message indistinguishable from a delivered one: `send` would return
   * successfully, the notification row would be marked sent, and for an OTP the
   * user would sit in front of a code box waiting for a message the gateway had
   * already said it would not send. Nothing downstream would log an error.
   *
   * A body-level failure that arrived with a 2xx has no status to classify, so
   * it is treated as transient. That errs towards retrying: the number was
   * already validated locally before the call, so the plausible causes left are
   * account- or gateway-side — an exhausted balance, an upstream outage — and
   * those do recover. A message the gateway refused is not billed, so a retry
   * costs nothing but a queue slot.
   */
  private unwrap<T>(
    body: DevSmsEnvelope<T> | undefined,
    what: string,
  ): T | undefined {
    if (body?.success === true) return body.data;

    const detail = body?.error ?? body?.message ?? 'no reason given';
    throw new DeliveryError(
      `DevSMS refused the ${what} request: ${detail}`,
      'transient',
    );
  }

  private toDeliveryError(
    error: AxiosError<DevSmsEnvelope<unknown>>,
  ): DeliveryError {
    const status = error.response?.status;
    const retryAfter = parseRetryAfter(
      error.response?.headers?.['retry-after'] as string | undefined,
    );

    const detail =
      error.response?.data?.error ??
      error.response?.data?.message ??
      error.message ??
      'unknown error';

    return new DeliveryError(
      `DevSMS request failed${status ? ` (HTTP ${status})` : ''}: ${detail}`,
      classifyHttpStatus(status),
      status,
      retryAfter,
    );
  }
}

/**
 * Reads one of DevSMS's loosely-typed numeric fields.
 *
 * Returns null rather than NaN for anything unusable, so a missing field and a
 * zero balance stay distinguishable — `Number(null)` is 0, which would report an
 * absent value as an exhausted account.
 */
function toNumber(value: number | string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalises an Uzbekistan mobile number to the digits-only form DevSMS expects.
 *
 * Accepts `+998901234567`, `998901234567`, `901234567`, and the spaced or
 * hyphenated forms people actually type. Returns null for anything that is not a
 * plausible Uzbek mobile — better to reject it here as permanent than to pay for
 * five delivery attempts to a number that cannot exist.
 *
 * Mobile prefixes are the 9x / 33 / 88 / 71 ranges currently in issue; the check
 * is on length and country code rather than an operator allowlist, which would go
 * stale every time a new range is allocated.
 */
export function normalizeUzbekPhone(input: string): string | null {
  const digits = (input ?? '').replace(/\D/g, '');
  if (!digits) return null;

  // Local 9-digit form.
  if (digits.length === 9) return `998${digits}`;

  if (digits.length === 12 && digits.startsWith('998')) return digits;

  return null;
}

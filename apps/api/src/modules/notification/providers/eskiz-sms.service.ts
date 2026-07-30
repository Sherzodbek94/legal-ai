import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { RedisService } from '../../../redis/redis.service';
import {
  DeliveryError,
  classifyHttpStatus,
  parseRetryAfter,
} from './delivery-error';

export interface SmsResult {
  providerMessageId?: string;
}

/**
 * Eskiz.uz SMS delivery.
 *
 * Eskiz issues a bearer token from email + password and expects it refreshed
 * before it lapses — roughly a 30-day lifetime, refreshed via `PATCH
 * /auth/refresh`. Two things make that awkward in a multi-replica service, and
 * both are handled here:
 *
 *   * The token is cached in **Redis**, not in process memory. Six replicas each
 *     holding their own token means six logins, and Eskiz treats a burst of
 *     logins from one account as suspicious.
 *   * Refresh is guarded by a Redis lock. Without it, a token expiring under load
 *     has every replica notice at once and re-authenticate simultaneously —
 *     a thundering herd against the one endpoint that must not be rate-limited.
 */
@Injectable()
export class EskizSmsService {
  private readonly logger = new Logger(EskizSmsService.name);

  private static readonly TOKEN_KEY = 'eskiz:token';
  private static readonly LOCK_KEY = 'eskiz:token:lock';
  /**
   * Cached for 25 days against a ~30-day lifetime.
   *
   * The margin matters: expiring slightly early costs one extra login, while
   * expiring slightly late costs every message sent in the gap.
   */
  private static readonly TOKEN_TTL_SECONDS = 25 * 24 * 60 * 60;
  private static readonly LOCK_TTL_SECONDS = 15;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  private get baseUrl(): string {
    return this.config
      .get<string>('ESKIZ_BASE_URL', 'https://notify.eskiz.uz/api')
      .replace(/\/+$/, '');
  }

  private get email(): string {
    return this.config.get<string>('ESKIZ_EMAIL', '');
  }

  private get password(): string {
    return this.config.get<string>('ESKIZ_PASSWORD', '');
  }

  /**
   * Sender id agreed with Eskiz.
   *
   * `4546` is their shared test sender, which only delivers to numbers registered
   * on the account. Leaving it as the default in production means messages are
   * accepted and silently not delivered — so it is logged as a warning on use.
   */
  private get from(): string {
    return this.config.get<string>('ESKIZ_FROM', '4546');
  }

  isConfigured(): boolean {
    return Boolean(this.email && this.password);
  }

  async send(phone: string, message: string): Promise<SmsResult> {
    if (!this.isConfigured()) {
      throw new DeliveryError(
        'ESKIZ_EMAIL / ESKIZ_PASSWORD are not configured',
        'misconfigured',
      );
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

    if (this.from === '4546') {
      this.logger.warn(
        'Sending via the Eskiz test sender (4546); only numbers registered on the account will receive it',
      );
    }

    // One retry, and only after a 401. That is the token-expired case — the
    // second attempt uses a freshly minted token. Anything else is left to
    // BullMQ's backoff, which is better at spacing attempts than a tight loop.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.getToken(attempt === 2);

      try {
        const response = await firstValueFrom(
          this.http.post<{ id?: string; message?: string; status?: string }>(
            `${this.baseUrl}/message/sms/send`,
            // Eskiz expects form-encoded, not JSON.
            new URLSearchParams({
              mobile_phone: normalized,
              message,
              from: this.from,
            }).toString(),
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              timeout: 15_000,
            },
          ),
        );

        return { providerMessageId: response.data?.id };
      } catch (error) {
        const axiosError = error as AxiosError<{ message?: string }>;
        const status = axiosError.response?.status;

        if (status === 401 && attempt === 1) {
          this.logger.warn('Eskiz rejected the cached token; re-authenticating');
          await this.redis.client.del(EskizSmsService.TOKEN_KEY);
          continue;
        }

        throw this.toDeliveryError(axiosError);
      }
    }

    throw new DeliveryError('Eskiz authentication failed', 'misconfigured');
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
      const token = await this.getToken();
      const response = await firstValueFrom(
        this.http.get<{ status?: string }>(
          `${this.baseUrl}/message/sms/status/${encodeURIComponent(providerMessageId)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10_000,
          },
        ),
      );
      return response.data?.status ?? null;
    } catch (error) {
      this.logger.warn(
        `Could not read Eskiz status for ${providerMessageId}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  private async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.redis.client.get(EskizSmsService.TOKEN_KEY);
      if (cached) return cached;
    }

    // `SET NX` as a lock: whoever wins re-authenticates, everyone else waits for
    // the result rather than piling onto the login endpoint.
    const acquired = await this.redis.client.set(
      EskizSmsService.LOCK_KEY,
      '1',
      'EX',
      EskizSmsService.LOCK_TTL_SECONDS,
      'NX',
    );

    if (!acquired) {
      const token = await this.awaitTokenFromOtherWorker();
      if (token) return token;
      // The lock holder failed or is slow. Falling through to authenticate is
      // better than failing the send — a duplicate login is cheap, a dropped
      // critical SMS is not.
      this.logger.warn(
        'Waited for another worker to refresh the Eskiz token and got nothing; authenticating directly',
      );
    }

    try {
      const token = await this.login();
      await this.redis.client.set(
        EskizSmsService.TOKEN_KEY,
        token,
        'EX',
        EskizSmsService.TOKEN_TTL_SECONDS,
      );
      return token;
    } finally {
      await this.redis.client.del(EskizSmsService.LOCK_KEY);
    }
  }

  /** Polls briefly for the lock holder's token. */
  private async awaitTokenFromOtherWorker(): Promise<string | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const token = await this.redis.client.get(EskizSmsService.TOKEN_KEY);
      if (token) return token;
    }
    return null;
  }

  private async login(): Promise<string> {
    try {
      const response = await firstValueFrom(
        this.http.post<{ data?: { token?: string } }>(
          `${this.baseUrl}/auth/login`,
          new URLSearchParams({
            email: this.email,
            password: this.password,
          }).toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15_000,
          },
        ),
      );

      const token = response.data?.data?.token;
      if (!token) {
        throw new DeliveryError(
          'Eskiz login returned no token',
          'misconfigured',
        );
      }

      this.logger.log('Authenticated with Eskiz; token cached');
      return token;
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw this.toDeliveryError(error as AxiosError<{ message?: string }>);
    }
  }

  private toDeliveryError(error: AxiosError<{ message?: string }>): DeliveryError {
    const status = error.response?.status;
    const retryAfter = parseRetryAfter(
      error.response?.headers?.['retry-after'] as string | undefined,
    );

    const detail =
      error.response?.data?.message ?? error.message ?? 'unknown error';

    return new DeliveryError(
      `Eskiz request failed${status ? ` (HTTP ${status})` : ''}: ${detail}`,
      classifyHttpStatus(status),
      status,
      retryAfter,
    );
  }
}

/**
 * Normalises an Uzbekistan mobile number to the digits-only form Eskiz expects.
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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  RegistryUnavailableError,
  type CounterpartyRegistryProvider,
  type RegistryLookup,
  type RegistryStatus,
} from './registry-provider';

/**
 * "The registry has no such taxpayer" — an answer, not a failure.
 *
 * Thrown from `translate` so the provider has one error path rather than a
 * second return value threaded through every call site; the service turns it
 * back into `null`.
 */
export class NotRegistered extends Error {
  constructor() {
    super('No entity is registered under this STIR');
    this.name = 'NotRegistered';
  }
}

/**
 * iHamkor ("Ishonchli hamkor") — legal-entity lookup.
 *
 * Chosen over orginfo.uz deliberately. iHamkor is operated by DEFEN FINANCIAL
 * LLC under a public-private partnership contract (DXSh/52-2022) pursuant to
 * Cabinet of Ministers Resolution No. 529 of 19 August 2021, which is the
 * instrument that permits taxpayer information to be released to third parties
 * at all — so this is the sanctioned channel for exactly this use. orginfo.uz
 * is one developer's scrape of stat.uz open data with no API, and the
 * Statistics Committee filed a complaint against its founder in December 2021;
 * depending on it from a legal product would be a liability, not a shortcut.
 *
 * ---------------------------------------------------------------------------
 * THE WIRE CONTRACT BELOW IS UNVERIFIED.
 *
 * iHamkor's API documentation is behind bot protection and their credentials
 * are issued per client, so the request shape, the field names in `parse`, and
 * the error codes are inferred, not confirmed. Same standing caveat as
 * `UzumService` and `OneIdService`, and for the same reason: it cannot be
 * settled from inside this repository.
 *
 * What that means in practice: `parse` is the only place that knows their
 * payload, and it is written to fail loudly on a shape it does not recognise
 * rather than return a half-filled entity. A counterparty record silently
 * missing its director's name would reach a signature page looking complete.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class IHamkorProvider implements CounterpartyRegistryProvider {
  readonly source = 'ihamkor';

  private readonly logger = new Logger(IHamkorProvider.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get baseUrl(): string {
    return this.config
      .get<string>('IHAMKOR_BASE_URL', 'https://api.ihamkor.uz')
      .replace(/\/+$/, '');
  }

  private get apiKey(): string {
    return this.config.get<string>('IHAMKOR_API_KEY', '');
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async findByStir(stir: string): Promise<RegistryLookup | null> {
    if (!this.isConfigured()) {
      // Not retryable: no amount of waiting adds an API key.
      throw new RegistryUnavailableError(
        'No business registry provider is configured',
        false,
      );
    }

    // Captured before the request, not after: this is the age of the data the
    // caller is about to be shown, and a slow response does not make it fresher.
    const retrievedAt = new Date();

    try {
      const response = await firstValueFrom(
        this.http.get<unknown>(`${this.baseUrl}/v1/legal-entities/${stir}`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          timeout: 10_000,
        }),
      );

      const entity = this.parse(response.data, stir);
      return { entity, source: this.source, retrievedAt };
    } catch (error) {
      throw this.translate(error, stir);
    }
  }

  /**
   * Turns a 404 into "no such taxpayer" and everything else into a fault.
   *
   * The distinction is the whole point of the method: a user who typed a STIR
   * with a digit wrong needs to be told the registry has no such entity, and a
   * user whose lookup failed because the provider is down must not be told the
   * same thing — the second message would have them "correct" a STIR that was
   * right all along.
   */
  private translate(error: unknown, stir: string): unknown {
    if (error instanceof RegistryUnavailableError) return error;

    const status = (error as AxiosError)?.response?.status;

    if (status === 404) return new NotRegistered();

    if (status === 401 || status === 403) {
      // Logged, because this is a deployment fault rather than a user one and
      // nothing else in the request path will surface it.
      this.logger.error(
        `iHamkor rejected our credentials (${status}); counterparty lookup is down`,
      );
      return new RegistryUnavailableError(
        'The business registry rejected this deployment’s credentials',
        false,
      );
    }

    this.logger.warn(
      `iHamkor lookup failed for ${stir}: ${(error as Error)?.message ?? 'unknown error'}`,
    );

    // 429 and 5xx are worth another attempt; a timeout usually is too.
    return new RegistryUnavailableError(
      'The business registry is not responding',
      true,
    );
  }

  /**
   * Maps their payload onto `RegistryEntity`.
   *
   * Field names are read defensively across the spellings their public search
   * UI uses, because the exact JSON keys are unconfirmed — but `legalName` is
   * required outright. An entity with no name is not a partially useful
   * result; it is evidence the shape changed, and continuing would put an
   * empty counterparty into a contract.
   */
  private parse(body: unknown, stir: string): RegistryLookup['entity'] {
    if (!body || typeof body !== 'object') {
      throw new RegistryUnavailableError(
        'The business registry returned an unreadable response',
        false,
      );
    }

    const row = ('data' in body ? (body as { data: unknown }).data : body) as
      | Record<string, unknown>
      | null;

    if (!row || typeof row !== 'object') {
      throw new RegistryUnavailableError(
        'The business registry returned an unreadable response',
        false,
      );
    }

    const legalName = str(row.legalName ?? row.legal_name ?? row.name);

    if (!legalName) {
      this.logger.error(
        `iHamkor returned a record for ${stir} with no legal name; the response shape has probably changed`,
      );
      throw new RegistryUnavailableError(
        'The business registry returned an unreadable response',
        false,
      );
    }

    return {
      legalName,
      shortName: str(row.shortName ?? row.short_name),
      // The STIR that was asked for, not the one echoed back. They agree in
      // every ordinary case, and where they would not, taking theirs is how
      // one company's details end up filed under another company's tax number.
      stir,
      oked: str(row.oked ?? row.activityCode),
      legalAddress: str(row.address ?? row.legalAddress ?? row.legal_address),
      directorName: str(row.director ?? row.directorName ?? row.director_name),
      directorPosition: str(row.directorPosition ?? row.director_position),
      phone: str(row.phone),
      email: str(row.email),
      status: mapStatus(row.status ?? row.state),
      registeredAt: date(row.registeredAt ?? row.registered_at ?? row.regDate),
      sourceRef: str(row.id ?? row.recordId),
    };
  }
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Anything not recognisably "active" becomes UNKNOWN rather than ACTIVE.
 *
 * See `RegistryStatus`: the failure that matters is showing a liquidated
 * company as trading, so an unrecognised code must not resolve to the
 * reassuring value.
 */
function mapStatus(value: unknown): RegistryStatus {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';

  if (['ACTIVE', 'FAOL', 'ДЕЙСТВУЮЩИЙ', '1'].includes(raw)) return 'ACTIVE';
  if (['LIQUIDATED', 'TUGATILGAN', 'ЛИКВИДИРОВАН'].includes(raw)) {
    return 'LIQUIDATED';
  }
  if (['SUSPENDED', 'TOXTATILGAN', 'ПРИОСТАНОВЛЕН'].includes(raw)) {
    return 'SUSPENDED';
  }

  return 'UNKNOWN';
}

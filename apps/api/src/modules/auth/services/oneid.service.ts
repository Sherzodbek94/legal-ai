import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { RedisService } from '../../../redis/redis.service';

/**
 * A legal entity (yuridik shaxs) the authenticated citizen may act for.
 * OneID returns these for users registered as company representatives.
 */
export interface OneIdLegalEntity {
  /** Tax identification number (STIR / INN). */
  tin: string;
  name: string;
  /** True when this person is the registered director. */
  isDirector: boolean;
}

export interface OneIdProfile {
  /** OneID subject identifier. */
  userId: string;
  /** Personal identification number (JSHSHIR / PINFL). */
  pinfl?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  email?: string;
  phone?: string;
  legalEntities: OneIdLegalEntity[];
}

const STATE_TTL_SECONDS = 600;

/**
 * OneID (id.egov.uz) — Uzbekistan's national single sign-on.
 *
 * NOTE: OneID is not a stock OAuth2 provider. It uses vendor-specific grant
 * values (`one_authorization_code`, `one_access_token_identify`) and a
 * `response_type` of `one_code`, and returns a form-encoded body rather than
 * JSON. Endpoints and field names are configurable because the integration
 * contract is issued per client by the operator and has changed between
 * revisions — verify against the spec for your issued client before going
 * live.
 */
@Injectable()
export class OneIdService {
  private readonly logger = new Logger(OneIdService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly redis: RedisService,
  ) {}

  private get baseUrl(): string {
    return this.config.get<string>(
      'ONEID_BASE_URL',
      'https://sso.egov.uz/sso/oauth/Authorization.do',
    );
  }

  private get clientId(): string {
    return this.config.getOrThrow<string>('ONEID_CLIENT_ID');
  }

  private get clientSecret(): string {
    return this.config.getOrThrow<string>('ONEID_CLIENT_SECRET');
  }

  private get redirectUri(): string {
    return this.config.getOrThrow<string>('ONEID_REDIRECT_URI');
  }

  private get scope(): string {
    return this.config.get<string>('ONEID_SCOPE', 'myportal');
  }

  /**
   * Whether this deployment holds OneID credentials.
   *
   * Read with `get` rather than the `getOrThrow` accessors above so asking the
   * question is not itself an error — the sign-in page asks it on every render
   * to decide whether to offer the button at all.
   */
  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('ONEID_CLIENT_ID') &&
        this.config.get<string>('ONEID_CLIENT_SECRET') &&
        this.config.get<string>('ONEID_REDIRECT_URI'),
    );
  }

  /**
   * Builds the authorization URL and records a single-use `state`.
   *
   * `state` is stored server-side (Redis) rather than only round-tripped
   * through the client, so the callback can prove the request originated here
   * — this is the CSRF defence required by RFC 6749 §10.12.
   */
  async buildAuthorizationUrl(): Promise<{ url: string; state: string }> {
    const state = randomBytes(32).toString('base64url');

    await this.redis.client.set(
      this.stateKey(state),
      '1',
      'EX',
      STATE_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      response_type: 'one_code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scope,
      state,
    });

    return { url: `${this.baseUrl}?${params.toString()}`, state };
  }

  /** Consumes `state`; returns false if unknown, expired, or already used. */
  async consumeState(state: string): Promise<boolean> {
    if (!state) return false;
    // DEL returns the number of keys removed, making this atomically
    // single-use even if two callbacks race.
    const removed = await this.redis.client.del(this.stateKey(state));
    return removed === 1;
  }

  private stateKey(state: string): string {
    return `oneid:state:${createHash('sha256').update(state).digest('hex')}`;
  }

  /**
   * Holds a callback's `legalEntities` for the onboarding form to prefill.
   *
   * The callback is a browser redirect, not a fetch the frontend can read a
   * body from, so this data cannot travel with it directly. Redis is used
   * rather than a query param or an unencrypted cookie because these carry
   * a citizen's STIR and legal-entity affiliations — not secret, but not
   * something to put in a URL that ends up in server logs and browser
   * history either.
   */
  private legalEntitiesKey(userId: string): string {
    return `oneid:legal-entities:${userId}`;
  }

  /** Five minutes: long enough for the redirect to land and the onboarding
   * page to load, short enough that a stale, unclaimed value does not
   * linger. */
  private static readonly LEGAL_ENTITIES_TTL_SECONDS = 300;

  async cacheLegalEntities(
    userId: string,
    legalEntities: OneIdLegalEntity[],
  ): Promise<void> {
    if (legalEntities.length === 0) return;
    await this.redis.client.set(
      this.legalEntitiesKey(userId),
      JSON.stringify(legalEntities),
      'EX',
      OneIdService.LEGAL_ENTITIES_TTL_SECONDS,
    );
  }

  /** Reads and deletes: the onboarding page gets one shot at the prefill. */
  async consumeLegalEntities(userId: string): Promise<OneIdLegalEntity[]> {
    const key = this.legalEntitiesKey(userId);
    const raw = await this.redis.client.get(key);
    if (!raw) return [];

    await this.redis.client.del(key);

    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as OneIdLegalEntity[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Exchanges an authorization code for an access token, then resolves the
   * citizen profile. `state` must already have been validated by the caller.
   */
  async exchangeCode(code: string): Promise<OneIdProfile> {
    const accessToken = await this.requestAccessToken(code);
    return this.fetchProfile(accessToken);
  }

  private async requestAccessToken(code: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'one_authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code,
    });

    try {
      const response = await firstValueFrom(
        this.http.post(this.baseUrl, body.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
        }),
      );

      const token = response.data?.access_token;
      if (!token) {
        throw new UnauthorizedException('OneID did not return an access token');
      }
      return token;
    } catch (error) {
      // Never surface the provider's raw response to the client: it can echo
      // back the client_secret we just sent.
      this.logger.error(
        `OneID token exchange failed: ${(error as Error).message}`,
      );
      if (error instanceof UnauthorizedException) throw error;
      throw new InternalServerErrorException('OneID authentication failed');
    }
  }

  private async fetchProfile(accessToken: string): Promise<OneIdProfile> {
    const body = new URLSearchParams({
      grant_type: 'one_access_token_identify',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      access_token: accessToken,
      scope: this.scope,
    });

    try {
      const response = await firstValueFrom(
        this.http.post(this.baseUrl, body.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
        }),
      );

      return this.mapProfile(response.data);
    } catch (error) {
      this.logger.error(
        `OneID profile lookup failed: ${(error as Error).message}`,
      );
      throw new InternalServerErrorException('OneID authentication failed');
    }
  }

  private mapProfile(data: Record<string, unknown>): OneIdProfile {
    if (!data?.user_id && !data?.pin) {
      throw new UnauthorizedException('OneID returned an unusable profile');
    }

    // `legal_info` carries the entities this citizen may represent. OneID has
    // returned it both as an array and as a JSON string across revisions.
    const rawLegal = data.legal_info;
    let legalEntries: Array<Record<string, unknown>> = [];
    if (Array.isArray(rawLegal)) {
      legalEntries = rawLegal as Array<Record<string, unknown>>;
    } else if (typeof rawLegal === 'string' && rawLegal.trim()) {
      try {
        const parsed = JSON.parse(rawLegal);
        if (Array.isArray(parsed)) legalEntries = parsed;
      } catch {
        this.logger.warn('OneID legal_info was not parseable JSON; ignoring');
      }
    }

    return {
      userId: String(data.user_id ?? data.pin),
      pinfl: data.pin ? String(data.pin) : undefined,
      firstName: data.first_name ? String(data.first_name) : undefined,
      lastName: data.sur_name ? String(data.sur_name) : undefined,
      middleName: data.mid_name ? String(data.mid_name) : undefined,
      email: data.email ? String(data.email) : undefined,
      phone: data.mob_phone_no ? String(data.mob_phone_no) : undefined,
      legalEntities: legalEntries.map((entry) => ({
        tin: String(entry.tin ?? entry.le_tin ?? ''),
        name: String(entry.acron_UZ ?? entry.le_name ?? ''),
        isDirector: entry.is_basic === 'Y' || entry.director === 'Y',
      })),
    };
  }

  /**
   * Constant-time comparison for a caller-supplied state echoed back in a
   * redirect, used where the value is compared rather than consumed.
   */
  static statesMatch(a: string, b: string): boolean {
    const bufA = Buffer.from(a ?? '', 'utf8');
    const bufB = Buffer.from(b ?? '', 'utf8');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}

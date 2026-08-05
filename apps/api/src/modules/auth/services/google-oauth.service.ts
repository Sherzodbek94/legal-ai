import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { createHash, randomBytes } from 'node:crypto';
import { RedisService } from '../../../redis/redis.service';

export interface GoogleProfile {
  /** Google's `sub` claim — stable for the life of the account. */
  subject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

const STATE_TTL_SECONDS = 600;

/**
 * Google sign-in (OAuth 2.0 + OpenID Connect).
 *
 * Structured to mirror `OneIdService` deliberately — same single-use `state`
 * held server-side in Redis, same "never surface the provider's raw response
 * to the client" rule, same fail-closed behaviour when credentials are unset.
 * Two sign-in providers that behave differently under failure is how one of
 * them ends up with a hole nobody notices.
 *
 * Unlike OneID this is a standards-compliant OAuth2 provider, so the flow is
 * the textbook one and the endpoints are constants rather than configuration.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly redis: RedisService,
  ) {}

  /** False when the deployment has no Google credentials; the routes 503. */
  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('GOOGLE_CLIENT_ID') &&
        this.config.get<string>('GOOGLE_CLIENT_SECRET'),
    );
  }

  private get clientId(): string {
    return this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
  }

  private get clientSecret(): string {
    return this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET');
  }

  private get redirectUri(): string {
    return this.config.get<string>(
      'GOOGLE_REDIRECT_URI',
      'http://localhost:4000/api/auth/google/callback',
    );
  }

  private stateKey(state: string): string {
    return `google:state:${createHash('sha256').update(state).digest('hex')}`;
  }

  /**
   * Builds the consent URL and records a single-use `state`.
   *
   * `state` lives in Redis rather than only round-tripping through the client,
   * so the callback can prove the request started here — the CSRF defence
   * RFC 6749 §10.12 requires.
   */
  async buildAuthorizationUrl(): Promise<{ url: string; state: string }> {
    const state = randomBytes(32).toString('base64url');

    await this.redis.client.set(this.stateKey(state), '1', 'EX', STATE_TTL_SECONDS);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      // No refresh token is wanted: this is sign-in, not ongoing API access on
      // the user's behalf, so there is nothing to refresh and nothing to store.
      access_type: 'online',
      prompt: 'select_account',
    });

    return { url: `${AUTH_ENDPOINT}?${params.toString()}`, state };
  }

  /** Consumes `state`; false if unknown, expired, or already used. */
  async consumeState(state: string): Promise<boolean> {
    if (!state) return false;
    // DEL returns how many keys it removed, so this is atomically single-use
    // even when two callbacks race.
    const removed = await this.redis.client.del(this.stateKey(state));
    return removed === 1;
  }

  /** Exchanges the authorization code and resolves the profile. */
  async exchangeCode(code: string): Promise<GoogleProfile> {
    const accessToken = await this.requestAccessToken(code);
    return this.fetchProfile(accessToken);
  }

  private async requestAccessToken(code: string): Promise<string> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });

    try {
      const response = await firstValueFrom(
        this.http.post(TOKEN_ENDPOINT, body.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
        }),
      );

      const token = response.data?.access_token;
      if (!token) {
        throw new UnauthorizedException('Google did not return an access token');
      }
      return token;
    } catch (error) {
      // Never echo the provider's body to the client: it can contain the
      // client_secret this request just sent.
      this.logger.error(
        `Google token exchange failed: ${(error as Error)?.message ?? 'unknown error'}`,
      );
      if (error instanceof UnauthorizedException) throw error;
      throw new InternalServerErrorException('Google authentication failed');
    }
  }

  private async fetchProfile(accessToken: string): Promise<GoogleProfile> {
    try {
      const response = await firstValueFrom(
        this.http.get(USERINFO_ENDPOINT, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10_000,
        }),
      );

      const data = response.data as Record<string, unknown>;

      if (!data?.sub || !data?.email) {
        throw new UnauthorizedException('Google returned an unusable profile');
      }

      return {
        subject: String(data.sub),
        email: String(data.email),
        // Google sends this as a boolean on some responses and the string
        // "true" on others; both mean the same thing and neither is trusted
        // by accident.
        emailVerified: data.email_verified === true || data.email_verified === 'true',
        name: data.name ? String(data.name) : undefined,
        picture: data.picture ? String(data.picture) : undefined,
      };
    } catch (error) {
      this.logger.error(
        `Google profile lookup failed: ${(error as Error)?.message ?? 'unknown error'}`,
      );
      if (error instanceof UnauthorizedException) throw error;
      throw new InternalServerErrorException('Google authentication failed');
    }
  }
}

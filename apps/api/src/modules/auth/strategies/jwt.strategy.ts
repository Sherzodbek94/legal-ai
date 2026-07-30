import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';
import type { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { ACCESS_TOKEN_COOKIE } from '../constants';
import type {
  AuthenticatedUser,
  JwtPayload,
} from '../interfaces/jwt-payload.interface';

/**
 * Reads the access token from the HTTPOnly cookie first, falling back to the
 * Authorization header for non-browser clients (service-to-service calls).
 */
function extractJwt(req: Request): string | null {
  const fromCookie = (req?.cookies as Record<string, string> | undefined)?.[
    ACCESS_TOKEN_COOKIE
  ];
  if (fromCookie) return fromCookie;
  return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      // Fail closed at boot rather than silently accepting a default secret.
      throw new Error('JWT_ACCESS_SECRET is not configured');
    }

    super({
      jwtFromRequest: extractJwt,
      ignoreExpiration: false,
      secretOrKey: secret,
      issuer: config.get<string>('JWT_ISSUER', 'legaltech-api'),
      audience: config.get<string>('JWT_AUDIENCE', 'legaltech-web'),
    } satisfies StrategyOptionsWithoutRequest);
  }

  /**
   * Validates the token against current state, not just its signature.
   *
   * This costs one or two indexed primary-key lookups per request, and that is
   * the price of locks and impersonation revocation meaning anything. A purely
   * stateless check would leave a suspended account working until its token
   * expired — up to fifteen minutes of continued access after an operator hit
   * "lock", which is exactly the window that matters when an account is being
   * abused.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload?.sub) {
      throw new UnauthorizedException('Malformed token');
    }

    const [user, company, impersonation] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, lockedAt: true, deletedAt: true },
      }),
      payload.companyId
        ? this.prisma.client.company.findUnique({
            where: { id: payload.companyId },
            select: { lockedAt: true, deletedAt: true },
          })
        : Promise.resolve(null),
      payload.impersonationId
        ? this.prisma.client.impersonationSession.findUnique({
            where: { id: payload.impersonationId },
            select: {
              id: true,
              jti: true,
              expiresAt: true,
              endedAt: true,
              revokedAt: true,
              impersonatorId: true,
            },
          })
        : Promise.resolve(null),
    ]);

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Account is no longer active');
    }

    // Deliberately the same message for a locked user and a locked company: the
    // person holding the token does not need to know which layer stopped them,
    // and the distinction is available to support in the audit log.
    if (user.lockedAt) {
      throw new UnauthorizedException('Account is suspended');
    }
    if (company?.deletedAt || company?.lockedAt) {
      throw new UnauthorizedException('Account is suspended');
    }

    if (payload.impersonationId) {
      return this.validateImpersonation(payload, impersonation);
    }

    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId,
      companyRole: payload.companyRole,
    };
  }

  /**
   * The impersonation row — not the token — is the authority.
   *
   * A token whose session has been revoked, ended, or expired is refused even
   * though its signature and `exp` are still valid. Without this, "stop
   * impersonating" would be a cosmetic button.
   */
  private validateImpersonation(
    payload: JwtPayload,
    session: {
      id: string;
      jti: string;
      expiresAt: Date;
      endedAt: Date | null;
      revokedAt: Date | null;
      impersonatorId: string;
    } | null,
  ): AuthenticatedUser {
    if (!session) {
      throw new UnauthorizedException('Impersonation session not found');
    }
    if (session.revokedAt || session.endedAt) {
      throw new UnauthorizedException('Impersonation session has ended');
    }
    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Impersonation session has expired');
    }

    // The session is bound to one token. A second token minted with the same
    // session id — or a replayed older one — does not match and is refused.
    if (!payload.jti || payload.jti !== session.jti) {
      throw new UnauthorizedException('Impersonation token is not recognised');
    }

    if (!payload.act?.sub || payload.act.sub !== session.impersonatorId) {
      throw new UnauthorizedException('Impersonation actor mismatch');
    }

    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId,
      companyRole: payload.companyRole,
      impersonation: {
        sessionId: session.id,
        impersonatorId: session.impersonatorId,
        impersonatorEmail: payload.act.email,
      },
    };
  }
}

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';
import type { Request } from 'express';
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
  constructor(config: ConfigService) {
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

  validate(payload: JwtPayload): AuthenticatedUser {
    if (!payload?.sub) {
      throw new UnauthorizedException('Malformed token');
    }

    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId,
      companyRole: payload.companyRole,
    };
  }
}

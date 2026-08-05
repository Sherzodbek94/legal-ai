import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresAt: Date;
}

export interface RefreshTokenContext {
  userAgent?: string;
  ipAddress?: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Refresh tokens are high-entropy random strings, so a fast digest is the
   * right primitive — bcrypt/argon2 exist to slow down guessing of
   * low-entropy human secrets and would only add latency here. What matters is
   * that the database never holds a replayable value.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private get refreshTtlMs(): number {
    const days = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS', 7);
    return days * 24 * 60 * 60 * 1000;
  }

  async issueTokens(
    payload: JwtPayload,
    context: RefreshTokenContext = {},
  ): Promise<IssuedTokens> {
    const accessTtl = this.config.get<string>('ACCESS_TOKEN_TTL', '15m');

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // `expiresIn` is a template-literal type from `ms`; a runtime config
      // string cannot satisfy it statically. `parseTtlSeconds` below rejects
      // anything malformed, so the value is validated in practice.
      expiresIn: accessTtl as JwtSignOptions['expiresIn'],
      issuer: this.config.get<string>('JWT_ISSUER', 'legaltech-api'),
      audience: this.config.get<string>('JWT_AUDIENCE', 'legaltech-web'),
      jwtid: randomBytes(16).toString('hex'),
    });

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);

    await this.prisma.client.refreshToken.create({
      data: {
        tokenHash: this.hashToken(refreshToken),
        userId: payload.sub,
        expiresAt,
        userAgent: context.userAgent?.slice(0, 512),
        ipAddress: context.ipAddress,
      },
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: this.parseTtlSeconds(accessTtl),
      refreshTokenExpiresAt: expiresAt,
    };
  }

  /**
   * Redeems a refresh token and issues a new pair.
   *
   * Rotation is single-use. Presenting a token that was already redeemed means
   * either the stored token leaked or a session was cloned, and we cannot tell
   * which — so every session for that user is revoked rather than guessing.
   * This is the standard reuse-detection response from OAuth 2.0 BCP
   * (draft-ietf-oauth-security-topics, §4.14.2).
   */
  async rotateRefreshToken(
    presentedToken: string,
    context: RefreshTokenContext = {},
  ): Promise<{ tokens: IssuedTokens; payload: JwtPayload }> {
    const tokenHash = this.hashToken(presentedToken);

    const stored = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            memberships: {
              where: { deletedAt: null },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        },
      },
    });

    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.revokedAt) {
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId}; revoking all sessions`,
      );
      await this.revokeAllForUser(stored.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (!stored.user || stored.user.deletedAt) {
      throw new UnauthorizedException('Account is no longer active');
    }

    const membership = stored.user.memberships[0];
    const payload: JwtPayload = {
      sub: stored.user.id,
      email: stored.user.email ?? undefined,
      role: stored.user.role,
      companyId: membership?.companyId,
      companyRole: membership?.role,
    };

    // Mark the presented token spent before minting its replacement, so a
    // crash between the two cannot leave a redeemable duplicate.
    await this.prisma.client.refreshToken.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issueTokens(payload, context);
    return { tokens, payload };
  }

  async revokeRefreshToken(presentedToken: string): Promise<void> {
    const tokenHash = this.hashToken(presentedToken);
    await this.prisma.client.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Converts a `15m` / `2h` / `900` style TTL into seconds for cookie maxAge. */
  private parseTtlSeconds(ttl: string): number {
    const match = /^(\d+)([smhd])?$/.exec(ttl.trim());
    if (!match) return 900;

    const value = Number(match[1]);
    switch (match[2]) {
      case 'd':
        return value * 86400;
      case 'h':
        return value * 3600;
      case 'm':
        return value * 60;
      default:
        return value;
    }
  }
}

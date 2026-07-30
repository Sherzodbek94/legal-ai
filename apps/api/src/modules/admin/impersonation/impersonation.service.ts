import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { AuditAction, Prisma, UserRole } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  IMPERSONATION_TTL_MS,
  canImpersonate,
  expiresAtFrom,
  remainingSeconds,
} from './impersonation-policy';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { JwtPayload } from '../../auth/interfaces/jwt-payload.interface';

export interface IssuedImpersonation {
  accessToken: string;
  expiresAt: Date;
  expiresInSeconds: number;
  sessionId: string;
  target: { id: string; email: string; companyId?: string };
}

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Mints a scoped, revocable, 15-minute token for acting as another user.
   *
   * Three properties make this safe enough to ship, and all three are
   * deliberate:
   *
   *   * **No refresh token.** A refreshable 15-minute token is not a
   *     15-minute token. The session simply ends and the operator starts a new,
   *     separately audited one.
   *   * **Bound to a database row.** The `jti` is stored, so revoking the row
   *     kills the token before its `exp` — otherwise "end session" would be
   *     decorative.
   *   * **`sub` stays the target.** Authorisation keeps working unchanged while
   *     the `act` claim records who is really driving, so the audit trail names
   *     the operator rather than the customer.
   */
  async start(
    targetUserId: string,
    reason: string,
    actor: AuthenticatedUser,
    context: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<IssuedImpersonation> {
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        email: true,
        role: true,
        deletedAt: true,
        lockedAt: true,
        memberships: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { companyId: true, role: true },
        },
      },
    });

    if (!target) {
      throw new NotFoundException('User not found');
    }

    const activeSession = await this.findActiveSessionFor(actor.id);

    const decision = canImpersonate(
      {
        id: actor.id,
        role: actor.role,
        isImpersonating: Boolean(actor.impersonation),
      },
      target,
      reason,
      Boolean(activeSession),
    );

    if (!decision.allowed) {
      this.logger.warn(
        `Impersonation refused for ${actor.id} -> ${targetUserId}: ${decision.reason}`,
      );
      throw new ForbiddenException({
        message: decision.message,
        reason: decision.reason,
      });
    }

    const membership = target.memberships[0];
    const startedAt = new Date();
    const expiresAt = expiresAtFrom(startedAt);
    const jti = randomBytes(16).toString('hex');

    const payload: JwtPayload = {
      sub: target.id,
      email: target.email,
      role: target.role,
      companyId: membership?.companyId,
      companyRole: membership?.role,
      jti,
      act: { sub: actor.id, email: actor.email },
    };

    // The session row is created first, and the token carries its id. Minting
    // the token first would leave a signed credential in existence for a
    // session that might fail to record — unauditable by construction.
    const session = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.impersonationSession.create({
        data: {
          impersonatorId: actor.id,
          targetUserId: target.id,
          targetCompanyId: membership?.companyId,
          reason: reason.trim().slice(0, 1000),
          jti,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent?.slice(0, 512),
          startedAt,
          expiresAt,
        },
      });

      await this.writeAudit(tx, {
        companyId: membership?.companyId,
        userId: actor.id,
        action: AuditAction.LOGIN,
        entityId: target.id,
        metadata: {
          event: 'IMPERSONATION_STARTED',
          sessionId: created.id,
          impersonatorId: actor.id,
          impersonatorEmail: actor.email,
          targetUserId: target.id,
          targetEmail: target.email,
          reason: reason.trim().slice(0, 1000),
          expiresAt: expiresAt.toISOString(),
          ipAddress: context.ipAddress ?? null,
        },
      });

      return created;
    });

    const accessToken = await this.jwt.signAsync(
      { ...payload, impersonationId: session.id },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: `${Math.floor(IMPERSONATION_TTL_MS / 1000)}s` as JwtSignOptions['expiresIn'],
        issuer: this.config.get<string>('JWT_ISSUER', 'legaltech-api'),
        audience: this.config.get<string>('JWT_AUDIENCE', 'legaltech-web'),
        jwtid: jti,
      },
    );

    this.logger.log(
      `Impersonation started: ${actor.email} as ${target.email} (session ${session.id}, expires ${expiresAt.toISOString()})`,
    );

    return {
      accessToken,
      expiresAt,
      expiresInSeconds: remainingSeconds(expiresAt, startedAt),
      sessionId: session.id,
      target: {
        id: target.id,
        email: target.email,
        companyId: membership?.companyId,
      },
    };
  }

  /**
   * Ends a session.
   *
   * Callable by the operator who started it or by any other platform
   * administrator — a session that only its own owner can stop is not
   * revocable in the case that matters, which is an operator gone rogue or
   * unavailable.
   */
  async end(sessionId: string, actor: AuthenticatedUser): Promise<void> {
    const session = await this.prisma.client.impersonationSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        impersonatorId: true,
        targetUserId: true,
        targetCompanyId: true,
        endedAt: true,
        revokedAt: true,
      },
    });

    if (!session) throw new NotFoundException('Session not found');

    const isOwner = session.impersonatorId === actor.id;
    const isPlatformAdmin = actor.role === UserRole.SUPER_ADMIN;

    if (!isOwner && !isPlatformAdmin) {
      throw new ForbiddenException('Not permitted to end this session');
    }

    if (session.endedAt || session.revokedAt) return;

    await this.prisma.client.$transaction(async (tx) => {
      await tx.impersonationSession.updateMany({
        where: { id: sessionId, endedAt: null, revokedAt: null },
        data: { endedAt: new Date() },
      });

      await this.writeAudit(tx, {
        companyId: session.targetCompanyId ?? undefined,
        userId: actor.id,
        action: AuditAction.LOGOUT,
        entityId: session.targetUserId,
        metadata: {
          event: 'IMPERSONATION_ENDED',
          sessionId,
          endedBy: actor.id,
          endedByOwner: isOwner,
        },
      });
    });
  }

  /** Kills every live session for an operator — the break-glass control. */
  async revokeAllFor(impersonatorId: string, actor: AuthenticatedUser): Promise<number> {
    const now = new Date();

    const { count } = await this.prisma.client.impersonationSession.updateMany({
      where: {
        impersonatorId,
        endedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });

    if (count > 0) {
      await this.prisma.client.auditLog.create({
        data: {
          userId: actor.id,
          action: AuditAction.UPDATE,
          entityType: 'ImpersonationSession',
          entityId: impersonatorId,
          metadata: {
            event: 'IMPERSONATION_SESSIONS_REVOKED',
            revokedCount: count,
            revokedBy: actor.id,
          },
        },
      });

      this.logger.warn(
        `Revoked ${count} impersonation session(s) for operator ${impersonatorId}`,
      );
    }

    return count;
  }

  /** Sessions still live right now, for the admin dashboard. */
  async listActive() {
    const now = new Date();

    return this.prisma.client.impersonationSession.findMany({
      where: { endedAt: null, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        reason: true,
        startedAt: true,
        expiresAt: true,
        ipAddress: true,
        impersonator: { select: { id: true, email: true, name: true } },
        targetUser: { select: { id: true, email: true, name: true } },
        targetCompanyId: true,
      },
    });
  }

  /** Full history, newest first — the record a reviewer actually reads. */
  async listHistory(take = 100) {
    return this.prisma.client.impersonationSession.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(take, 200),
      select: {
        id: true,
        reason: true,
        startedAt: true,
        expiresAt: true,
        endedAt: true,
        revokedAt: true,
        ipAddress: true,
        userAgent: true,
        impersonator: { select: { id: true, email: true } },
        targetUser: { select: { id: true, email: true } },
        targetCompanyId: true,
      },
    });
  }

  private findActiveSessionFor(impersonatorId: string) {
    return this.prisma.client.impersonationSession.findFirst({
      where: {
        impersonatorId,
        endedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    entry: {
      companyId?: string;
      userId: string;
      action: AuditAction;
      entityId: string;
      metadata: Prisma.InputJsonValue;
    },
  ) {
    return tx.auditLog.create({
      data: {
        companyId: entry.companyId ?? null,
        userId: entry.userId,
        action: entry.action,
        entityType: 'ImpersonationSession',
        entityId: entry.entityId,
        metadata: entry.metadata,
      },
    });
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, UserRole } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { TokenService } from '../../auth/services/token.service';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { ListQuery, LockDto } from '../dto/admin.dto';

/**
 * Account suspension.
 *
 * Locking is deliberately not deletion. The customer's data stays intact and
 * reappears the moment the lock lifts, which matters both because most locks are
 * temporary (a payment dispute, an investigation) and because destroying a law
 * firm's documents over a billing disagreement is not a proportionate response.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  async listUsers(query: ListQuery) {
    const take = Math.min(query.take ?? 50, 100);

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.locked === true ? { lockedAt: { not: null } } : {}),
      ...(query.locked === false ? { lockedAt: null } : {}),
    };

    const rows = await this.prisma.client.user.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        lastLoginAt: true,
        lockedAt: true,
        lockedReason: true,
        createdAt: true,
        memberships: {
          where: { deletedAt: null },
          take: 1,
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            company: { select: { id: true, name: true, lockedAt: true } },
          },
        },
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * Suspends a user and terminates their sessions.
   *
   * Revoking refresh tokens is what makes the lock immediate rather than
   * eventual: the access-token check in JwtStrategy stops the current token, and
   * clearing the refresh tokens stops a new one being minted from a session the
   * browser still holds.
   */
  async lockUser(
    userId: string,
    dto: LockDto,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, role: true, lockedAt: true },
    });

    if (!user) throw new NotFoundException('User not found');
    if (user.lockedAt) throw new ConflictException('User is already locked');

    if (user.id === actor.id) {
      throw new BadRequestException('You cannot lock your own account');
    }

    // Locking a peer administrator would let one operator disable the people who
    // could review their actions.
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException(
        'Platform administrators cannot be locked from this interface',
      );
    }

    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          lockedAt: new Date(),
          lockedReason: dto.reason.trim().slice(0, 1000),
          lockedById: actor.id,
        },
      });

      await this.writeAudit(tx, {
        userId: actor.id,
        action: AuditAction.UPDATE,
        entityType: 'User',
        entityId: userId,
        metadata: {
          event: 'USER_LOCKED',
          targetEmail: user.email,
          reason: dto.reason.trim().slice(0, 1000),
          lockedBy: actor.id,
        },
      });
    });

    await this.tokens.revokeAllForUser(userId);

    this.logger.warn(
      `User ${user.email} locked by ${actor.email}: ${dto.reason.slice(0, 200)}`,
    );
  }

  async unlockUser(userId: string, actor: AuthenticatedUser): Promise<void> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, lockedAt: true },
    });

    if (!user) throw new NotFoundException('User not found');
    if (!user.lockedAt) throw new ConflictException('User is not locked');

    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { lockedAt: null, lockedReason: null, lockedById: null },
      });

      await this.writeAudit(tx, {
        userId: actor.id,
        action: AuditAction.UPDATE,
        entityType: 'User',
        entityId: userId,
        metadata: {
          event: 'USER_UNLOCKED',
          targetEmail: user.email,
          unlockedBy: actor.id,
        },
      });
    });

    this.logger.log(`User ${user.email} unlocked by ${actor.email}`);
  }

  // ---------------------------------------------------------------------------
  // Companies
  // ---------------------------------------------------------------------------

  async listCompanies(query: ListQuery) {
    const take = Math.min(query.take ?? 50, 100);

    const where: Prisma.CompanyWhereInput = {
      deletedAt: null,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { slug: { contains: query.search, mode: 'insensitive' } },
              { stir: { contains: query.search } },
            ],
          }
        : {}),
      ...(query.locked === true ? { lockedAt: { not: null } } : {}),
      ...(query.locked === false ? { lockedAt: null } : {}),
    };

    const rows = await this.prisma.client.company.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        stir: true,
        lockedAt: true,
        lockedReason: true,
        createdAt: true,
        subscription: {
          select: { plan: true, status: true, currentPeriodEnd: true },
        },
        _count: { select: { members: true, generatedDocuments: true } },
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * Suspends a whole tenant.
   *
   * Every member's sessions are revoked, not just the owner's — a company lock
   * that leaves five attorneys still signed in has not suspended anything.
   */
  async lockCompany(
    companyId: string,
    dto: LockDto,
    actor: AuthenticatedUser,
  ): Promise<{ membersAffected: number }> {
    const company = await this.prisma.client.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: {
        id: true,
        name: true,
        lockedAt: true,
        members: {
          where: { deletedAt: null },
          select: { userId: true },
        },
      },
    });

    if (!company) throw new NotFoundException('Company not found');
    if (company.lockedAt) throw new ConflictException('Company is already locked');

    await this.prisma.client.$transaction(async (tx) => {
      await tx.company.update({
        where: { id: companyId },
        data: {
          lockedAt: new Date(),
          lockedReason: dto.reason.trim().slice(0, 1000),
          lockedById: actor.id,
        },
      });

      await this.writeAudit(tx, {
        companyId,
        userId: actor.id,
        action: AuditAction.UPDATE,
        entityType: 'Company',
        entityId: companyId,
        metadata: {
          event: 'COMPANY_LOCKED',
          companyName: company.name,
          reason: dto.reason.trim().slice(0, 1000),
          lockedBy: actor.id,
          membersAffected: company.members.length,
        },
      });
    });

    const userIds = company.members.map((member) => member.userId);
    if (userIds.length > 0) {
      await this.prisma.client.refreshToken.updateMany({
        where: { userId: { in: userIds }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    this.logger.warn(
      `Company ${company.name} locked by ${actor.email}, ${userIds.length} member session(s) revoked`,
    );

    return { membersAffected: userIds.length };
  }

  async unlockCompany(
    companyId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const company = await this.prisma.client.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: { id: true, name: true, lockedAt: true },
    });

    if (!company) throw new NotFoundException('Company not found');
    if (!company.lockedAt) throw new ConflictException('Company is not locked');

    await this.prisma.client.$transaction(async (tx) => {
      await tx.company.update({
        where: { id: companyId },
        data: { lockedAt: null, lockedReason: null, lockedById: null },
      });

      await this.writeAudit(tx, {
        companyId,
        userId: actor.id,
        action: AuditAction.UPDATE,
        entityType: 'Company',
        entityId: companyId,
        metadata: {
          event: 'COMPANY_UNLOCKED',
          companyName: company.name,
          unlockedBy: actor.id,
        },
      });
    });

    this.logger.log(`Company ${company.name} unlocked by ${actor.email}`);
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    entry: {
      companyId?: string;
      userId: string;
      action: AuditAction;
      entityType: string;
      entityId: string;
      metadata: Prisma.InputJsonValue;
    },
  ) {
    return tx.auditLog.create({
      data: {
        companyId: entry.companyId ?? null,
        userId: entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata,
      },
    });
  }
}

import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuditQuery } from '../dto/admin.dto';

@Injectable()
export class AuditViewerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the audit trail.
   *
   * Keyset pagination on `(createdAt, id)`. The table is append-only and grows
   * without bound, so offset paging would degrade exactly as the log becomes
   * worth reading — and a new entry arriving mid-scroll would shift every
   * subsequent page.
   */
  async list(query: AuditQuery) {
    const take = Math.min(query.take ?? 50, 200);

    const where: Prisma.AuditLogWhereInput = {
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.action ? { action: query.action as AuditAction } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lt: query.to } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.client.auditLog.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true } },
        company: { select: { id: true, name: true } },
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /** Distinct entity types present, so the UI filter is not a free-text guess. */
  async getFilterOptions() {
    const entityTypes = await this.prisma.client.auditLog.groupBy({
      by: ['entityType'],
      _count: { _all: true },
      orderBy: { _count: { entityType: 'desc' } },
      take: 50,
    });

    return {
      actions: Object.values(AuditAction),
      entityTypes: entityTypes.map((row) => ({
        entityType: row.entityType,
        count: row._count._all,
      })),
    };
  }

  /**
   * Security-relevant events only.
   *
   * The full trail is dominated by routine CRUD, which buries the handful of
   * entries a reviewer is actually looking for. This is the view for "what
   * happened to accounts and access", not "what happened".
   */
  async listSecurityEvents(take = 100) {
    const rows = await this.prisma.client.auditLog.findMany({
      where: {
        entityType: {
          in: ['User', 'Company', 'ImpersonationSession', 'Subscription'],
        },
        action: { in: [AuditAction.LOGIN, AuditAction.LOGOUT, AuditAction.UPDATE] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(take, 200),
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
        user: { select: { id: true, email: true } },
        company: { select: { id: true, name: true } },
      },
    });

    // `event` in metadata is what distinguishes a lock from an ordinary update;
    // filtering on it in SQL would need a JSON path predicate for little gain at
    // this size.
    const interesting = new Set([
      'USER_LOCKED',
      'USER_UNLOCKED',
      'COMPANY_LOCKED',
      'COMPANY_UNLOCKED',
      'IMPERSONATION_STARTED',
      'IMPERSONATION_ENDED',
      'IMPERSONATION_SESSIONS_REVOKED',
      'PLAN_CHANGED',
      'SUBSCRIPTION_CANCELED',
    ]);

    return rows.filter((row) => {
      const event = (row.metadata as Record<string, unknown> | null)?.event;
      return typeof event === 'string' && interesting.has(event);
    });
  }
}

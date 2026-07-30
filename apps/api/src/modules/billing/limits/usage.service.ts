import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UsageMetric, type Subscription } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveLimits } from '../plans/plan-catalog';
import { resolveBillingPeriod, type BillingPeriod } from './billing-period';
import {
  effectivePlan,
  evaluateQuota,
  evaluateSubscriptionAccess,
  isStockMetric,
  type QuotaDecision,
} from './quota-policy';

/** A consumed unit that can be handed back if the work it paid for failed. */
export interface QuotaReservation {
  companyId: string;
  metric: UsageMetric;
  periodStart: Date;
  amount: number;
}

export interface UsageSummary {
  metric: UsageMetric;
  used: number;
  limit: number | null;
  remaining: number | null;
  periodStart: Date;
  periodEnd: Date;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getSubscription(companyId: string): Promise<Subscription | null> {
    return this.prisma.client.subscription.findFirst({
      where: { companyId, deletedAt: null },
    });
  }

  /**
   * Reserves quota and reports whether it fitted — in one atomic step.
   *
   * The obvious implementation (read the counter, compare, then increment) has
   * a race that shows up exactly when it is most expensive: two generation
   * requests arriving together on a customer's last remaining document both
   * read 99 of 100 and both proceed. Postgres settles it instead — the
   * `ON CONFLICT DO UPDATE ... RETURNING` gives each caller a distinct
   * post-increment value under the row lock, so one gets 100 and the other 101.
   *
   * A caller that is refused has already been counted, so the increment is
   * rolled back before returning. That rollback is safe to lose (it would only
   * over-count a refused request), which is why it is not worth a transaction.
   */
  async reserve(
    companyId: string,
    metric: UsageMetric,
    amount = 1,
  ): Promise<QuotaDecision & { reservation?: QuotaReservation }> {
    const subscription = await this.getSubscription(companyId);

    const access = evaluateSubscriptionAccess(subscription, new Date());
    if (!access.allowed) {
      const limits = resolveLimits(
        effectivePlan(subscription),
        subscription?.limitOverrides,
      );
      return { ...access, limit: limits[metric], used: 0, remaining: 0 };
    }

    const limits = resolveLimits(
      effectivePlan(subscription),
      subscription?.limitOverrides,
    );
    const limit = limits[metric];
    const period = resolveBillingPeriod(subscription, new Date());

    // Unmetered: skip the write entirely rather than maintaining a counter
    // nobody reads.
    if (limit === null) {
      return { allowed: true, limit: null, used: 0, remaining: null };
    }

    // A standing quantity is counted from the live table, so that deleting the
    // thing frees the slot.
    if (isStockMetric(metric)) {
      const used = await this.countStock(companyId, metric);
      return evaluateQuota(limit, used, amount);
    }

    const used = await this.increment(companyId, metric, period, amount);
    const decision = evaluateQuota(limit, used - amount, amount);

    if (!decision.allowed) {
      await this.increment(companyId, metric, period, -amount).catch((error) => {
        this.logger.error(
          `Failed to release refused quota for company ${companyId}/${metric}: ${
            (error as Error)?.message ?? 'unknown error'
          }`,
        );
      });
      return decision;
    }

    return {
      ...decision,
      reservation: { companyId, metric, periodStart: period.start, amount },
    };
  }

  /**
   * Hands a reservation back.
   *
   * Called when the work the quota was reserved for failed — an AI provider
   * outage should not cost a customer a document from their monthly allowance.
   */
  async release(reservation: QuotaReservation): Promise<void> {
    try {
      await this.prisma.client.$executeRaw`
        UPDATE "usage_counters"
           SET "used" = GREATEST(0, "used" - ${reservation.amount}),
               "updatedAt" = NOW()
         WHERE "companyId" = ${reservation.companyId}
           AND "metric" = ${reservation.metric}::"UsageMetric"
           AND "periodStart" = ${reservation.periodStart}
      `;
    } catch (error) {
      // Best effort. Failing to refund must not turn a already-failed request
      // into a second error the caller has to handle.
      this.logger.error(
        `Failed to release quota for company ${reservation.companyId}/${reservation.metric}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
    }
  }

  /** Current usage across every metric, for the billing dashboard. */
  async getUsageSummary(companyId: string): Promise<UsageSummary[]> {
    const subscription = await this.getSubscription(companyId);
    const limits = resolveLimits(
      effectivePlan(subscription),
      subscription?.limitOverrides,
    );
    const period = resolveBillingPeriod(subscription, new Date());

    const counters = await this.prisma.client.usageCounter.findMany({
      where: { companyId, periodStart: period.start },
    });
    const usedByMetric = new Map(counters.map((row) => [row.metric, row.used]));

    const summaries: UsageSummary[] = [];

    for (const metric of Object.values(UsageMetric)) {
      const used = isStockMetric(metric)
        ? await this.countStock(companyId, metric)
        : (usedByMetric.get(metric) ?? 0);

      const limit = limits[metric];

      summaries.push({
        metric,
        used,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - used),
        periodStart: period.start,
        periodEnd: period.end,
      });
    }

    return summaries;
  }

  /**
   * Drops counters for windows that have ended.
   *
   * Usage history beyond the current period is not needed for enforcement, and
   * the table would otherwise grow by one row per company per metric per month
   * forever. Anything worth keeping for analytics is already in the audit log.
   */
  async pruneExpiredCounters(before: Date): Promise<number> {
    const { count } = await this.prisma.client.usageCounter.deleteMany({
      where: { periodEnd: { lt: before } },
    });
    return count;
  }

  /** Live count for metrics that measure a standing quantity. */
  private async countStock(
    companyId: string,
    metric: UsageMetric,
  ): Promise<number> {
    switch (metric) {
      case UsageMetric.TEMPLATES:
        return this.prisma.client.documentTemplate.count({
          where: { companyId, deletedAt: null },
        });
      case UsageMetric.SEATS:
        return this.prisma.client.companyMember.count({
          where: { companyId, deletedAt: null },
        });
      default:
        return 0;
    }
  }

  /**
   * Atomically adds `amount` and returns the resulting total.
   *
   * Raw SQL rather than Prisma's `upsert`: upsert compiles to a read followed
   * by a conditional write, which reintroduces exactly the race this exists to
   * close. `ON CONFLICT DO UPDATE` is a single statement holding the row lock.
   */
  private async increment(
    companyId: string,
    metric: UsageMetric,
    period: BillingPeriod,
    amount: number,
  ): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ used: number }[]>`
      INSERT INTO "usage_counters"
        ("id", "companyId", "metric", "periodStart", "periodEnd", "used", "createdAt", "updatedAt")
      VALUES
        (${createId()}, ${companyId}, ${metric}::"UsageMetric", ${period.start}, ${period.end},
         GREATEST(0, ${amount}), NOW(), NOW())
      ON CONFLICT ("companyId", "metric", "periodStart")
      DO UPDATE SET
        "used" = GREATEST(0, "usage_counters"."used" + ${amount}),
        "updatedAt" = NOW()
      RETURNING "used"
    `;

    return rows[0]?.used ?? 0;
  }
}

/**
 * Ids are generated here rather than by the database because the column is a
 * plain TEXT primary key that Prisma normally fills client-side — the raw INSERT
 * above bypasses that.
 */
function createId(): string {
  // Matches the shape of Prisma's cuid() closely enough to be indistinguishable
  // in use; uniqueness comes from the random suffix and the timestamp.
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12);
  return `c${timestamp}${random}`;
}

export { Prisma };

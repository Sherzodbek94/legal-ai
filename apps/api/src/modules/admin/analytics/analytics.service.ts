import { Injectable } from '@nestjs/common';
import {
  GeneratedDocumentStatus,
  PaymentStatus,
  SubscriptionStatus,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { getPlan } from '../../billing/plans/plan-catalog';
import { calendarMonth } from '../../billing/limits/billing-period';
import {
  computeMrrMovement,
  customerChurnRate,
  estimatedLtvCents,
  formatMinorUnits,
  revenueChurnRate,
  summarizeRevenue,
  type RevenueSubscription,
} from './revenue-math';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Current recurring revenue.
   *
   * Discounts are read from live coupon redemptions rather than from the plan
   * price alone: a customer on a permanent 50%-off coupon contributes half the
   * list price, and counting the full amount overstates MRR for exactly the
   * cohort a promotion just created.
   */
  async getRevenueSnapshot() {
    const subscriptions = await this.prisma.client.subscription.findMany({
      where: { deletedAt: null },
      select: {
        companyId: true,
        plan: true,
        status: true,
        redemptions: {
          where: {
            OR: [{ periodsRemaining: null }, { periodsRemaining: { gt: 0 } }],
          },
          select: { discountCents: true },
          orderBy: { redeemedAt: 'desc' },
          take: 1,
        },
      },
    });

    const revenue: RevenueSubscription[] = subscriptions.map((subscription) => ({
      plan: subscription.plan,
      status: subscription.status,
      monthlyPriceCents: getPlan(subscription.plan).monthlyPriceCents,
      discountCents: subscription.redemptions[0]?.discountCents ?? 0,
    }));

    const snapshot = summarizeRevenue(revenue);

    return {
      ...snapshot,
      mrrUsd: formatMinorUnits(snapshot.mrrCents),
      arrUsd: formatMinorUnits(snapshot.arrCents),
      arpaUsd: formatMinorUnits(snapshot.arpaCents),
    };
  }

  /**
   * Month-over-month movement, decomposed.
   *
   * "Previous" MRR is reconstructed from successful charges in the prior month
   * rather than from a stored snapshot. That is an approximation and worth
   * naming: it attributes revenue to whoever actually paid, so a customer who
   * signed up mid-month appears at their charged amount rather than a prorated
   * one. A nightly MRR snapshot table would be exact, and is the right upgrade
   * once this number starts driving decisions.
   */
  async getMrrMovement(now = new Date()) {
    const thisMonth = calendarMonth(now);
    const lastMonth = calendarMonth(new Date(thisMonth.start.getTime() - 1));

    const [previousCharges, current] = await Promise.all([
      this.prisma.client.paymentTransaction.groupBy({
        by: ['companyId'],
        where: {
          status: PaymentStatus.SUCCEEDED,
          processedAt: { gte: lastMonth.start, lt: lastMonth.end },
        },
        _sum: { amountCents: true, discountCents: true },
      }),
      this.prisma.client.subscription.findMany({
        where: {
          deletedAt: null,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
        },
        select: {
          companyId: true,
          plan: true,
          status: true,
          redemptions: {
            where: {
              OR: [{ periodsRemaining: null }, { periodsRemaining: { gt: 0 } }],
            },
            select: { discountCents: true },
            orderBy: { redeemedAt: 'desc' },
            take: 1,
          },
        },
      }),
    ]);

    const previousMap = new Map(
      previousCharges.map((row) => [
        row.companyId,
        Math.max(
          0,
          (row._sum.amountCents ?? 0) - (row._sum.discountCents ?? 0),
        ),
      ]),
    );

    const currentMap = new Map(
      current.map((subscription) => [
        subscription.companyId,
        Math.max(
          0,
          getPlan(subscription.plan).monthlyPriceCents -
            (subscription.redemptions[0]?.discountCents ?? 0),
        ),
      ]),
    );

    const movement = computeMrrMovement(previousMap, currentMap);

    const openingMrr = [...previousMap.values()].reduce((a, b) => a + b, 0);
    const openingCustomers = [...previousMap.values()].filter((v) => v > 0).length;
    const churnedCustomers = [...previousMap.entries()].filter(
      ([companyId, mrr]) => mrr > 0 && !currentMap.has(companyId),
    ).length;

    const churn = revenueChurnRate(openingMrr, movement.churnedMrrCents);

    return {
      period: { from: thisMonth.start, to: thisMonth.end },
      ...movement,
      openingMrrCents: openingMrr,
      revenueChurnRate: churn,
      customerChurnRate: customerChurnRate(openingCustomers, churnedCustomers),
      estimatedLtvCents: estimatedLtvCents(
        openingCustomers === 0 ? 0 : Math.round(openingMrr / openingCustomers),
        churn,
      ),
    };
  }

  /** Platform-wide counts for the dashboard header. */
  async getPlatformStats() {
    const [
      companies,
      lockedCompanies,
      users,
      lockedUsers,
      documents,
      completedDocuments,
      trials,
      pastDue,
    ] = await Promise.all([
      this.prisma.client.company.count({ where: { deletedAt: null } }),
      this.prisma.client.company.count({
        where: { deletedAt: null, lockedAt: { not: null } },
      }),
      this.prisma.client.user.count({ where: { deletedAt: null } }),
      this.prisma.client.user.count({
        where: { deletedAt: null, lockedAt: { not: null } },
      }),
      this.prisma.client.generatedDocument.count({ where: { deletedAt: null } }),
      this.prisma.client.generatedDocument.count({
        where: { deletedAt: null, status: GeneratedDocumentStatus.COMPLETED },
      }),
      this.prisma.client.subscription.count({
        where: { deletedAt: null, status: SubscriptionStatus.TRIALING },
      }),
      this.prisma.client.subscription.count({
        where: { deletedAt: null, status: SubscriptionStatus.PAST_DUE },
      }),
    ]);

    return {
      companies: { total: companies, locked: lockedCompanies },
      users: { total: users, locked: lockedUsers },
      documents: { total: documents, completed: completedDocuments },
      subscriptions: { trialing: trials, pastDue },
    };
  }

  /** Everything the admin overview renders, in one round trip. */
  async getDashboard() {
    const [revenue, movement, stats] = await Promise.all([
      this.getRevenueSnapshot(),
      this.getMrrMovement(),
      this.getPlatformStats(),
    ]);

    return { revenue, movement, stats };
  }
}

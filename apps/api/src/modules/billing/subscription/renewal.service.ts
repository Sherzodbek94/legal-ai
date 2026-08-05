import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  CompanyMemberRole,
  PaymentStatus,
  Prisma,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { CouponService } from '../coupons/coupon.service';
import { UsageService } from '../limits/usage.service';
import { getPlan } from '../plans/plan-catalog';
import { addMonthsUtc } from '../limits/billing-period';
import { PaymentOrderService } from '../../payment/orders/payment-order.service';
import { NotificationService } from '../../notification/notification.service';
import { formatMinorUnits } from '../../admin/analytics/revenue-math';

export interface RenewalOutcome {
  examined: number;
  renewed: number;
  failed: number;
  downgraded: number;
}

/**
 * Scheduled subscription lifecycle work.
 *
 * Every handler here is written to be safe to run concurrently on more than one
 * instance. That is not hypothetical caution: the API runs multiple replicas
 * (see infra/k8s), every replica starts the same schedulers, and a renewal job
 * without a guard bills every customer once per replica.
 *
 * The guard used throughout is a conditional `updateMany` whose WHERE clause
 * includes the state being transitioned away from. Postgres serialises the
 * matching rows, so exactly one replica's update matches and the rest affect
 * zero rows and do nothing.
 */
@Injectable()
export class RenewalService {
  private readonly logger = new Logger(RenewalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly coupons: CouponService,
    private readonly usage: UsageService,
    private readonly config: ConfigService,
    private readonly orders: PaymentOrderService,
    private readonly notifications: NotificationService,
  ) {}

  private get graceDays(): number {
    return this.config.get<number>('BILLING_GRACE_PERIOD_DAYS', 7);
  }

  private get webAppUrl(): string {
    return this.config.get<string>('WEB_APP_URL', 'http://localhost:3000').replace(/\/+$/, '');
  }

  private get maxRenewalAttempts(): number {
    return this.config.get<number>('BILLING_MAX_RENEWAL_ATTEMPTS', 4);
  }

  /** How many subscriptions one pass will handle, to bound a single run. */
  private get batchSize(): number {
    return this.config.get<number>('BILLING_RENEWAL_BATCH_SIZE', 200);
  }

  // ---------------------------------------------------------------------------
  // Renewal
  // ---------------------------------------------------------------------------

  /**
   * Charges subscriptions whose period has ended.
   *
   * Hourly rather than daily: a daily job means a customer whose period ends at
   * 00:05 waits almost a full day for service to resume after paying, and it
   * concentrates the entire book's billing into one spike.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'billing:renew' })
  async renewDueSubscriptions(now = new Date()): Promise<RenewalOutcome> {
    const due = await this.prisma.client.subscription.findMany({
      where: {
        deletedAt: null,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
        plan: { not: SubscriptionPlan.FREE },
        currentPeriodEnd: { lte: now },
      },
      take: this.batchSize,
      orderBy: { currentPeriodEnd: 'asc' },
      select: {
        id: true,
        companyId: true,
        plan: true,
        status: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        renewalAttempts: true,
      },
    });

    const outcome: RenewalOutcome = {
      examined: due.length,
      renewed: 0,
      failed: 0,
      downgraded: 0,
    };

    for (const subscription of due) {
      try {
        if (subscription.cancelAtPeriodEnd) {
          if (await this.expireCanceled(subscription.id, subscription.currentPeriodEnd)) {
            outcome.downgraded++;
          }
          continue;
        }

        const renewed = await this.renewOne(subscription, now);
        if (renewed) outcome.renewed++;
        else outcome.failed++;
      } catch (error) {
        outcome.failed++;
        this.logger.error(
          `Renewal crashed for subscription ${subscription.id}: ${
            (error as Error)?.message ?? 'unknown error'
          }`,
        );
      }
    }

    if (outcome.examined > 0) {
      this.logger.log(
        `Renewal pass: ${outcome.renewed} renewed, ${outcome.failed} failed, ${outcome.downgraded} downgraded of ${outcome.examined} due`,
      );
    }

    return outcome;
  }

  /**
   * Renews one subscription: settle, advance the period, roll the usage window.
   *
   * All three in one transaction. A settlement without a period advance bills
   * the customer again on the next pass; a period advance without one gives the
   * month away. Either half alone is a bug that costs real money.
   *
   * "Settle" is deliberately not "charge". None of the four payment gateways
   * this product integrates supports a merchant-initiated debit the way a
   * Stripe subscription does — every one of them requires the customer to be
   * present in a checkout flow. So a due renewal cannot be charged; it can only
   * be turned into a payable order and the customer asked to complete it. A
   * balance of zero (Free, or fully discounted) is the one case that still
   * settles immediately, because there is nothing to collect.
   */
  private async renewOne(
    subscription: {
      id: string;
      companyId: string;
      plan: SubscriptionPlan;
      currentPeriodEnd: Date | null;
      renewalAttempts: number;
    },
    now: Date,
  ): Promise<boolean> {
    const definition = getPlan(subscription.plan);
    const periodStart = subscription.currentPeriodEnd ?? now;
    const periodEnd = addMonthsUtc(periodStart, 1);

    const result = await this.prisma.client.$transaction(async (tx) => {
      // Claim this renewal. If another replica got here first the period has
      // already moved past `periodStart` and this matches zero rows.
      const claim = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          currentPeriodEnd: subscription.currentPeriodEnd,
        },
        data: { renewalAttempts: { increment: 1 } },
      });

      if (claim.count === 0) {
        this.logger.debug(
          `Subscription ${subscription.id} already renewed by another worker`,
        );
        return { renewed: false, orderDue: null };
      }

      const gross = definition.monthlyPriceCents;
      const { discountCents, couponCode } = await this.coupons.consumeForRenewal(
        tx,
        subscription.companyId,
        gross,
      );

      const net = Math.max(0, gross - discountCents);

      if (net === 0) {
        await tx.paymentTransaction.create({
          data: {
            companyId: subscription.companyId,
            subscriptionId: subscription.id,
            amountCents: gross,
            discountCents,
            couponCode,
            currency: definition.currency,
            status: PaymentStatus.SUCCEEDED,
            description: `${definition.name} renewal`,
            processedAt: now,
          },
        });

        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            graceEndsAt: null,
            renewalAttempts: 0,
            lastRenewalError: null,
          },
        });

        return { renewed: true, orderDue: null };
      }

      const attempts = subscription.renewalAttempts + 1;
      const exhausted = attempts >= this.maxRenewalAttempts;
      // Same instant as the grace period this same write sets below — the
      // order should stop being payable exactly when service does.
      const graceEndsAt = new Date(now.getTime() + this.graceDays * 86_400_000);

      const order = exhausted
        ? null
        : await this.orders.createSystemOrder(tx, {
            companyId: subscription.companyId,
            subscriptionId: subscription.id,
            plan: subscription.plan,
            amountCents: net,
            currency: definition.currency,
            description: `${definition.name} renewal`,
            expiresAt: graceEndsAt,
          });

      await tx.paymentTransaction.create({
        data: {
          companyId: subscription.companyId,
          subscriptionId: subscription.id,
          orderId: order?.id,
          amountCents: gross,
          discountCents,
          couponCode,
          currency: definition.currency,
          status: PaymentStatus.PENDING,
          description: `${definition.name} renewal`,
          failureReason: exhausted
            ? 'Renewal attempts exhausted without payment'
            : null,
        },
      });

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: exhausted
            ? SubscriptionStatus.UNPAID
            : SubscriptionStatus.PAST_DUE,
          // Grace starts at the first failure and is not extended by retries;
          // otherwise a permanently failing card buys unlimited free service.
          graceEndsAt: exhausted ? null : graceEndsAt,
          lastRenewalError: exhausted
            ? 'Renewal attempts exhausted without payment'
            : 'Awaiting payment — a payment link was sent to the account owner(s)',
          // Period still advances so the customer is not re-billed for the
          // same month on every pass.
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });

      return {
        renewed: false,
        orderDue: order && { id: order.id, amountCents: net, currency: definition.currency },
      };
    });

    if (result.orderDue) {
      // Outside the transaction and independently guarded: a stalled email
      // provider must not roll back a subscription state change that already
      // committed correctly, any more than a failed search index does in
      // OcrService.
      await this.notifyPaymentDue(
        subscription.companyId,
        result.orderDue,
        definition.name,
      ).catch((error) => {
        this.logger.error(
          `Could not notify company ${subscription.companyId} of renewal order ${result.orderDue?.id}: ${
            (error as Error)?.message ?? 'unknown error'
          }`,
        );
      });
    }

    return result.renewed;
  }

  /** Emails (and otherwise notifies) every owner that a renewal is payable. */
  private async notifyPaymentDue(
    companyId: string,
    order: { id: string; amountCents: number; currency: string },
    planName: string,
  ): Promise<void> {
    const owners = await this.prisma.client.companyMember.findMany({
      where: { companyId, role: CompanyMemberRole.OWNER, deletedAt: null },
      select: { userId: true },
    });

    if (owners.length === 0) {
      this.logger.warn(
        `No owner to notify for company ${companyId}'s renewal order ${order.id}`,
      );
      return;
    }

    const amount = `${formatMinorUnits(order.amountCents)} ${order.currency.toUpperCase()}`;
    const link = `${this.webAppUrl}/billing`;

    await this.notifications.dispatchMany(
      owners.map((owner) => ({
        event: 'billing.renewal_payment_due',
        userId: owner.userId,
        companyId,
        title: 'Your subscription renewal is ready to pay',
        body: `${amount} is due to continue your ${planName} plan. Pay before the grace period ends, at ${link}`,
        data: { orderId: order.id, amountCents: order.amountCents, currency: order.currency, link },
        // One notification per order, not per cron pass — the order id is
        // stable for as long as it is unpaid, where a timestamp would not be.
        dedupeKey: `renewal-payment-due:${order.id}`,
      })),
    );
  }

  // ---------------------------------------------------------------------------
  // Trials, grace periods, and cleanup
  // ---------------------------------------------------------------------------

  /** Converts trials that have run out into an active paid period. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'billing:end-trials' })
  async endExpiredTrials(now = new Date()): Promise<number> {
    const { count } = await this.prisma.client.subscription.updateMany({
      where: {
        deletedAt: null,
        status: SubscriptionStatus.TRIALING,
        trialEndsAt: { lte: now },
      },
      // Guarded by `status`: a concurrent run matches zero rows on the second
      // pass because the status has already moved.
      data: {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: now,
        currentPeriodEnd: addMonthsUtc(now, 1),
      },
    });

    if (count > 0) this.logger.log(`Converted ${count} expired trial(s)`);
    return count;
  }

  /**
   * Cuts off subscriptions whose grace period has run out.
   *
   * Drops them to Free rather than deleting anything: the customer's documents,
   * templates, and history stay intact and reappear the moment they pay. Data
   * loss as a collections tactic is not one.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'billing:expire-grace' })
  async expireGracePeriods(now = new Date()): Promise<number> {
    const { count } = await this.prisma.client.subscription.updateMany({
      where: {
        deletedAt: null,
        status: SubscriptionStatus.PAST_DUE,
        graceEndsAt: { lte: now },
      },
      data: {
        status: SubscriptionStatus.UNPAID,
        plan: SubscriptionPlan.FREE,
        graceEndsAt: null,
      },
    });

    if (count > 0) {
      this.logger.warn(`Downgraded ${count} unpaid subscription(s) to Free`);
    }
    return count;
  }

  /** Ends subscriptions that were cancelled and have reached their period end. */
  private async expireCanceled(
    subscriptionId: string,
    periodEnd: Date | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.client.subscription.updateMany({
      where: {
        id: subscriptionId,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: periodEnd,
      },
      data: {
        status: SubscriptionStatus.CANCELED,
        plan: SubscriptionPlan.FREE,
        cancelAtPeriodEnd: false,
      },
    });
    return count > 0;
  }

  /**
   * Drops usage counters for windows that closed long ago.
   *
   * Daily and off-peak: it is pure housekeeping and there is no reason for it
   * to compete with customer traffic.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'billing:prune-usage' })
  async pruneUsageCounters(now = new Date()): Promise<number> {
    const retentionDays = this.config.get<number>(
      'BILLING_USAGE_RETENTION_DAYS',
      90,
    );
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    const pruned = await this.usage.pruneExpiredCounters(cutoff);
    if (pruned > 0) this.logger.log(`Pruned ${pruned} usage counter(s)`);
    return pruned;
  }
}

export { Prisma };

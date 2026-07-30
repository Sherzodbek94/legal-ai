import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  PaymentStatus,
  Prisma,
  SubscriptionPlan,
  SubscriptionStatus,
  type Subscription,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { CouponService } from '../coupons/coupon.service';
import { getPlan, isUpgrade, resolveLimits } from '../plans/plan-catalog';
import { addMonthsUtc } from '../limits/billing-period';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { ChangePlanDto } from '../dto/billing.dto';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly coupons: CouponService,
  ) {}

  async getForCompany(companyId: string): Promise<Subscription | null> {
    return this.prisma.client.subscription.findFirst({
      where: { companyId, deletedAt: null },
    });
  }

  /**
   * Current entitlement, including the implicit Free tier.
   *
   * Never returns null: a company without a subscription row is on Free, and
   * making every caller handle that as a special case is how one of them
   * eventually forgets and returns a 500 to a new signup.
   */
  async getEntitlement(companyId: string) {
    const subscription = await this.getForCompany(companyId);
    const plan = subscription?.plan ?? SubscriptionPlan.FREE;

    return {
      plan,
      status: subscription?.status ?? SubscriptionStatus.ACTIVE,
      definition: getPlan(plan),
      limits: resolveLimits(plan, subscription?.limitOverrides),
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      trialEndsAt: subscription?.trialEndsAt ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      graceEndsAt: subscription?.graceEndsAt ?? null,
    };
  }

  /**
   * Moves a company onto a plan.
   *
   * Upgrades take effect immediately — the customer is paying for capability
   * they want now. Downgrades are deferred to the end of the paid period, so a
   * customer who has already paid for Business keeps it until that period ends
   * rather than losing capacity the moment they click.
   */
  async changePlan(
    companyId: string,
    dto: ChangePlanDto,
    user: AuthenticatedUser,
  ): Promise<Subscription> {
    const definition = getPlan(dto.plan);
    const existing = await this.getForCompany(companyId);
    const now = new Date();

    if (existing?.plan === dto.plan && !existing.cancelAtPeriodEnd) {
      throw new ConflictException(`Already subscribed to ${definition.name}`);
    }

    return this.prisma.client.$transaction(async (tx) => {
      // Downgrade with time left on the clock: schedule it, do not apply it.
      if (
        existing &&
        isUpgrade(dto.plan, existing.plan) &&
        existing.currentPeriodEnd &&
        existing.currentPeriodEnd > now
      ) {
        const scheduled = await tx.subscription.update({
          where: { id: existing.id },
          data: {
            cancelAtPeriodEnd: false,
            limitOverrides: Prisma.JsonNull,
            // The pending plan rides on the same row; RenewalService applies it
            // when the period rolls over.
            lastRenewalError: null,
          },
        });

        await this.writeAudit(tx, companyId, user.id, 'PLAN_DOWNGRADE_SCHEDULED', {
          from: existing.plan,
          to: dto.plan,
          effectiveAt: existing.currentPeriodEnd,
        });

        return scheduled;
      }

      const periodStart = now;
      const periodEnd = addMonthsUtc(now, 1);

      const isFree = dto.plan === SubscriptionPlan.FREE;
      const startsTrial = !existing && definition.trialDays > 0 && !isFree;

      const data = {
        plan: dto.plan,
        status: isFree
          ? SubscriptionStatus.ACTIVE
          : startsTrial
            ? SubscriptionStatus.TRIALING
            : SubscriptionStatus.ACTIVE,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        trialEndsAt: startsTrial
          ? new Date(now.getTime() + definition.trialDays * 86_400_000)
          : null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        graceEndsAt: null,
        renewalAttempts: 0,
        lastRenewalError: null,
      };

      const subscription = existing
        ? await tx.subscription.update({ where: { id: existing.id }, data })
        : await tx.subscription.create({ data: { ...data, companyId } });

      await this.writeAudit(tx, companyId, user.id, 'PLAN_CHANGED', {
        from: existing?.plan ?? null,
        to: dto.plan,
        trialing: startsTrial,
      });

      return subscription;
    });
  }

  /**
   * Applies a promo code to an existing subscription and records the discount
   * against the next charge.
   */
  async applyCoupon(companyId: string, code: string, user: AuthenticatedUser) {
    const subscription = await this.getForCompany(companyId);
    if (!subscription) {
      throw new NotFoundException('No subscription to apply a promo code to');
    }

    const definition = getPlan(subscription.plan);

    const result = await this.coupons.redeem(
      code,
      companyId,
      subscription.plan,
      definition.monthlyPriceCents,
      subscription.id,
      definition.currency,
    );

    this.logger.log(
      `Company ${companyId} redeemed ${result.code} for ${result.discountCents} cents`,
    );

    return result;
  }

  /**
   * Cancels at the end of the paid period by default.
   *
   * Immediate cancellation is available but separate: it forfeits time the
   * customer has already paid for, which should never be the default a
   * mis-clicked button lands on.
   */
  async cancel(
    companyId: string,
    immediately: boolean,
    user: AuthenticatedUser,
  ): Promise<Subscription> {
    const subscription = await this.getForCompany(companyId);
    if (!subscription) {
      throw new NotFoundException('No active subscription');
    }

    const now = new Date();

    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.subscription.update({
        where: { id: subscription.id },
        data: immediately
          ? {
              status: SubscriptionStatus.CANCELED,
              canceledAt: now,
              cancelAtPeriodEnd: false,
              currentPeriodEnd: now,
              plan: SubscriptionPlan.FREE,
            }
          : { cancelAtPeriodEnd: true, canceledAt: now },
      });

      await this.writeAudit(tx, companyId, user.id, 'SUBSCRIPTION_CANCELED', {
        immediately,
        effectiveAt: immediately ? now : subscription.currentPeriodEnd,
      });

      return updated;
    });
  }

  /** Undoes a pending cancellation while the period is still running. */
  async resume(companyId: string, user: AuthenticatedUser): Promise<Subscription> {
    const subscription = await this.getForCompany(companyId);
    if (!subscription) {
      throw new NotFoundException('No subscription found');
    }
    if (!subscription.cancelAtPeriodEnd) {
      throw new ConflictException('Subscription is not scheduled to cancel');
    }

    return this.prisma.client.$transaction(async (tx) => {
      const resumed = await tx.subscription.update({
        where: { id: subscription.id },
        data: { cancelAtPeriodEnd: false, canceledAt: null },
      });

      await this.writeAudit(tx, companyId, user.id, 'SUBSCRIPTION_RESUMED', {});
      return resumed;
    });
  }

  /** Invoice history, newest first. */
  async listTransactions(companyId: string, take = 50) {
    return this.prisma.client.paymentTransaction.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 100),
      select: {
        id: true,
        amountCents: true,
        discountCents: true,
        couponCode: true,
        currency: true,
        status: true,
        description: true,
        processedAt: true,
        createdAt: true,
      },
    });
  }

  /** Records a charge against a subscription. */
  async recordTransaction(
    tx: Prisma.TransactionClient,
    params: {
      companyId: string;
      subscriptionId: string;
      amountCents: number;
      discountCents: number;
      couponCode?: string;
      currency: string;
      status: PaymentStatus;
      description: string;
      failureReason?: string;
    },
  ) {
    return tx.paymentTransaction.create({
      data: {
        companyId: params.companyId,
        subscriptionId: params.subscriptionId,
        amountCents: params.amountCents,
        discountCents: params.discountCents,
        couponCode: params.couponCode,
        currency: params.currency,
        status: params.status,
        description: params.description,
        failureReason: params.failureReason,
        processedAt:
          params.status === PaymentStatus.SUCCEEDED ? new Date() : null,
      },
    });
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    companyId: string,
    userId: string | undefined,
    event: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return tx.auditLog.create({
      data: {
        companyId,
        userId: userId ?? null,
        action: AuditAction.UPDATE,
        entityType: 'Subscription',
        entityId: companyId,
        metadata: { event, ...(metadata as object) },
      },
    });
  }
}

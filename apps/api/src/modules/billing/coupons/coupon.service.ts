import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  SubscriptionPlan,
  SubscriptionStatus,
  type Coupon,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  evaluateCoupon,
  normalizeCode,
  type CouponEvaluation,
} from './coupon-validator';
import type { CreateCouponDto } from './dto/coupon.dto';

@Injectable()
export class CouponService {
  private readonly logger = new Logger(CouponService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks a code without consuming it — what the checkout page calls as the
   * customer types.
   *
   * Read-only by design: a preview that reserved the coupon would let anyone
   * exhaust a limited promotion by typing it into a form.
   */
  async preview(
    code: string,
    companyId: string,
    plan: SubscriptionPlan,
    amountCents: number,
    currency = 'usd',
  ): Promise<CouponEvaluation & { code: string }> {
    const normalized = normalizeCode(code);
    const coupon = await this.findByCode(normalized);

    const [alreadyRedeemed, hasPriorPaidSubscription] = await Promise.all([
      coupon ? this.hasRedeemed(coupon.id, companyId) : Promise.resolve(false),
      this.hasPriorPaidSubscription(companyId),
    ]);

    const evaluation = evaluateCoupon(coupon, {
      plan,
      amountCents,
      currency,
      alreadyRedeemed,
      hasPriorPaidSubscription,
    });

    return { ...evaluation, code: normalized };
  }

  /**
   * Consumes a coupon for a company.
   *
   * The re-check inside the transaction is not redundant with `preview`:
   * between the customer seeing a valid code and submitting checkout, the
   * coupon can expire or hit its redemption cap. The unique constraint on
   * (couponId, companyId) is what actually settles two simultaneous checkouts —
   * the count check above it is for the message, not the guarantee.
   */
  async redeem(
    code: string,
    companyId: string,
    plan: SubscriptionPlan,
    amountCents: number,
    subscriptionId?: string,
    currency = 'usd',
  ): Promise<CouponEvaluation & { code: string; redemptionId: string }> {
    const normalized = normalizeCode(code);

    return this.prisma.client.$transaction(async (tx) => {
      const coupon = await tx.coupon.findUnique({
        where: { code: normalized },
      });

      const [existing, priorPaid] = await Promise.all([
        coupon
          ? tx.couponRedemption.findUnique({
              where: {
                couponId_companyId: { couponId: coupon.id, companyId },
              },
              select: { id: true },
            })
          : Promise.resolve(null),
        tx.subscription.findFirst({
          where: {
            companyId,
            plan: { not: SubscriptionPlan.FREE },
            status: {
              in: [
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.PAST_DUE,
                SubscriptionStatus.CANCELED,
                SubscriptionStatus.UNPAID,
              ],
            },
          },
          select: { id: true },
        }),
      ]);

      const evaluation = evaluateCoupon(coupon, {
        plan,
        amountCents,
        currency,
        alreadyRedeemed: Boolean(existing),
        hasPriorPaidSubscription: Boolean(priorPaid),
      });

      if (!evaluation.valid || !coupon) {
        throw new UnprocessableEntityException({
          message: evaluation.message ?? 'Promo code could not be applied',
          reason: evaluation.reason,
          code: normalized,
        });
      }

      try {
        const redemption = await tx.couponRedemption.create({
          data: {
            couponId: coupon.id,
            companyId,
            subscriptionId,
            discountCents: evaluation.discountCents,
            periodsRemaining: evaluation.periodsRemaining,
          },
        });

        // Denormalised counter, kept in the same transaction as the row it
        // counts so the two cannot disagree.
        await tx.coupon.update({
          where: { id: coupon.id },
          data: { timesRedeemed: { increment: 1 } },
        });

        return { ...evaluation, code: normalized, redemptionId: redemption.id };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          // Lost the race against a concurrent checkout by the same company.
          throw new ConflictException('You have already used that promo code.');
        }
        throw error;
      }
    });
  }

  /**
   * The discount to apply to a renewal, decrementing a REPEATING coupon's
   * remaining periods.
   *
   * Returns zero once a coupon is spent rather than deleting the redemption —
   * the record of what a customer was given is part of the billing history.
   */
  async consumeForRenewal(
    tx: Prisma.TransactionClient,
    companyId: string,
    amountCents: number,
  ): Promise<{ discountCents: number; couponCode?: string }> {
    const redemption = await tx.couponRedemption.findFirst({
      where: {
        companyId,
        OR: [{ periodsRemaining: null }, { periodsRemaining: { gt: 0 } }],
      },
      orderBy: { redeemedAt: 'desc' },
      include: { coupon: true },
    });

    if (!redemption) return { discountCents: 0 };

    const evaluation = evaluateCoupon(redemption.coupon, {
      plan: SubscriptionPlan.FREE, // plan eligibility was settled at redemption
      amountCents,
      currency: redemption.coupon.currency,
      alreadyRedeemed: false,
      hasPriorPaidSubscription: false,
      now: new Date(),
    });

    // Recompute against this period's amount rather than reusing the stored
    // discount: a percentage coupon on an upgraded plan is worth more, and a
    // fixed-amount coupon must still be capped by the new charge.
    const discountCents = evaluation.valid ? evaluation.discountCents : 0;

    if (redemption.periodsRemaining !== null) {
      await tx.couponRedemption.update({
        where: { id: redemption.id },
        data: { periodsRemaining: Math.max(0, redemption.periodsRemaining - 1) },
      });
    }

    return { discountCents, couponCode: redemption.coupon.code };
  }

  // ---------------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------------

  async create(dto: CreateCouponDto): Promise<Coupon> {
    const code = normalizeCode(dto.code);

    try {
      return await this.prisma.client.coupon.create({
        data: {
          code,
          description: dto.description,
          discountType: dto.discountType,
          percentOff: dto.percentOff,
          amountOffCents: dto.amountOffCents,
          currency: dto.currency ?? 'usd',
          duration: dto.duration,
          durationInMonths: dto.durationInMonths,
          maxRedemptions: dto.maxRedemptions,
          appliesToPlans: dto.appliesToPlans ?? [],
          minAmountCents: dto.minAmountCents,
          firstTimeOnly: dto.firstTimeOnly ?? false,
          validFrom: dto.validFrom,
          validUntil: dto.validUntil,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`Coupon ${code} already exists`);
      }
      throw error;
    }
  }

  async list(): Promise<Coupon[]> {
    return this.prisma.client.coupon.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Retires a coupon.
   *
   * Soft delete, because redemptions reference it and a customer mid-way
   * through a REPEATING discount must keep receiving it.
   */
  async deactivate(id: string): Promise<void> {
    const coupon = await this.prisma.client.coupon.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!coupon) throw new NotFoundException('Coupon not found');

    await this.prisma.client.coupon.update({
      where: { id },
      data: { active: false, deletedAt: new Date() },
    });
  }

  private findByCode(normalized: string) {
    return this.prisma.client.coupon.findUnique({ where: { code: normalized } });
  }

  private async hasRedeemed(couponId: string, companyId: string) {
    const existing = await this.prisma.client.couponRedemption.findUnique({
      where: { couponId_companyId: { couponId, companyId } },
      select: { id: true },
    });
    return Boolean(existing);
  }

  private async hasPriorPaidSubscription(companyId: string) {
    const prior = await this.prisma.client.subscription.findFirst({
      where: {
        companyId,
        plan: { not: SubscriptionPlan.FREE },
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.PAST_DUE,
            SubscriptionStatus.CANCELED,
            SubscriptionStatus.UNPAID,
          ],
        },
      },
      select: { id: true },
    });
    return Boolean(prior);
  }
}

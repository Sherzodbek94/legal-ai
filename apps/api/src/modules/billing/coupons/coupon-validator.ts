/**
 * Coupon eligibility and discount arithmetic.
 *
 * Pure, and separate from the service that persists redemptions, because these
 * are the rules a finance team argues about: whether an expired coupon applies
 * to a renewal, whether a $50 discount on a $30 charge yields a $20 credit.
 * They should be readable and testable without a database.
 *
 * All money is integer minor units. Floating-point currency arithmetic produces
 * charges that are off by a cent, and a billing system that is off by a cent is
 * a billing system nobody trusts.
 */
import {
  CouponDiscountType,
  CouponDuration,
  type SubscriptionPlan,
} from '@legaltech/database';

export type CouponRejection =
  | 'NOT_FOUND'
  | 'INACTIVE'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'REDEMPTION_LIMIT_REACHED'
  | 'ALREADY_REDEEMED'
  | 'PLAN_NOT_ELIGIBLE'
  | 'BELOW_MINIMUM_AMOUNT'
  | 'CURRENCY_MISMATCH'
  | 'EXISTING_CUSTOMER_ONLY'
  | 'MALFORMED';

/** The coupon fields validation actually reads. */
export interface CouponSnapshot {
  code: string;
  discountType: CouponDiscountType;
  percentOff?: number | null;
  amountOffCents?: number | null;
  currency: string;
  duration: CouponDuration;
  durationInMonths?: number | null;
  maxRedemptions?: number | null;
  timesRedeemed: number;
  appliesToPlans: SubscriptionPlan[];
  minAmountCents?: number | null;
  firstTimeOnly: boolean;
  validFrom?: Date | null;
  validUntil?: Date | null;
  active: boolean;
  deletedAt?: Date | null;
}

export interface RedemptionContext {
  plan: SubscriptionPlan;
  /** Gross charge the coupon would apply to, in minor units. */
  amountCents: number;
  currency: string;
  /** Whether this company has already redeemed this specific coupon. */
  alreadyRedeemed: boolean;
  /** Whether the company has ever held a paid subscription. */
  hasPriorPaidSubscription: boolean;
  now?: Date;
}

export interface CouponEvaluation {
  valid: boolean;
  reason?: CouponRejection;
  message?: string;
  /** Discount in minor units. Zero when invalid. */
  discountCents: number;
  /** What the customer is charged after the discount. */
  netCents: number;
  /** Periods this coupon keeps applying for; null = unlimited. */
  periodsRemaining: number | null;
}

const REJECTION_MESSAGES: Record<CouponRejection, string> = {
  NOT_FOUND: 'That promo code is not recognised.',
  INACTIVE: 'That promo code is no longer available.',
  NOT_YET_VALID: 'That promo code is not active yet.',
  EXPIRED: 'That promo code has expired.',
  REDEMPTION_LIMIT_REACHED: 'That promo code has been fully redeemed.',
  ALREADY_REDEEMED: 'You have already used that promo code.',
  PLAN_NOT_ELIGIBLE: 'That promo code does not apply to the selected plan.',
  BELOW_MINIMUM_AMOUNT: 'That promo code requires a larger order.',
  CURRENCY_MISMATCH: 'That promo code cannot be applied to this currency.',
  EXISTING_CUSTOMER_ONLY: 'That promo code is only valid for a first subscription.',
  MALFORMED: 'That promo code is not configured correctly.',
};

function reject(reason: CouponRejection, amountCents: number): CouponEvaluation {
  return {
    valid: false,
    reason,
    message: REJECTION_MESSAGES[reason],
    discountCents: 0,
    netCents: amountCents,
    periodsRemaining: null,
  };
}

/** Promo codes are case-insensitive to type but stored uppercase. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Discount for a given charge.
 *
 * Two rules that are easy to get wrong and expensive when they are:
 *   * the discount never exceeds the charge, so a large fixed-amount coupon on
 *     a small invoice yields a zero balance rather than a negative one, which
 *     downstream would read as a refund owed;
 *   * percentages round to the nearest cent rather than truncating, so 10% off
 *     $9.99 is $1.00 and not $0.99.
 */
export function computeDiscountCents(
  coupon: Pick<
    CouponSnapshot,
    'discountType' | 'percentOff' | 'amountOffCents'
  >,
  amountCents: number,
): number {
  if (amountCents <= 0) return 0;

  if (coupon.discountType === CouponDiscountType.PERCENTAGE) {
    const percent = coupon.percentOff ?? 0;
    if (percent <= 0) return 0;
    const capped = Math.min(percent, 100);
    return Math.min(amountCents, Math.round((amountCents * capped) / 100));
  }

  const off = coupon.amountOffCents ?? 0;
  if (off <= 0) return 0;
  return Math.min(amountCents, off);
}

/** How many billing periods a redeemed coupon keeps applying for. */
export function resolvePeriodsRemaining(
  coupon: Pick<CouponSnapshot, 'duration' | 'durationInMonths'>,
): number | null {
  switch (coupon.duration) {
    case CouponDuration.ONCE:
      return 1;
    case CouponDuration.REPEATING:
      // A REPEATING coupon with no duration is indistinguishable from FOREVER;
      // treating it as one period is the conservative reading.
      return coupon.durationInMonths && coupon.durationInMonths > 0
        ? coupon.durationInMonths
        : 1;
    case CouponDuration.FOREVER:
    default:
      return null;
  }
}

/** Whether the coupon is internally coherent — catches a bad admin entry. */
function isWellFormed(coupon: CouponSnapshot): boolean {
  if (coupon.discountType === CouponDiscountType.PERCENTAGE) {
    return (
      typeof coupon.percentOff === 'number' &&
      coupon.percentOff > 0 &&
      coupon.percentOff <= 100
    );
  }
  return typeof coupon.amountOffCents === 'number' && coupon.amountOffCents > 0;
}

/**
 * Applies every eligibility rule and computes the resulting discount.
 *
 * Checks are ordered so the reason returned is the most useful one: a coupon
 * that is both expired and fully redeemed reports as expired, because that is
 * what the customer can see on the marketing material they took it from.
 */
export function evaluateCoupon(
  coupon: CouponSnapshot | null | undefined,
  context: RedemptionContext,
): CouponEvaluation {
  const { amountCents } = context;
  const now = context.now ?? new Date();

  if (!coupon) return reject('NOT_FOUND', amountCents);

  // A soft-deleted coupon is indistinguishable from one that never existed —
  // saying "no longer available" would confirm the code was once real.
  if (coupon.deletedAt) return reject('NOT_FOUND', amountCents);

  if (!coupon.active) return reject('INACTIVE', amountCents);

  if (!isWellFormed(coupon)) return reject('MALFORMED', amountCents);

  if (coupon.validFrom && now < coupon.validFrom) {
    return reject('NOT_YET_VALID', amountCents);
  }
  if (coupon.validUntil && now >= coupon.validUntil) {
    return reject('EXPIRED', amountCents);
  }

  if (context.alreadyRedeemed) return reject('ALREADY_REDEEMED', amountCents);

  if (
    coupon.maxRedemptions !== null &&
    coupon.maxRedemptions !== undefined &&
    coupon.timesRedeemed >= coupon.maxRedemptions
  ) {
    return reject('REDEMPTION_LIMIT_REACHED', amountCents);
  }

  // An empty list means "every plan"; a populated one is an allowlist.
  if (
    coupon.appliesToPlans.length > 0 &&
    !coupon.appliesToPlans.includes(context.plan)
  ) {
    return reject('PLAN_NOT_ELIGIBLE', amountCents);
  }

  if (coupon.firstTimeOnly && context.hasPriorPaidSubscription) {
    return reject('EXISTING_CUSTOMER_ONLY', amountCents);
  }

  // Only fixed-amount coupons carry a currency; a percentage is currency-neutral.
  if (
    coupon.discountType === CouponDiscountType.FIXED_AMOUNT &&
    coupon.currency.toLowerCase() !== context.currency.toLowerCase()
  ) {
    return reject('CURRENCY_MISMATCH', amountCents);
  }

  if (
    coupon.minAmountCents !== null &&
    coupon.minAmountCents !== undefined &&
    amountCents < coupon.minAmountCents
  ) {
    return reject('BELOW_MINIMUM_AMOUNT', amountCents);
  }

  const discountCents = computeDiscountCents(coupon, amountCents);

  return {
    valid: true,
    discountCents,
    netCents: amountCents - discountCents,
    periodsRemaining: resolvePeriodsRemaining(coupon),
  };
}

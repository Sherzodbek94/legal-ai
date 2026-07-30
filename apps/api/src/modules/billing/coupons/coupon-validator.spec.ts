import {
  CouponDiscountType,
  CouponDuration,
  SubscriptionPlan,
} from '@legaltech/database';
import {
  computeDiscountCents,
  evaluateCoupon,
  normalizeCode,
  resolvePeriodsRemaining,
  type CouponSnapshot,
  type RedemptionContext,
} from './coupon-validator';

const NOW = new Date('2026-07-30T12:00:00Z');
const daysFromNow = (days: number) =>
  new Date(NOW.getTime() + days * 86_400_000);

const coupon = (overrides: Partial<CouponSnapshot> = {}): CouponSnapshot => ({
  code: 'LAUNCH20',
  discountType: CouponDiscountType.PERCENTAGE,
  percentOff: 20,
  currency: 'usd',
  duration: CouponDuration.ONCE,
  timesRedeemed: 0,
  appliesToPlans: [],
  firstTimeOnly: false,
  active: true,
  ...overrides,
});

const context = (overrides: Partial<RedemptionContext> = {}): RedemptionContext => ({
  plan: SubscriptionPlan.PRO,
  amountCents: 4900,
  currency: 'usd',
  alreadyRedeemed: false,
  hasPriorPaidSubscription: false,
  now: NOW,
  ...overrides,
});

describe('normalizeCode', () => {
  it('uppercases and trims, so codes are case-insensitive to type', () => {
    expect(normalizeCode('  launch20 ')).toBe('LAUNCH20');
  });
});

describe('computeDiscountCents', () => {
  describe('percentage', () => {
    it('takes the stated percentage', () => {
      expect(
        computeDiscountCents(
          { discountType: CouponDiscountType.PERCENTAGE, percentOff: 20 },
          10_000,
        ),
      ).toBe(2000);
    });

    it('rounds to the nearest cent rather than truncating', () => {
      // 10% of $9.99 is 99.9 cents; truncating would quietly shortchange.
      expect(
        computeDiscountCents(
          { discountType: CouponDiscountType.PERCENTAGE, percentOff: 10 },
          999,
        ),
      ).toBe(100);
    });

    it('caps at 100%, never exceeding the charge', () => {
      expect(
        computeDiscountCents(
          { discountType: CouponDiscountType.PERCENTAGE, percentOff: 150 },
          4900,
        ),
      ).toBe(4900);
    });

    it('yields nothing for a zero or negative percentage', () => {
      expect(
        computeDiscountCents(
          { discountType: CouponDiscountType.PERCENTAGE, percentOff: 0 },
          4900,
        ),
      ).toBe(0);
    });
  });

  describe('fixed amount', () => {
    it('subtracts the stated amount', () => {
      expect(
        computeDiscountCents(
          { discountType: CouponDiscountType.FIXED_AMOUNT, amountOffCents: 1500 },
          4900,
        ),
      ).toBe(1500);
    });

    it('never exceeds the charge, so the balance cannot go negative', () => {
      // A negative balance downstream reads as a refund owed to the customer.
      expect(
        computeDiscountCents(
          { discountType: CouponDiscountType.FIXED_AMOUNT, amountOffCents: 10_000 },
          4900,
        ),
      ).toBe(4900);
    });
  });

  it('yields nothing against a zero charge', () => {
    expect(
      computeDiscountCents(
        { discountType: CouponDiscountType.PERCENTAGE, percentOff: 50 },
        0,
      ),
    ).toBe(0);
  });
});

describe('resolvePeriodsRemaining', () => {
  it('gives a ONCE coupon a single period', () => {
    expect(resolvePeriodsRemaining({ duration: CouponDuration.ONCE })).toBe(1);
  });

  it('gives a REPEATING coupon its declared months', () => {
    expect(
      resolvePeriodsRemaining({
        duration: CouponDuration.REPEATING,
        durationInMonths: 3,
      }),
    ).toBe(3);
  });

  it('treats a REPEATING coupon with no duration conservatively', () => {
    // Reading it as FOREVER would give away an unbounded discount on what is
    // most likely a mis-configured coupon.
    expect(
      resolvePeriodsRemaining({ duration: CouponDuration.REPEATING }),
    ).toBe(1);
  });

  it('leaves a FOREVER coupon unbounded', () => {
    expect(resolvePeriodsRemaining({ duration: CouponDuration.FOREVER })).toBeNull();
  });
});

describe('evaluateCoupon', () => {
  describe('accepts', () => {
    it('a valid percentage coupon', () => {
      const result = evaluateCoupon(coupon(), context());
      expect(result.valid).toBe(true);
      expect(result.discountCents).toBe(980);
      expect(result.netCents).toBe(3920);
    });

    it('a coupon whose plan allowlist includes the chosen plan', () => {
      expect(
        evaluateCoupon(
          coupon({ appliesToPlans: [SubscriptionPlan.PRO, SubscriptionPlan.BUSINESS] }),
          context({ plan: SubscriptionPlan.PRO }),
        ).valid,
      ).toBe(true);
    });

    it('a coupon with an empty plan list, meaning every plan', () => {
      expect(
        evaluateCoupon(
          coupon({ appliesToPlans: [] }),
          context({ plan: SubscriptionPlan.ENTERPRISE }),
        ).valid,
      ).toBe(true);
    });

    it('a first-time coupon for a company with no paid history', () => {
      expect(
        evaluateCoupon(
          coupon({ firstTimeOnly: true }),
          context({ hasPriorPaidSubscription: false }),
        ).valid,
      ).toBe(true);
    });

    it('a coupon inside its validity window', () => {
      expect(
        evaluateCoupon(
          coupon({ validFrom: daysFromNow(-1), validUntil: daysFromNow(1) }),
          context(),
        ).valid,
      ).toBe(true);
    });

    it('a coupon that has redemptions left', () => {
      expect(
        evaluateCoupon(
          coupon({ maxRedemptions: 100, timesRedeemed: 99 }),
          context(),
        ).valid,
      ).toBe(true);
    });

    it('a percentage coupon regardless of currency', () => {
      // A percentage is currency-neutral; only fixed amounts are denominated.
      expect(
        evaluateCoupon(
          coupon({ currency: 'usd' }),
          context({ currency: 'uzs' }),
        ).valid,
      ).toBe(true);
    });
  });

  describe('rejects', () => {
    it('an unknown code', () => {
      const result = evaluateCoupon(null, context());
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('NOT_FOUND');
      expect(result.discountCents).toBe(0);
      expect(result.netCents).toBe(4900);
    });

    it('a soft-deleted coupon as simply unknown', () => {
      // Saying "no longer available" would confirm the code was once real.
      expect(
        evaluateCoupon(coupon({ deletedAt: daysFromNow(-1) }), context()).reason,
      ).toBe('NOT_FOUND');
    });

    it('a deactivated coupon', () => {
      expect(evaluateCoupon(coupon({ active: false }), context()).reason).toBe(
        'INACTIVE',
      );
    });

    it('a coupon whose window has not opened', () => {
      expect(
        evaluateCoupon(coupon({ validFrom: daysFromNow(1) }), context()).reason,
      ).toBe('NOT_YET_VALID');
    });

    it('an expired coupon', () => {
      expect(
        evaluateCoupon(coupon({ validUntil: daysFromNow(-1) }), context()).reason,
      ).toBe('EXPIRED');
    });

    it('a coupon expiring exactly now, treating validUntil as exclusive', () => {
      expect(evaluateCoupon(coupon({ validUntil: NOW }), context()).reason).toBe(
        'EXPIRED',
      );
    });

    it('a coupon the company has already used', () => {
      expect(
        evaluateCoupon(coupon(), context({ alreadyRedeemed: true })).reason,
      ).toBe('ALREADY_REDEEMED');
    });

    it('a coupon at its redemption cap', () => {
      expect(
        evaluateCoupon(
          coupon({ maxRedemptions: 100, timesRedeemed: 100 }),
          context(),
        ).reason,
      ).toBe('REDEMPTION_LIMIT_REACHED');
    });

    it('a coupon that does not cover the chosen plan', () => {
      expect(
        evaluateCoupon(
          coupon({ appliesToPlans: [SubscriptionPlan.BUSINESS] }),
          context({ plan: SubscriptionPlan.PRO }),
        ).reason,
      ).toBe('PLAN_NOT_ELIGIBLE');
    });

    it('a first-time coupon for an existing paying customer', () => {
      expect(
        evaluateCoupon(
          coupon({ firstTimeOnly: true }),
          context({ hasPriorPaidSubscription: true }),
        ).reason,
      ).toBe('EXISTING_CUSTOMER_ONLY');
    });

    it('a fixed-amount coupon in the wrong currency', () => {
      expect(
        evaluateCoupon(
          coupon({
            discountType: CouponDiscountType.FIXED_AMOUNT,
            amountOffCents: 1000,
            percentOff: null,
            currency: 'usd',
          }),
          context({ currency: 'uzs' }),
        ).reason,
      ).toBe('CURRENCY_MISMATCH');
    });

    it('an order below the coupon minimum', () => {
      expect(
        evaluateCoupon(
          coupon({ minAmountCents: 10_000 }),
          context({ amountCents: 4900 }),
        ).reason,
      ).toBe('BELOW_MINIMUM_AMOUNT');
    });

    it('a percentage coupon with no percentage set', () => {
      expect(
        evaluateCoupon(coupon({ percentOff: null }), context()).reason,
      ).toBe('MALFORMED');
    });

    it('a percentage coupon above 100', () => {
      expect(
        evaluateCoupon(coupon({ percentOff: 200 }), context()).reason,
      ).toBe('MALFORMED');
    });

    it('a fixed-amount coupon with no amount set', () => {
      expect(
        evaluateCoupon(
          coupon({
            discountType: CouponDiscountType.FIXED_AMOUNT,
            percentOff: null,
            amountOffCents: null,
          }),
          context(),
        ).reason,
      ).toBe('MALFORMED');
    });

    it('leaving the charge untouched on every rejection', () => {
      const result = evaluateCoupon(coupon({ active: false }), context());
      expect(result.discountCents).toBe(0);
      expect(result.netCents).toBe(4900);
    });
  });

  describe('rejection ordering', () => {
    it('reports expiry ahead of a redemption cap', () => {
      // Expiry is what the customer can see on the material they took the code
      // from, so it is the more useful answer.
      expect(
        evaluateCoupon(
          coupon({
            validUntil: daysFromNow(-1),
            maxRedemptions: 10,
            timesRedeemed: 10,
          }),
          context(),
        ).reason,
      ).toBe('EXPIRED');
    });

    it('reports a malformed coupon before checking its window', () => {
      expect(
        evaluateCoupon(
          coupon({ percentOff: null, validFrom: daysFromNow(1) }),
          context(),
        ).reason,
      ).toBe('MALFORMED');
    });
  });

  it('carries a customer-facing message on every rejection', () => {
    const reasons = [
      coupon({ active: false }),
      coupon({ validUntil: daysFromNow(-1) }),
      coupon({ maxRedemptions: 1, timesRedeemed: 1 }),
    ];

    for (const candidate of reasons) {
      const result = evaluateCoupon(candidate, context());
      expect(result.message).toBeTruthy();
      expect(result.message).not.toMatch(/undefined|null/);
    }
  });
});

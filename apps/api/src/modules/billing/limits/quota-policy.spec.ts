import { SubscriptionPlan, SubscriptionStatus, UsageMetric } from '@legaltech/database';
import {
  effectivePlan,
  evaluateQuota,
  evaluateSubscriptionAccess,
  hasFeature,
  isStockMetric,
  type SubscriptionSnapshot,
} from './quota-policy';
import { PLAN_CATALOG, resolveLimits } from '../plans/plan-catalog';

const NOW = new Date('2026-07-30T12:00:00Z');
const hoursFromNow = (hours: number) =>
  new Date(NOW.getTime() + hours * 3_600_000);

const subscription = (
  overrides: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot => ({
  plan: SubscriptionPlan.PRO,
  status: SubscriptionStatus.ACTIVE,
  ...overrides,
});

describe('effectivePlan', () => {
  it('treats a company with no subscription as Free', () => {
    expect(effectivePlan(null)).toBe(SubscriptionPlan.FREE);
    expect(effectivePlan(undefined)).toBe(SubscriptionPlan.FREE);
  });

  it('uses the subscription plan when there is one', () => {
    expect(effectivePlan(subscription({ plan: SubscriptionPlan.BUSINESS }))).toBe(
      SubscriptionPlan.BUSINESS,
    );
  });
});

describe('evaluateSubscriptionAccess', () => {
  describe('allows service', () => {
    it('for a company with no subscription at all', () => {
      // A brand-new signup has no billing record and must still be able to work.
      expect(evaluateSubscriptionAccess(null, NOW).allowed).toBe(true);
    });

    it('for an active subscription', () => {
      expect(evaluateSubscriptionAccess(subscription(), NOW).allowed).toBe(true);
    });

    it('for a trial that has not ended', () => {
      const decision = evaluateSubscriptionAccess(
        subscription({
          status: SubscriptionStatus.TRIALING,
          trialEndsAt: hoursFromNow(48),
        }),
        NOW,
      );
      expect(decision.allowed).toBe(true);
    });

    it('for a trial with no end date, rather than cutting the user off', () => {
      expect(
        evaluateSubscriptionAccess(
          subscription({ status: SubscriptionStatus.TRIALING, trialEndsAt: null }),
          NOW,
        ).allowed,
      ).toBe(true);
    });

    it('for a past-due subscription still inside its grace period', () => {
      expect(
        evaluateSubscriptionAccess(
          subscription({
            status: SubscriptionStatus.PAST_DUE,
            graceEndsAt: hoursFromNow(24),
          }),
          NOW,
        ).allowed,
      ).toBe(true);
    });

    it('for a cancelled subscription that is paid through the period', () => {
      expect(
        evaluateSubscriptionAccess(
          subscription({
            status: SubscriptionStatus.CANCELED,
            currentPeriodEnd: hoursFromNow(72),
          }),
          NOW,
        ).allowed,
      ).toBe(true);
    });

    it('for a Free plan regardless of payment status', () => {
      // Free has nothing to pay, so an UNPAID status on it is meaningless.
      expect(
        evaluateSubscriptionAccess(
          subscription({
            plan: SubscriptionPlan.FREE,
            status: SubscriptionStatus.UNPAID,
          }),
          NOW,
        ).allowed,
      ).toBe(true);
    });
  });

  describe('denies service', () => {
    it('for an expired trial', () => {
      const decision = evaluateSubscriptionAccess(
        subscription({
          status: SubscriptionStatus.TRIALING,
          trialEndsAt: hoursFromNow(-1),
        }),
        NOW,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('TRIAL_EXPIRED');
    });

    it('for a past-due subscription whose grace period has ended', () => {
      const decision = evaluateSubscriptionAccess(
        subscription({
          status: SubscriptionStatus.PAST_DUE,
          graceEndsAt: hoursFromNow(-1),
        }),
        NOW,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('SUBSCRIPTION_UNPAID');
    });

    it('for a past-due subscription with no grace period recorded', () => {
      expect(
        evaluateSubscriptionAccess(
          subscription({ status: SubscriptionStatus.PAST_DUE, graceEndsAt: null }),
          NOW,
        ).allowed,
      ).toBe(false);
    });

    it('for a cancelled subscription past its period end', () => {
      const decision = evaluateSubscriptionAccess(
        subscription({
          status: SubscriptionStatus.CANCELED,
          currentPeriodEnd: hoursFromNow(-1),
        }),
        NOW,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('SUBSCRIPTION_CANCELED');
    });

    it('for an unpaid subscription', () => {
      expect(
        evaluateSubscriptionAccess(
          subscription({ status: SubscriptionStatus.UNPAID }),
          NOW,
        ).allowed,
      ).toBe(false);
    });

    it('for an incomplete checkout', () => {
      expect(
        evaluateSubscriptionAccess(
          subscription({ status: SubscriptionStatus.INCOMPLETE }),
          NOW,
        ).allowed,
      ).toBe(false);
    });

    it('with a message the customer can act on', () => {
      const decision = evaluateSubscriptionAccess(
        subscription({ status: SubscriptionStatus.UNPAID }),
        NOW,
      );
      expect(decision.message).toMatch(/billing details/i);
    });
  });
});

describe('evaluateQuota', () => {
  describe('metered limits', () => {
    it('allows a request that fits', () => {
      const decision = evaluateQuota(100, 10);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(89);
    });

    it('allows the request that exactly reaches the limit', () => {
      const decision = evaluateQuota(100, 99);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(0);
    });

    it('blocks the request one past the limit', () => {
      // The off-by-one that matters: on a limit of 100, the 101st must fail.
      const decision = evaluateQuota(100, 100);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('QUOTA_EXCEEDED');
      expect(decision.remaining).toBe(0);
    });

    it('blocks a multi-unit request that would straddle the limit', () => {
      expect(evaluateQuota(100, 98, 5).allowed).toBe(false);
    });

    it('allows a multi-unit request that lands exactly on the limit', () => {
      const decision = evaluateQuota(100, 95, 5);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(0);
    });

    it('reports remaining as zero rather than negative when over', () => {
      expect(evaluateQuota(10, 25).remaining).toBe(0);
    });

    it('explains how to resolve an exhausted quota', () => {
      const decision = evaluateQuota(5, 5);
      expect(decision.message).toMatch(/upgrade|billing period/i);
    });
  });

  describe('unmetered limits', () => {
    it('always allows when the limit is null', () => {
      expect(evaluateQuota(null, 1_000_000).allowed).toBe(true);
    });

    it('reports remaining as null rather than a number', () => {
      expect(evaluateQuota(null, 5).remaining).toBeNull();
    });
  });

  describe('zero limits', () => {
    it('distinguishes "not in your plan" from "used it all up"', () => {
      const decision = evaluateQuota(0, 0);
      expect(decision.allowed).toBe(false);
      // A zero limit is a missing capability, not an exhausted allowance — the
      // two need different upsell copy.
      expect(decision.reason).toBe('FEATURE_NOT_IN_PLAN');
    });
  });
});

describe('plan limits', () => {
  it('gives Free a small but usable allowance', () => {
    const limits = resolveLimits(SubscriptionPlan.FREE);
    expect(limits[UsageMetric.DOCUMENTS_GENERATED]).toBe(5);
    expect(limits[UsageMetric.SEATS]).toBe(1);
  });

  it('increases allowances monotonically up the plan ladder', () => {
    const free = resolveLimits(SubscriptionPlan.FREE)[UsageMetric.DOCUMENTS_GENERATED]!;
    const pro = resolveLimits(SubscriptionPlan.PRO)[UsageMetric.DOCUMENTS_GENERATED]!;
    const business = resolveLimits(SubscriptionPlan.BUSINESS)[
      UsageMetric.DOCUMENTS_GENERATED
    ]!;

    expect(pro).toBeGreaterThan(free);
    expect(business).toBeGreaterThan(pro);
    expect(
      resolveLimits(SubscriptionPlan.ENTERPRISE)[UsageMetric.DOCUMENTS_GENERATED],
    ).toBeNull();
  });

  it('defines every metric on every plan', () => {
    for (const plan of Object.values(SubscriptionPlan)) {
      const limits = resolveLimits(plan);
      for (const metric of Object.values(UsageMetric)) {
        expect(limits).toHaveProperty(metric);
      }
    }
  });

  describe('negotiated overrides', () => {
    it('raises a specific limit without touching the others', () => {
      const limits = resolveLimits(SubscriptionPlan.PRO, {
        [UsageMetric.DOCUMENTS_GENERATED]: 5000,
      });
      expect(limits[UsageMetric.DOCUMENTS_GENERATED]).toBe(5000);
      expect(limits[UsageMetric.SEATS]).toBe(
        PLAN_CATALOG[SubscriptionPlan.PRO].limits[UsageMetric.SEATS],
      );
    });

    it('treats an explicit null as lifting the limit', () => {
      expect(
        resolveLimits(SubscriptionPlan.PRO, {
          [UsageMetric.AI_GENERATIONS]: null,
        })[UsageMetric.AI_GENERATIONS],
      ).toBeNull();
    });

    it('ignores keys that are not metrics', () => {
      const limits = resolveLimits(SubscriptionPlan.PRO, { NOT_A_METRIC: 999 });
      expect(limits).not.toHaveProperty('NOT_A_METRIC');
    });

    it('ignores non-integer and negative values rather than trusting them', () => {
      const base = PLAN_CATALOG[SubscriptionPlan.PRO].limits;
      const limits = resolveLimits(SubscriptionPlan.PRO, {
        [UsageMetric.SEATS]: -5,
        [UsageMetric.TEMPLATES]: 'unlimited',
      });
      expect(limits[UsageMetric.SEATS]).toBe(base[UsageMetric.SEATS]);
      expect(limits[UsageMetric.TEMPLATES]).toBe(base[UsageMetric.TEMPLATES]);
    });

    it('ignores an override payload that is not an object', () => {
      expect(resolveLimits(SubscriptionPlan.PRO, 'nonsense')).toEqual(
        PLAN_CATALOG[SubscriptionPlan.PRO].limits,
      );
      expect(resolveLimits(SubscriptionPlan.PRO, [1, 2])).toEqual(
        PLAN_CATALOG[SubscriptionPlan.PRO].limits,
      );
    });
  });
});

describe('features', () => {
  it('withholds approval workflows and API access from Free', () => {
    expect(hasFeature(SubscriptionPlan.FREE, 'approvalWorkflows')).toBe(false);
    expect(hasFeature(SubscriptionPlan.FREE, 'apiAccess')).toBe(false);
  });

  it('grants API access from Business upward', () => {
    expect(hasFeature(SubscriptionPlan.PRO, 'apiAccess')).toBe(false);
    expect(hasFeature(SubscriptionPlan.BUSINESS, 'apiAccess')).toBe(true);
    expect(hasFeature(SubscriptionPlan.ENTERPRISE, 'apiAccess')).toBe(true);
  });

  it('grants every feature on Enterprise', () => {
    const features = PLAN_CATALOG[SubscriptionPlan.ENTERPRISE].features;
    expect(Object.values(features).every(Boolean)).toBe(true);
  });
});

describe('stock vs flow metrics', () => {
  it('counts templates and seats as standing quantities', () => {
    // Deleting a template must free its slot; generating and deleting a
    // document must not refund the generation.
    expect(isStockMetric(UsageMetric.TEMPLATES)).toBe(true);
    expect(isStockMetric(UsageMetric.SEATS)).toBe(true);
  });

  it('counts generations as period activity', () => {
    expect(isStockMetric(UsageMetric.DOCUMENTS_GENERATED)).toBe(false);
    expect(isStockMetric(UsageMetric.AI_GENERATIONS)).toBe(false);
  });
});

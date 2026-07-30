import { SubscriptionPlan, SubscriptionStatus } from '@legaltech/database';
import {
  computeMrrMovement,
  contributesToMrr,
  customerChurnRate,
  estimatedLtvCents,
  formatMinorUnits,
  revenueChurnRate,
  subscriptionMrrCents,
  summarizeRevenue,
  type RevenueSubscription,
} from './revenue-math';

const subscription = (
  overrides: Partial<RevenueSubscription> = {},
): RevenueSubscription => ({
  plan: SubscriptionPlan.PRO,
  status: SubscriptionStatus.ACTIVE,
  monthlyPriceCents: 4900,
  ...overrides,
});

describe('which statuses count as revenue', () => {
  it('counts active subscriptions', () => {
    expect(contributesToMrr(SubscriptionStatus.ACTIVE)).toBe(true);
  });

  it('counts past-due, because the customer has not left', () => {
    // Treating a failed card as instant churn makes MRR swing on payment-retry
    // timing rather than on customers leaving.
    expect(contributesToMrr(SubscriptionStatus.PAST_DUE)).toBe(true);
  });

  it('excludes trials, which are a hypothesis rather than revenue', () => {
    expect(contributesToMrr(SubscriptionStatus.TRIALING)).toBe(false);
  });

  it('excludes cancelled, unpaid, and incomplete', () => {
    expect(contributesToMrr(SubscriptionStatus.CANCELED)).toBe(false);
    expect(contributesToMrr(SubscriptionStatus.UNPAID)).toBe(false);
    expect(contributesToMrr(SubscriptionStatus.INCOMPLETE)).toBe(false);
  });
});

describe('subscriptionMrrCents', () => {
  it('is the plan price for an active paid subscription', () => {
    expect(subscriptionMrrCents(subscription())).toBe(4900);
  });

  it('is zero for a trial', () => {
    expect(
      subscriptionMrrCents(subscription({ status: SubscriptionStatus.TRIALING })),
    ).toBe(0);
  });

  it('is zero on the Free plan even when active', () => {
    expect(
      subscriptionMrrCents(
        subscription({ plan: SubscriptionPlan.FREE, monthlyPriceCents: 0 }),
      ),
    ).toBe(0);
  });

  it('subtracts a recurring discount', () => {
    // A customer on permanent 50% off contributes half the list price; counting
    // the full amount overstates MRR for exactly the cohort a promotion created.
    expect(subscriptionMrrCents(subscription({ discountCents: 2450 }))).toBe(2450);
  });

  it('floors at zero when the discount exceeds the price', () => {
    // A negative contribution would reduce everyone else's revenue.
    expect(subscriptionMrrCents(subscription({ discountCents: 10_000 }))).toBe(0);
  });

  it('ignores a negative discount', () => {
    expect(subscriptionMrrCents(subscription({ discountCents: -500 }))).toBe(4900);
  });
});

describe('summarizeRevenue', () => {
  it('sums MRR and derives ARR as twelve times it', () => {
    const snapshot = summarizeRevenue([
      subscription(),
      subscription({ plan: SubscriptionPlan.BUSINESS, monthlyPriceCents: 19_900 }),
    ]);

    expect(snapshot.mrrCents).toBe(24_800);
    expect(snapshot.arrCents).toBe(297_600);
  });

  it('counts only revenue-generating subscriptions as paying customers', () => {
    const snapshot = summarizeRevenue([
      subscription(),
      subscription({ status: SubscriptionStatus.TRIALING }),
      subscription({ plan: SubscriptionPlan.FREE, monthlyPriceCents: 0 }),
    ]);

    expect(snapshot.payingCustomers).toBe(1);
  });

  it('computes ARPA over paying customers only', () => {
    const snapshot = summarizeRevenue([
      subscription(),
      subscription(),
      subscription({ plan: SubscriptionPlan.FREE, monthlyPriceCents: 0 }),
    ]);

    // 9800 over two payers, not three accounts.
    expect(snapshot.arpaCents).toBe(4900);
  });

  it('reports zero ARPA rather than dividing by zero', () => {
    const snapshot = summarizeRevenue([
      subscription({ plan: SubscriptionPlan.FREE, monthlyPriceCents: 0 }),
    ]);
    expect(snapshot.arpaCents).toBe(0);
  });

  it('counts every account in the plan distribution, including Free', () => {
    const snapshot = summarizeRevenue([
      subscription({ plan: SubscriptionPlan.FREE, monthlyPriceCents: 0 }),
      subscription({ plan: SubscriptionPlan.FREE, monthlyPriceCents: 0 }),
      subscription(),
    ]);

    expect(snapshot.byPlan[SubscriptionPlan.FREE].customers).toBe(2);
    expect(snapshot.byPlan[SubscriptionPlan.FREE].mrrCents).toBe(0);
    expect(snapshot.byPlan[SubscriptionPlan.PRO].customers).toBe(1);
  });

  it('handles an empty book', () => {
    const snapshot = summarizeRevenue([]);
    expect(snapshot).toMatchObject({
      mrrCents: 0,
      arrCents: 0,
      payingCustomers: 0,
      arpaCents: 0,
    });
  });
});

describe('computeMrrMovement', () => {
  it('classifies a first-time customer as new MRR', () => {
    const movement = computeMrrMovement(new Map(), new Map([['co_1', 4900]]));
    expect(movement).toMatchObject({ newMrrCents: 4900, netChangeCents: 4900 });
  });

  it('classifies an upgrade as expansion, counting only the delta', () => {
    const movement = computeMrrMovement(
      new Map([['co_1', 4900]]),
      new Map([['co_1', 19_900]]),
    );
    expect(movement.expansionMrrCents).toBe(15_000);
    expect(movement.newMrrCents).toBe(0);
  });

  it('classifies a downgrade as contraction', () => {
    const movement = computeMrrMovement(
      new Map([['co_1', 19_900]]),
      new Map([['co_1', 4900]]),
    );
    expect(movement.contractionMrrCents).toBe(15_000);
  });

  it('classifies a disappearance as churn, not contraction to zero', () => {
    const movement = computeMrrMovement(new Map([['co_1', 4900]]), new Map());
    expect(movement.churnedMrrCents).toBe(4900);
    expect(movement.contractionMrrCents).toBe(0);
  });

  it('nets the four components', () => {
    const movement = computeMrrMovement(
      new Map([
        ['keeps', 4900],
        ['upgrades', 4900],
        ['downgrades', 19_900],
        ['leaves', 4900],
      ]),
      new Map([
        ['keeps', 4900],
        ['upgrades', 19_900],
        ['downgrades', 4900],
        ['arrives', 4900],
      ]),
    );

    expect(movement).toMatchObject({
      newMrrCents: 4900,
      expansionMrrCents: 15_000,
      contractionMrrCents: 15_000,
      churnedMrrCents: 4900,
      netChangeCents: 0,
    });
  });

  it('distinguishes a genuinely flat month from churn masked by acquisition', () => {
    // Both net to zero; only the decomposition tells them apart, which is the
    // reason this returns four numbers rather than one.
    const flat = computeMrrMovement(
      new Map([['co_1', 4900]]),
      new Map([['co_1', 4900]]),
    );
    const churnAndReplace = computeMrrMovement(
      new Map([['old', 4900]]),
      new Map([['new', 4900]]),
    );

    expect(flat.netChangeCents).toBe(churnAndReplace.netChangeCents);
    expect(flat.churnedMrrCents).toBe(0);
    expect(churnAndReplace.churnedMrrCents).toBe(4900);
  });

  it('ignores a company that had and still has no revenue', () => {
    const movement = computeMrrMovement(
      new Map([['co_1', 0]]),
      new Map([['co_1', 0]]),
    );
    expect(movement.netChangeCents).toBe(0);
    expect(movement.newMrrCents).toBe(0);
  });
});

describe('churn rates', () => {
  it('expresses revenue churn as a proportion of the opening balance', () => {
    expect(revenueChurnRate(100_000, 5000)).toBeCloseTo(0.05);
  });

  it('returns null when there was nothing to churn', () => {
    // Reporting 0% would imply a perfect retention record that does not exist.
    expect(revenueChurnRate(0, 0)).toBeNull();
  });

  it('expresses customer churn the same way', () => {
    expect(customerChurnRate(50, 5)).toBeCloseTo(0.1);
    expect(customerChurnRate(0, 0)).toBeNull();
  });
});

describe('estimatedLtvCents', () => {
  it('divides ARPA by the churn rate', () => {
    expect(estimatedLtvCents(4900, 0.05)).toBe(98_000);
  });

  it('returns null at zero churn rather than infinity', () => {
    // The formula's limit is genuinely unbounded; a dashboard showing an
    // infinite LTV is worse than one showing "not enough data".
    expect(estimatedLtvCents(4900, 0)).toBeNull();
    expect(estimatedLtvCents(4900, null)).toBeNull();
  });
});

describe('formatMinorUnits', () => {
  it('renders minor units with two decimal places', () => {
    expect(formatMinorUnits(4900)).toBe('49.00');
    expect(formatMinorUnits(4905)).toBe('49.05');
    expect(formatMinorUnits(5)).toBe('0.05');
    expect(formatMinorUnits(0)).toBe('0.00');
  });

  it('keeps the sign outside the digits', () => {
    expect(formatMinorUnits(-4900)).toBe('-49.00');
  });
});

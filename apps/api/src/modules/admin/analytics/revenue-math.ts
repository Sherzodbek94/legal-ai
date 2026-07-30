/**
 * Recurring-revenue arithmetic.
 *
 * Pure functions, because MRR is the number a board looks at and the definitions
 * are easy to get quietly wrong in ways that flatter: counting trials as
 * revenue, counting an annual payment as one month's MRR, or forgetting that a
 * 50%-off coupon halves the recurring revenue for as long as it applies.
 *
 * Everything is integer micro-USD internally to avoid the drift that shows up
 * when you sum thousands of cent-rounded subscriptions.
 */
import { SubscriptionPlan, SubscriptionStatus } from '@legaltech/database';

/** One subscription, reduced to what revenue depends on. */
export interface RevenueSubscription {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  /** List price of the plan per month, in minor units (cents). */
  monthlyPriceCents: number;
  /** Recurring discount currently applying, in minor units per month. */
  discountCents?: number;
}

/**
 * Statuses that contribute to MRR.
 *
 * TRIALING is excluded on purpose. A trial is not revenue — it is a hypothesis —
 * and including it is the single most common way a SaaS dashboard overstates
 * itself. PAST_DUE *is* included: the customer is still subscribed and the
 * expected outcome is that the payment recovers; treating a failed card as
 * instant churn makes MRR swing on payment-retry timing rather than on
 * customers leaving.
 */
export const REVENUE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

export function contributesToMrr(status: SubscriptionStatus): boolean {
  return REVENUE_STATUSES.includes(status);
}

/**
 * Monthly recurring revenue for one subscription, in minor units.
 *
 * Never negative: a discount larger than the plan price yields zero, not a
 * credit against everyone else's revenue.
 */
export function subscriptionMrrCents(subscription: RevenueSubscription): number {
  if (!contributesToMrr(subscription.status)) return 0;
  if (subscription.plan === SubscriptionPlan.FREE) return 0;

  const gross = Math.max(0, subscription.monthlyPriceCents);
  const discount = Math.max(0, subscription.discountCents ?? 0);

  return Math.max(0, gross - discount);
}

export interface RevenueSnapshot {
  /** Minor units per month. */
  mrrCents: number;
  /**
   * Annual run rate: MRR × 12.
   *
   * Deliberately *not* the sum of the last twelve months' billings, which is
   * trailing revenue and a different number. ARR here answers "if nothing
   * changed, what would the next year bill?".
   */
  arrCents: number;
  /** Subscriptions contributing revenue. */
  payingCustomers: number;
  /** Average revenue per paying account, minor units. */
  arpaCents: number;
  byPlan: Record<
    SubscriptionPlan,
    { customers: number; mrrCents: number }
  >;
}

const emptyByPlan = (): RevenueSnapshot['byPlan'] => ({
  [SubscriptionPlan.FREE]: { customers: 0, mrrCents: 0 },
  [SubscriptionPlan.PRO]: { customers: 0, mrrCents: 0 },
  [SubscriptionPlan.BUSINESS]: { customers: 0, mrrCents: 0 },
  [SubscriptionPlan.ENTERPRISE]: { customers: 0, mrrCents: 0 },
});

export function summarizeRevenue(
  subscriptions: RevenueSubscription[],
): RevenueSnapshot {
  const byPlan = emptyByPlan();
  let mrrCents = 0;
  let payingCustomers = 0;

  for (const subscription of subscriptions) {
    const mrr = subscriptionMrrCents(subscription);
    const bucket = byPlan[subscription.plan];

    // Every subscription counts toward its plan's customer total, including
    // Free — plan distribution is a different question from revenue.
    bucket.customers += 1;
    bucket.mrrCents += mrr;

    if (mrr > 0) {
      mrrCents += mrr;
      payingCustomers += 1;
    }
  }

  return {
    mrrCents,
    arrCents: mrrCents * 12,
    payingCustomers,
    arpaCents: payingCustomers === 0 ? 0 : Math.round(mrrCents / payingCustomers),
    byPlan,
  };
}

/**
 * Period-over-period movement.
 *
 * The four components are what make a change in MRR explainable. A single delta
 * hides whether a flat month was genuinely flat or was heavy churn masked by
 * heavy acquisition — which are opposite situations.
 */
export interface MrrMovement {
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnedMrrCents: number;
  netChangeCents: number;
}

export function computeMrrMovement(
  previous: Map<string, number>,
  current: Map<string, number>,
): MrrMovement {
  let newMrrCents = 0;
  let expansionMrrCents = 0;
  let contractionMrrCents = 0;
  let churnedMrrCents = 0;

  for (const [companyId, currentMrr] of current) {
    const previousMrr = previous.get(companyId) ?? 0;

    if (previousMrr === 0 && currentMrr > 0) {
      newMrrCents += currentMrr;
    } else if (currentMrr > previousMrr) {
      expansionMrrCents += currentMrr - previousMrr;
    } else if (currentMrr < previousMrr) {
      contractionMrrCents += previousMrr - currentMrr;
    }
  }

  // A company absent from `current` has gone entirely, which is churn rather
  // than contraction to zero.
  for (const [companyId, previousMrr] of previous) {
    if (previousMrr > 0 && !current.has(companyId)) {
      churnedMrrCents += previousMrr;
    }
  }

  return {
    newMrrCents,
    expansionMrrCents,
    contractionMrrCents,
    churnedMrrCents,
    netChangeCents:
      newMrrCents + expansionMrrCents - contractionMrrCents - churnedMrrCents,
  };
}

/**
 * Revenue churn as a proportion of the opening balance.
 *
 * Returns null rather than zero when there was nothing to churn: a month that
 * opened at zero MRR has an undefined churn rate, and reporting 0% implies a
 * perfect retention record that does not exist.
 */
export function revenueChurnRate(
  openingMrrCents: number,
  churnedMrrCents: number,
): number | null {
  if (openingMrrCents <= 0) return null;
  return churnedMrrCents / openingMrrCents;
}

/** Customer churn over a period, as a proportion. Null when nothing opened. */
export function customerChurnRate(
  openingCustomers: number,
  churnedCustomers: number,
): number | null {
  if (openingCustomers <= 0) return null;
  return churnedCustomers / openingCustomers;
}

/**
 * Lifetime value, on the crude ARPA/churn model.
 *
 * Returns null at zero churn instead of Infinity. The formula's limit is
 * genuinely unbounded there, and a dashboard reporting an infinite LTV is worse
 * than one reporting "not enough data".
 */
export function estimatedLtvCents(
  arpaCents: number,
  monthlyChurnRate: number | null,
): number | null {
  if (monthlyChurnRate === null || monthlyChurnRate <= 0) return null;
  return Math.round(arpaCents / monthlyChurnRate);
}

/** Formats minor units as a decimal string for display. */
export function formatMinorUnits(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

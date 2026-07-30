/**
 * Whether a company may consume a metered resource right now.
 *
 * Pure functions over plain values, with no database and no Nest wiring. Quota
 * enforcement is the code most likely to be wrong in a way that either bills a
 * customer for nothing or gives the product away, and it needs to be testable
 * exhaustively without standing up an application.
 */
import {
  SubscriptionPlan,
  SubscriptionStatus,
  type UsageMetric,
} from '@legaltech/database';
import { getPlan, type Limit } from '../plans/plan-catalog';

export type DenialReason =
  | 'QUOTA_EXCEEDED'
  | 'SUBSCRIPTION_UNPAID'
  | 'SUBSCRIPTION_CANCELED'
  | 'TRIAL_EXPIRED'
  | 'FEATURE_NOT_IN_PLAN';

export interface AccessDecision {
  allowed: boolean;
  reason?: DenialReason;
  /** Human-readable, safe to return to the caller. */
  message?: string;
}

export interface QuotaDecision extends AccessDecision {
  limit: Limit;
  used: number;
  /** Null when the metric is unmetered. */
  remaining: number | null;
}

export interface SubscriptionSnapshot {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  graceEndsAt?: Date | null;
}

/**
 * The plan a company is actually entitled to.
 *
 * A company with no subscription row is on Free — the absence of a record is a
 * normal state, not an error, and treating it as one would lock every new
 * signup out of the product before they ever reach a checkout page.
 */
export function effectivePlan(
  subscription: SubscriptionSnapshot | null | undefined,
): SubscriptionPlan {
  return subscription?.plan ?? SubscriptionPlan.FREE;
}

/**
 * Whether the subscription entitles the company to service at all.
 *
 * Checked before quota: a customer whose card has failed for three weeks is not
 * "within their limits", they are unpaid, and telling them they have 47
 * documents remaining is the wrong answer.
 */
export function evaluateSubscriptionAccess(
  subscription: SubscriptionSnapshot | null | undefined,
  now: Date = new Date(),
): AccessDecision {
  // No subscription record: implicit Free tier.
  if (!subscription) return { allowed: true };

  // Free is never gated on payment state — there is nothing to pay.
  if (subscription.plan === SubscriptionPlan.FREE) return { allowed: true };

  switch (subscription.status) {
    case SubscriptionStatus.ACTIVE:
      return { allowed: true };

    case SubscriptionStatus.TRIALING: {
      // A trial with no end date is an unbounded trial; that is a data problem,
      // not a reason to cut the customer off mid-session.
      if (!subscription.trialEndsAt || subscription.trialEndsAt > now) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'TRIAL_EXPIRED',
        message: 'Your trial has ended. Add a payment method to continue.',
      };
    }

    case SubscriptionStatus.PAST_DUE: {
      // Grace period: a failed charge is usually an expired card, and cutting
      // service instantly turns a billing hiccup into a churn event.
      if (subscription.graceEndsAt && subscription.graceEndsAt > now) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'SUBSCRIPTION_UNPAID',
        message: 'Payment failed and the grace period has ended. Update your payment method to continue.',
      };
    }

    case SubscriptionStatus.CANCELED: {
      // Cancelled but paid through the end of the period: the customer bought
      // this time and keeps it.
      if (subscription.currentPeriodEnd && subscription.currentPeriodEnd > now) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'SUBSCRIPTION_CANCELED',
        message: 'Your subscription has ended. Choose a plan to continue.',
      };
    }

    case SubscriptionStatus.UNPAID:
    case SubscriptionStatus.INCOMPLETE:
    default:
      return {
        allowed: false,
        reason: 'SUBSCRIPTION_UNPAID',
        message: 'Your subscription is not active. Update your billing details to continue.',
      };
  }
}

/**
 * Whether `requested` more units fit within the limit.
 *
 * `used` is the count *after* the caller's atomic reservation when called from
 * PlanLimitGuard — see UsageService.reserve. Passing pre-increment usage here
 * and comparing with `<` would leave the classic off-by-one where the 101st
 * request on a 100 limit succeeds.
 */
export function evaluateQuota(
  limit: Limit,
  used: number,
  requested = 1,
): QuotaDecision {
  if (limit === null) {
    return { allowed: true, limit: null, used, remaining: null };
  }

  // An explicit zero limit means the plan does not include the resource at all,
  // which is a different message from running out of it.
  if (limit === 0) {
    return {
      allowed: false,
      reason: 'FEATURE_NOT_IN_PLAN',
      message: 'Your plan does not include this feature.',
      limit,
      used,
      remaining: 0,
    };
  }

  const projected = used + requested;

  if (projected > limit) {
    return {
      allowed: false,
      reason: 'QUOTA_EXCEEDED',
      message: `You have used all ${limit} of this period's allowance. Upgrade your plan or wait for the next billing period.`,
      limit,
      used,
      remaining: Math.max(0, limit - used),
    };
  }

  return {
    allowed: true,
    limit,
    used: projected,
    remaining: limit - projected,
  };
}

/** Whether a plan includes a non-metered capability. */
export function hasFeature(
  plan: SubscriptionPlan,
  feature: keyof ReturnType<typeof getPlan>['features'],
): boolean {
  return getPlan(plan).features[feature];
}

/**
 * Metrics that measure a standing quantity rather than activity in a period.
 *
 * These are counted by querying the live table, not by an incrementing counter:
 * deleting a template must free a slot, whereas generating and deleting a
 * document still consumed the generation.
 */
export const STOCK_METRICS: UsageMetric[] = [
  'TEMPLATES',
  'SEATS',
] as UsageMetric[];

export function isStockMetric(metric: UsageMetric): boolean {
  return STOCK_METRICS.includes(metric);
}

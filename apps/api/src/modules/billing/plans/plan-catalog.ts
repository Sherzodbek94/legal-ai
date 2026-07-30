/**
 * The plan catalogue.
 *
 * Deliberately in code rather than in the database. Limits and prices are
 * product decisions that need to be reviewed, diffed, and rolled back like any
 * other behaviour change — a quota edited directly in production is invisible
 * in a way that a quota edited here is not.
 *
 * The consequence is that `Subscription.limitOverrides` exists for the one case
 * this cannot serve: negotiated Enterprise terms, which are per-customer and
 * would otherwise need a new plan (and a migration) per deal.
 */
import { SubscriptionPlan, UsageMetric } from '@legaltech/database';

/** `null` means unmetered. Zero means the feature is off, which is not the same. */
export type Limit = number | null;

export type PlanLimits = Record<UsageMetric, Limit>;

export interface PlanDefinition {
  plan: SubscriptionPlan;
  name: string;
  /** Minor units, per month. */
  monthlyPriceCents: number;
  /** Minor units, per year — normally a discount on 12x monthly. */
  annualPriceCents: number;
  currency: string;
  /** Days of free trial granted on first subscribe. 0 for no trial. */
  trialDays: number;
  limits: PlanLimits;
  /** Non-metered capabilities, for feature gating in the UI and API. */
  features: {
    aiGeneration: boolean;
    approvalWorkflows: boolean;
    customTemplates: boolean;
    apiAccess: boolean;
    prioritySupport: boolean;
    /** Removes the platform watermark from exported documents. */
    whiteLabelExports: boolean;
  };
}

/**
 * Ordering, cheapest first.
 *
 * Upgrade and downgrade decisions compare positions in this array, so it is the
 * authority on which direction a plan change goes — not the price, which can be
 * equal across plans during a promotion.
 */
export const PLAN_ORDER: SubscriptionPlan[] = [
  SubscriptionPlan.FREE,
  SubscriptionPlan.PRO,
  SubscriptionPlan.BUSINESS,
  SubscriptionPlan.ENTERPRISE,
];

export const PLAN_CATALOG: Record<SubscriptionPlan, PlanDefinition> = {
  [SubscriptionPlan.FREE]: {
    plan: SubscriptionPlan.FREE,
    name: 'Free',
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    currency: 'usd',
    trialDays: 0,
    limits: {
      // Enough to evaluate the product on real work, not enough to run a
      // practice on.
      [UsageMetric.DOCUMENTS_GENERATED]: 5,
      [UsageMetric.AI_GENERATIONS]: 5,
      [UsageMetric.TEMPLATES]: 3,
      [UsageMetric.SEATS]: 1,
    },
    features: {
      aiGeneration: true,
      approvalWorkflows: false,
      customTemplates: false,
      apiAccess: false,
      prioritySupport: false,
      whiteLabelExports: false,
    },
  },

  [SubscriptionPlan.PRO]: {
    plan: SubscriptionPlan.PRO,
    name: 'Pro',
    monthlyPriceCents: 4900,
    annualPriceCents: 49_000,
    currency: 'usd',
    trialDays: 14,
    limits: {
      [UsageMetric.DOCUMENTS_GENERATED]: 100,
      [UsageMetric.AI_GENERATIONS]: 100,
      [UsageMetric.TEMPLATES]: 50,
      [UsageMetric.SEATS]: 5,
    },
    features: {
      aiGeneration: true,
      approvalWorkflows: true,
      customTemplates: true,
      apiAccess: false,
      prioritySupport: false,
      whiteLabelExports: false,
    },
  },

  [SubscriptionPlan.BUSINESS]: {
    plan: SubscriptionPlan.BUSINESS,
    name: 'Business',
    monthlyPriceCents: 19_900,
    annualPriceCents: 199_000,
    currency: 'usd',
    trialDays: 14,
    limits: {
      [UsageMetric.DOCUMENTS_GENERATED]: 1000,
      [UsageMetric.AI_GENERATIONS]: 1000,
      [UsageMetric.TEMPLATES]: null,
      [UsageMetric.SEATS]: 25,
    },
    features: {
      aiGeneration: true,
      approvalWorkflows: true,
      customTemplates: true,
      apiAccess: true,
      prioritySupport: true,
      whiteLabelExports: true,
    },
  },

  [SubscriptionPlan.ENTERPRISE]: {
    plan: SubscriptionPlan.ENTERPRISE,
    name: 'Enterprise',
    // Priced per contract; the catalogue entry exists so the plan has limits
    // and features, not so it can be self-served.
    monthlyPriceCents: 49_900,
    annualPriceCents: 499_000,
    currency: 'usd',
    trialDays: 30,
    limits: {
      [UsageMetric.DOCUMENTS_GENERATED]: null,
      [UsageMetric.AI_GENERATIONS]: null,
      [UsageMetric.TEMPLATES]: null,
      [UsageMetric.SEATS]: null,
    },
    features: {
      aiGeneration: true,
      approvalWorkflows: true,
      customTemplates: true,
      apiAccess: true,
      prioritySupport: true,
      whiteLabelExports: true,
    },
  },
};

export function getPlan(plan: SubscriptionPlan): PlanDefinition {
  return PLAN_CATALOG[plan];
}

export function planRank(plan: SubscriptionPlan): number {
  return PLAN_ORDER.indexOf(plan);
}

export function isUpgrade(from: SubscriptionPlan, to: SubscriptionPlan): boolean {
  return planRank(to) > planRank(from);
}

/**
 * Effective limits for a subscription, applying any negotiated overrides.
 *
 * Overrides arrive as untrusted JSON from the database, so unknown keys are
 * ignored and non-numeric values fall back to the plan. An override of `null`
 * is meaningful — it lifts the limit — and is distinguished from absent.
 */
export function resolveLimits(
  plan: SubscriptionPlan,
  overrides?: unknown,
): PlanLimits {
  const base = { ...PLAN_CATALOG[plan].limits };

  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return base;
  }

  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(key in base)) continue;

    if (value === null) {
      base[key as UsageMetric] = null;
      continue;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      base[key as UsageMetric] = value;
    }
  }

  return base;
}

/** Public shape for the pricing page — no internal fields. */
export function publicPlanView(definition: PlanDefinition) {
  return {
    id: definition.plan,
    name: definition.name,
    monthlyPriceCents: definition.monthlyPriceCents,
    annualPriceCents: definition.annualPriceCents,
    currency: definition.currency,
    trialDays: definition.trialDays,
    limits: definition.limits,
    features: definition.features,
  };
}

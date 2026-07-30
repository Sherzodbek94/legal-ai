import { SetMetadata } from '@nestjs/common';
import type { UsageMetric } from '@legaltech/database';
import type { PlanDefinition } from '../plans/plan-catalog';

export const QUOTA_KEY = 'billing:quota';
export const FEATURE_KEY = 'billing:feature';

export interface QuotaRequirement {
  metric: UsageMetric;
  /** Units consumed by one call. Defaults to 1. */
  amount: number;
}

/**
 * Declares that a route consumes plan quota.
 *
 * PlanLimitGuard reserves the units *before* the handler runs and releases them
 * if it throws, so a route decorated with this only ever bills the customer for
 * work that succeeded.
 */
export const ConsumesQuota = (metric: UsageMetric, amount = 1) =>
  SetMetadata<string, QuotaRequirement>(QUOTA_KEY, { metric, amount });

/**
 * Declares that a route needs a non-metered plan capability.
 *
 * Separate from quota because the answer is different in kind: "not on your
 * plan" is a prompt to upgrade, while "out of quota" is a prompt to wait or
 * upgrade. Conflating them produces the upsell that tells a paying customer
 * their plan lacks a feature they already have.
 */
export const RequiresFeature = (feature: keyof PlanDefinition['features']) =>
  SetMetadata<string, keyof PlanDefinition['features']>(FEATURE_KEY, feature);

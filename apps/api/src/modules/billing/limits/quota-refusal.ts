import { ForbiddenException } from '@nestjs/common';
import type { UsageMetric } from '@legaltech/database';
import type { QuotaDecision } from './quota-policy';

/**
 * The refusal a caller gets when a plan limit is reached.
 *
 * Shared by PlanLimitGuard and by services that reserve quota directly, because
 * the frontend branches on this body — `reason` picks the message, `metric` and
 * `limit` fill the upgrade prompt. Two hand-rolled copies of this shape is how
 * one endpoint starts returning an upsell the client cannot render.
 *
 * 403 rather than 429: this is not rate limiting and will not resolve by
 * retrying later in the period. Only upgrading or waiting for renewal clears it.
 */
export function quotaRefusal(
  metric: UsageMetric,
  decision: QuotaDecision,
): ForbiddenException {
  return new ForbiddenException({
    message: decision.message ?? 'Plan limit reached',
    reason: decision.reason,
    metric,
    limit: decision.limit,
    used: decision.used,
    remaining: decision.remaining,
  });
}

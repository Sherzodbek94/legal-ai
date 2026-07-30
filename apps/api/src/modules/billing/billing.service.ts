import { Injectable } from '@nestjs/common';
import { SubscriptionPlan } from '@legaltech/database';
import {
  PLAN_CATALOG,
  PLAN_ORDER,
  getPlan,
  publicPlanView,
} from './plans/plan-catalog';
import { SubscriptionService } from './subscription/subscription.service';
import { UsageService } from './limits/usage.service';

@Injectable()
export class BillingService {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly usage: UsageService,
  ) {}

  /** The pricing page. Public — it must be readable before anyone signs up. */
  getPlans() {
    return PLAN_ORDER.map((plan) => publicPlanView(PLAN_CATALOG[plan]));
  }

  getPlanDetail(plan: SubscriptionPlan) {
    return publicPlanView(getPlan(plan));
  }

  /**
   * Everything the billing screen needs, in one call.
   *
   * Assembled server-side rather than left to three round trips: entitlement,
   * usage, and invoices are always rendered together, and fetching them
   * separately guarantees a moment where the page shows a plan next to the
   * previous plan's usage.
   */
  async getOverview(companyId: string) {
    const [entitlement, usage, transactions] = await Promise.all([
      this.subscriptions.getEntitlement(companyId),
      this.usage.getUsageSummary(companyId),
      this.subscriptions.listTransactions(companyId, 12),
    ]);

    return {
      subscription: {
        plan: entitlement.plan,
        planName: entitlement.definition.name,
        status: entitlement.status,
        currentPeriodEnd: entitlement.currentPeriodEnd,
        trialEndsAt: entitlement.trialEndsAt,
        cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
        graceEndsAt: entitlement.graceEndsAt,
      },
      features: entitlement.definition.features,
      usage,
      recentTransactions: transactions,
    };
  }
}

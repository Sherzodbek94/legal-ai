import { Injectable } from '@nestjs/common';

export interface BillingPlan {
  id: string;
  name: string;
  monthlyPriceUsd: number;
}

@Injectable()
export class BillingService {
  private readonly plans: BillingPlan[] = [
    { id: 'starter', name: 'Starter', monthlyPriceUsd: 49 },
    { id: 'professional', name: 'Professional', monthlyPriceUsd: 199 },
    { id: 'enterprise', name: 'Enterprise', monthlyPriceUsd: 499 },
  ];

  getPlans(): BillingPlan[] {
    return this.plans;
  }
}

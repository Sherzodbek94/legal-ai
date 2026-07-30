import { IsEnum, IsIn, IsOptional } from 'class-validator';
import { PaymentProvider, SubscriptionPlan } from '@legaltech/database';

export class CreateOrderDto {
  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan;

  /**
   * Gateway the customer intends to use. Advisory only — the order is not
   * locked to it until a gateway actually claims it, so a customer who changes
   * their mind at the checkout screen is not stuck.
   */
  @IsOptional()
  @IsIn([
    PaymentProvider.CLICK,
    PaymentProvider.PAYME,
    PaymentProvider.UZUM,
    PaymentProvider.STRIPE,
  ])
  provider?: PaymentProvider;
}

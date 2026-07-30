import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SubscriptionPlan } from '@legaltech/database';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class ChangePlanDto {
  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan;

  /** Optional promo code applied as part of the same change. */
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(40)
  couponCode?: string;
}

export class CancelSubscriptionDto {
  /**
   * Forfeits the remainder of the paid period. Defaults to false so a
   * mis-clicked button schedules a cancellation rather than destroying time the
   * customer already bought.
   */
  @IsOptional()
  @IsBoolean()
  immediately?: boolean;
}

export class ApplyCouponDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  code!: string;
}

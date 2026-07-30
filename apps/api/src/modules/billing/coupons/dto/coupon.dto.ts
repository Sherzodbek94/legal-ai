import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  CouponDiscountType,
  CouponDuration,
  SubscriptionPlan,
} from '@legaltech/database';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateCouponDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'Code may contain letters, digits, hyphens, and underscores only',
  })
  code!: string;

  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsEnum(CouponDiscountType)
  discountType!: CouponDiscountType;

  // Exactly one of the two amounts applies, decided by `discountType`.
  @ValidateIf((dto: CreateCouponDto) => dto.discountType === CouponDiscountType.PERCENTAGE)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  percentOff?: number;

  @ValidateIf(
    (dto: CreateCouponDto) => dto.discountType === CouponDiscountType.FIXED_AMOUNT,
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountOffCents?: number;

  @IsOptional()
  @trim()
  @IsString()
  @Matches(/^[a-z]{3}$/, { message: 'Currency must be a lowercase ISO 4217 code' })
  currency?: string;

  @IsEnum(CouponDuration)
  duration!: CouponDuration;

  @ValidateIf((dto: CreateCouponDto) => dto.duration === CouponDuration.REPEATING)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  durationInMonths?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @IsOptional()
  @IsArray()
  @IsEnum(SubscriptionPlan, { each: true })
  appliesToPlans?: SubscriptionPlan[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minAmountCents?: number;

  @IsOptional()
  @IsBoolean()
  firstTimeOnly?: boolean;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validUntil?: Date;
}

/** Checkout-time preview: "what would this code do to my order?" */
export class PreviewCouponDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  code!: string;

  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan;

  @IsOptional()
  @trim()
  @IsString()
  @Matches(/^[a-z]{3}$/)
  currency?: string;
}

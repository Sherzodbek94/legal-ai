-- ---------------------------------------------------------------------------
-- Subscription and Limits System
--
-- Renames the commercial tiers, adds per-period usage metering, and adds
-- promotional coupons.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Plan rename: STARTER/PROFESSIONAL/ENTERPRISE -> FREE/PRO/BUSINESS/ENTERPRISE
--
-- PostgreSQL cannot drop a value from an enum, so the type is rebuilt and the
-- column rewritten through an explicit mapping. Doing this as ADD VALUE + a
-- data update would leave the retired labels in the type forever, where they
-- stay assignable and eventually get assigned.
--
-- Mapping is by price point, not by name: the old STARTER was a paid entry tier
-- and becomes PRO; PROFESSIONAL becomes BUSINESS. No existing row maps to FREE,
-- which is new and is only the default for subscriptions created from here on.
-- ---------------------------------------------------------------------------
CREATE TYPE "SubscriptionPlan_new" AS ENUM ('FREE', 'PRO', 'BUSINESS', 'ENTERPRISE');

ALTER TABLE "subscriptions" ALTER COLUMN "plan" DROP DEFAULT;

ALTER TABLE "subscriptions"
    ALTER COLUMN "plan" TYPE "SubscriptionPlan_new"
    USING (
        CASE "plan"::text
            WHEN 'STARTER'      THEN 'PRO'
            WHEN 'PROFESSIONAL' THEN 'BUSINESS'
            WHEN 'ENTERPRISE'   THEN 'ENTERPRISE'
        END
    )::"SubscriptionPlan_new";

DROP TYPE "SubscriptionPlan";
ALTER TYPE "SubscriptionPlan_new" RENAME TO "SubscriptionPlan";

ALTER TABLE "subscriptions" ALTER COLUMN "plan" SET DEFAULT 'FREE';

-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM ('DOCUMENTS_GENERATED', 'AI_GENERATIONS', 'TEMPLATES', 'SEATS');

-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "CouponDuration" AS ENUM ('ONCE', 'REPEATING', 'FOREVER');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "limitOverrides" JSONB,
                            ADD COLUMN "graceEndsAt" TIMESTAMP(3),
                            ADD COLUMN "renewalAttempts" INTEGER NOT NULL DEFAULT 0,
                            ADD COLUMN "lastRenewalError" TEXT;

-- AlterTable
ALTER TABLE "payment_transactions" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0,
                                   ADD COLUMN "couponCode" TEXT;

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "CouponDiscountType" NOT NULL,
    "percentOff" INTEGER,
    "amountOffCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "duration" "CouponDuration" NOT NULL DEFAULT 'ONCE',
    "durationInMonths" INTEGER,
    "maxRedemptions" INTEGER,
    "timesRedeemed" INTEGER NOT NULL DEFAULT 0,
    "appliesToPlans" "SubscriptionPlan"[],
    "minAmountCents" INTEGER,
    "firstTimeOnly" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "discountCents" INTEGER NOT NULL,
    "periodsRemaining" INTEGER,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_counters_companyId_periodEnd_idx" ON "usage_counters"("companyId", "periodEnd");

-- CreateIndex
-- Also the conflict target for the atomic increment in UsageService.
CREATE UNIQUE INDEX "usage_counters_companyId_metric_periodStart_key" ON "usage_counters"("companyId", "metric", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_active_validUntil_idx" ON "coupons"("active", "validUntil");

-- CreateIndex
CREATE INDEX "coupon_redemptions_companyId_redeemedAt_idx" ON "coupon_redemptions"("companyId", "redeemedAt");

-- CreateIndex
-- Enforces "one redemption per company per coupon" against concurrent
-- checkouts, which a SELECT-then-INSERT count check cannot.
CREATE UNIQUE INDEX "coupon_redemptions_couponId_companyId_key" ON "coupon_redemptions"("couponId", "companyId");

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

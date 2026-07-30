-- ---------------------------------------------------------------------------
-- Payment gateways
--
-- Adds payable orders, per-gateway transaction records, and idempotency
-- caching for replayed webhooks.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('CLICK', 'PAYME', 'UZUM', 'STRIPE', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PAID', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProviderTransactionState" AS ENUM ('CREATED', 'PERFORMED', 'CANCELED', 'REVERSED');

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "plan" "SubscriptionPlan",
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "provider" "PaymentProvider",
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_transactions" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "state" "ProviderTransactionState" NOT NULL DEFAULT 'CREATED',
    "reason" INTEGER,
    "createdTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedTime" TIMESTAMP(3),
    "canceledTime" TIMESTAMP(3),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "payment_transactions" ADD COLUMN "provider" "PaymentProvider",
                                   ADD COLUMN "orderId" TEXT;

-- CreateIndex
CREATE INDEX "payment_orders_companyId_status_createdAt_idx" ON "payment_orders"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_orders_status_expiresAt_idx" ON "payment_orders"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "provider_transactions_orderId_state_idx" ON "provider_transactions"("orderId", "state");

-- CreateIndex
CREATE INDEX "provider_transactions_state_createdTime_idx" ON "provider_transactions"("state", "createdTime");

-- CreateIndex
-- The structural defence against double-billing: a retried webhook cannot
-- insert a second row for the same gateway transaction, which forces the
-- handler onto the "already processed" path instead of charging again.
CREATE UNIQUE INDEX "provider_transactions_provider_providerTransactionId_key" ON "provider_transactions"("provider", "providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_key_key" ON "idempotency_records"("key");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE INDEX "payment_transactions_orderId_idx" ON "payment_transactions"("orderId");

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "payment_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

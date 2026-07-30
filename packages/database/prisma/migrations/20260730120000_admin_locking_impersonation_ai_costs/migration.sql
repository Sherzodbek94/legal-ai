-- ---------------------------------------------------------------------------
-- Admin module
--
-- Adds administrative locks on users and companies, per-call AI cost records,
-- and audited impersonation sessions.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "users" ADD COLUMN "lockedAt" TIMESTAMP(3),
                    ADD COLUMN "lockedReason" TEXT,
                    ADD COLUMN "lockedById" TEXT;

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "lockedAt" TIMESTAMP(3),
                        ADD COLUMN "lockedReason" TEXT,
                        ADD COLUMN "lockedById" TEXT;

-- CreateTable
CREATE TABLE "ai_usage_records" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" TEXT NOT NULL,
    "impersonatorId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "targetCompanyId" TEXT,
    "reason" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_records_companyId_createdAt_idx" ON "ai_usage_records"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_records_createdAt_idx" ON "ai_usage_records"("createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_records_model_createdAt_idx" ON "ai_usage_records"("model", "createdAt");

-- CreateIndex
-- One token per session: binds a single JWT `jti` to this row, so a second
-- token cannot ride an existing impersonation and revoking the row kills it.
CREATE UNIQUE INDEX "impersonation_sessions_jti_key" ON "impersonation_sessions"("jti");

-- CreateIndex
CREATE INDEX "impersonation_sessions_impersonatorId_startedAt_idx" ON "impersonation_sessions"("impersonatorId", "startedAt");

-- CreateIndex
CREATE INDEX "impersonation_sessions_targetUserId_startedAt_idx" ON "impersonation_sessions"("targetUserId", "startedAt");

-- CreateIndex
CREATE INDEX "impersonation_sessions_expiresAt_idx" ON "impersonation_sessions"("expiresAt");

-- AddForeignKey
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_impersonatorId_fkey" FOREIGN KEY ("impersonatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Partial indexes for the lock sweeps.
--
-- Locked accounts are a small minority of rows, so a partial index over just
-- those is a fraction of the size of a full one and is what the admin listing
-- filters on. Prisma cannot express a WHERE clause on an index.
-- ---------------------------------------------------------------------------
CREATE INDEX "users_locked_idx" ON "users"("lockedAt") WHERE "lockedAt" IS NOT NULL;
CREATE INDEX "companies_locked_idx" ON "companies"("lockedAt") WHERE "lockedAt" IS NOT NULL;

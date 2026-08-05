-- ---------------------------------------------------------------------------
-- Company invitations
--
-- `CompanyMember` is keyed on `userId`, so it cannot represent an invitation to
-- someone who has no account yet — which is the ordinary case. This table holds
-- the pending state; the `CompanyMember` row is written at acceptance.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "company_invitations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "CompanyMemberRole" NOT NULL DEFAULT 'ATTORNEY',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_invitations_tokenHash_key" ON "company_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "company_invitations_companyId_email_idx" ON "company_invitations"("companyId", "email");

-- CreateIndex
CREATE INDEX "company_invitations_expiresAt_idx" ON "company_invitations"("expiresAt");

-- One LIVE invitation per address per company.
--
-- Partial, so withdrawing or accepting an invitation frees the address to be
-- invited again. Prisma's schema language cannot express a filtered unique
-- index, so it is declared here and the model carries only the plain index.
-- Enforcing it in the database rather than by check-then-insert is what makes
-- two simultaneous invites resolve to one row instead of both succeeding.
CREATE UNIQUE INDEX "company_invitations_live_email_key"
    ON "company_invitations"("companyId", "email")
    WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Inviter is retained on their deletion: accountability outlives an employee,
-- the same rule `users.lockedById` follows.
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

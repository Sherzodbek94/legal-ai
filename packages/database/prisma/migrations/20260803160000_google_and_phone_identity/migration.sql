-- ---------------------------------------------------------------------------
-- Google and phone as sign-in identities
--
-- Both follow the rule `oneIdSubject` already established: bind the provider's
-- own stable identifier, never trust the email address alone. `phone` is a
-- login identifier in its own right, so it is unique — two accounts sharing a
-- number would make "whose account does this SMS code open" unanswerable.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "users" ADD COLUMN "googleSubject" TEXT;
ALTER TABLE "users" ADD COLUMN "phone" TEXT;
ALTER TABLE "users" ADD COLUMN "phoneVerified" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_googleSubject_key" ON "users"("googleSubject");
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

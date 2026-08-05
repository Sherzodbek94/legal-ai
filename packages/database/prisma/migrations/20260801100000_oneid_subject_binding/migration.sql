-- ---------------------------------------------------------------------------
-- OneID subject binding
--
-- Prevents an email collision between a password-based account and a OneID
-- identity from silently authenticating as the wrong user: once a user has
-- signed in through OneID, subsequent OneID logins must match this value.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "users" ADD COLUMN "oneIdSubject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_oneIdSubject_key" ON "users"("oneIdSubject");

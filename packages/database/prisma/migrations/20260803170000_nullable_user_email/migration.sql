-- ---------------------------------------------------------------------------
-- `users.email` becomes optional
--
-- SMS sign-in provisions an account from a phone number alone, and that account
-- genuinely has no email address until the user supplies one. Requiring a
-- placeholder instead would put a fake address in the column that notifications
-- would then try to deliver to.
--
-- Postgres permits any number of NULLs under a unique index, so the address
-- stays a unique identifier for every account that has one.
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

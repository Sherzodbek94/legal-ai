/**
 * Per-suite environment.
 *
 * `globalSetup` runs in a separate process, so the variables it sets do not
 * reach the worker that actually runs the tests. They are re-established here.
 */
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';

/**
 * The repo's own `.env`, for the services the suite talks to for real.
 *
 * `dotenv` never overwrites a variable that is already set, so an explicit
 * `REDIS_URL=… npm run test:e2e` still wins, and `DATABASE_URL` is forced to
 * the test database below regardless of what the file says.
 *
 * Without this the defaults below applied, and `redis://localhost:6379` is not
 * where Redis is on every machine: on Windows that port frequently falls inside
 * a Hyper-V reserved range, so compose publishes it elsewhere (`REDIS_PORT`).
 * The readiness suite — the one test that exercises the real Redis rather than
 * a fake — then failed with a 503 that looked like an application fault.
 */
loadEnv({ path: path.join(__dirname, '../../../.env') });

process.env.NODE_ENV = 'test';
// Always the test database, never whatever `.env` points development at: the
// suite truncates between tests.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5433/legaltech_test?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??=
  'e2e-jwt-secret-long-enough-for-validation-xxxxx';
process.env.DOCUMENT_VERIFICATION_SECRET ??=
  'e2e-document-verification-secret-long-enough-xx';
process.env.SHUTDOWN_DRAIN_SECONDS = '0';

// Long enough for a cold Nest boot, which connects to Postgres and Redis before
// the first test body runs.
jest.setTimeout(30_000);

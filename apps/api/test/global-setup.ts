/**
 * Prepares the e2e database once, before any suite runs.
 *
 * This is the layer the unit tests cannot reach. Everything under `src/**` runs
 * against in-memory fakes, which means the hand-written SQL in the migrations —
 * the generated `tsvector` column, the HNSW vector indexes, the partial unique
 * index on the global taxonomy, the enum rebuild — has never actually executed.
 * Running `migrate deploy` here is what proves it does.
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';

/**
 * A SEPARATE database from development, on port 5433.
 *
 * The suite truncates between tests. Pointing this at the development database
 * would silently destroy whatever the developer was working with, and the
 * failure mode is "my seed data vanished" hours later.
 */
const DEFAULT_TEST_URL =
  'postgresql://postgres:postgres@localhost:5433/legaltech_test?schema=public';

export default async function globalSetup(): Promise<void> {
  // The repo's `.env`, so the suite reaches the services compose actually
  // published — see the note in setup-after-env.ts. Never overrides anything
  // already set, and DATABASE_URL is forced to the test database below.
  loadEnv({ path: path.join(__dirname, '../../../.env') });

  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;

  // Set for every worker and for the Prisma CLI invocations below.
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';

  // Minimum viable secrets. Both have length checks in code and the application
  // refuses to boot without them.
  process.env.JWT_ACCESS_SECRET ??= 'e2e-jwt-secret-long-enough-for-validation-xxxxx';
  process.env.DOCUMENT_VERIFICATION_SECRET ??=
    'e2e-document-verification-secret-long-enough-xx';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  // No drain delay in tests; see ShutdownService.
  process.env.SHUTDOWN_DRAIN_SECONDS = '0';

  const schema = path.join(__dirname, '../../../packages/database/prisma/schema.prisma');

  assertReachable(url);

  console.log('\n[e2e] applying migrations to the test database…');

  try {
    // `migrate reset --force` rather than `migrate deploy`: it drops and rebuilds
    // from zero, so a suite never inherits state from a previous run and the
    // migrations are exercised from an empty database every time — which is the
    // only way the first migration's `CREATE EXTENSION vector` is ever tested.
    execSync(
      `npx prisma migrate reset --force --skip-generate --skip-seed --schema "${schema}"`,
      { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
    );
  } catch {
    throw new Error(
      `Could not migrate the e2e database at ${redact(url)}.\n` +
        'Start it with:  docker compose up -d postgres-test\n' +
        'It must be the pgvector image — the schema needs the vector extension.',
    );
  }

  console.log('[e2e] test database ready\n');
}

/**
 * Fails fast with an actionable message.
 *
 * Without this the first symptom is a Prisma connection error inside an
 * unrelated test, which reads as a broken test rather than a missing container.
 */
function assertReachable(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${redact(url)}`);
  }

  if (parsed.port === '5432') {
    // The development database. Refused rather than warned: the suite truncates
    // tables, and a warning nobody reads is not a safeguard.
    throw new Error(
      'The e2e database is pointed at port 5432, which is the development ' +
        'database. The suite truncates tables. Use port 5433 ' +
        '(docker compose up -d postgres-test).',
    );
  }
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***:***@');
}

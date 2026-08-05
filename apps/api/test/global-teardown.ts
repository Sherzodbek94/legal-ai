/**
 * Runs once after every e2e suite.
 *
 * The test database is deliberately left in place rather than dropped: when a
 * suite fails, being able to open the database and look at what it left behind is
 * the fastest way to understand why. `globalSetup` resets it on the next run, so
 * nothing leaks between runs.
 */
export default async function globalTeardown(): Promise<void> {
  // Nothing to close here — each suite closes its own Nest application, and the
  // container is managed by docker compose rather than by the test run.
}

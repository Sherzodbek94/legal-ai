import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end browser tests.
 *
 *     npm run test:e2e:ui        # headed, for writing and debugging
 *     npm run test:e2e:browser   # headless, what CI runs
 *
 * These cover what only a real browser reveals: cookie `sameSite` behaviour
 * across origins, credentialed CORS, WebSocket upgrade, and — specific to this
 * product — whether Cyrillic and Uzbek text actually renders in a generated PDF
 * rather than coming out as empty boxes.
 *
 * PREREQUISITES:
 *     docker compose up -d
 *     npm run db:migrate && npm run db:seed
 *     npm run dev            (or let webServer below start it)
 */
export default defineConfig({
  testDir: './tests/e2e',
  // PDF generation runs Chromium server-side and OCR runs Tesseract; both are
  // slow enough that the 30s default fails on a cold cache rather than on a bug.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  // Serial locally. The suite signs in as shared seeded accounts and asserts on
  // their data, so parallel workers would race each other's state.
  fullyParallel: false,
  workers: 1,

  // A test that only passes on retry is a flaky test, and marking it that way in
  // CI is more useful than letting it fail the build intermittently.
  retries: process.env.CI ? 2 : 0,

  // Never let a `.only` reach CI and silently skip the rest of the suite.
  forbidOnly: Boolean(process.env.CI),

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    // Artefacts only for failures — traces are large and a passing run produces
    // nothing worth keeping.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Explicit: the app is Uzbek/Russian, and a browser defaulting to en-US can
    // change date and number rendering in ways an assertion then misses.
    locale: 'en-GB',
    timezoneId: 'Asia/Tashkent',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Firefox is included deliberately: its cookie handling is stricter than
    // Chromium's, and a `sameSite` misconfiguration frequently shows up there
    // first.
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  /**
   * Starts the stack if it is not already running.
   *
   * `reuseExistingServer` off in CI so a stale process cannot make a run pass
   * against the wrong build; on locally so an already-running `npm run dev` is
   * not duplicated.
   *
   * The API gets `THROTTLE_DISABLED`: this suite signs in far more often than a
   * person does and otherwise trips the 5-per-minute login throttle, which
   * surfaces as four unrelated-looking login failures. `app.module.ts` refuses
   * the switch outright when `NODE_ENV=production`.
   *
   * A server this run did NOT start does not get it — reuse means reusing that
   * process's environment too. Start one with `npm run dev:e2e` if you want to
   * keep a stack up across runs.
   */
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : [
        {
          command: 'npm run dev --workspace=@legaltech/api',
          url: 'http://localhost:4000/health/ready',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { THROTTLE_DISABLED: 'true' },
        },
        {
          command: 'npm run dev --workspace=@legaltech/web',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});

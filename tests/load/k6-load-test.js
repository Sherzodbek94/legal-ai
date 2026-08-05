/**
 * Load profile: 200 concurrent users, p95 under 500ms.
 *
 *     k6 run tests/load/k6-load-test.js
 *     k6 run -e BASE_URL=https://staging.example.com tests/load/k6-load-test.js
 *
 * k6 is a standalone binary, not an npm package — it runs its own Go-based JS
 * runtime, so this file is deliberately dependency-free and is not part of the
 * Jest suite.
 *
 * Install:  https://k6.io/docs/get-started/installation/
 *
 * PREREQUISITE: the API must be seeded (`npm run db:seed`). The script signs in
 * as the seeded owner; without it every authenticated request 401s and the
 * results measure nothing but the login endpoint's error path.
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const EMAIL = __ENV.LOAD_EMAIL || 'owner@acme-legal.uz';
const PASSWORD = __ENV.LOAD_PASSWORD || 'DemoPassw0rd!';

/**
 * Separate trends for read paths and for deliberately slow ones.
 *
 * Document export runs Chromium and OCR runs Tesseract; both legitimately take
 * seconds. Folding them into one p95 makes the number meaningless — it would
 * measure how many PDFs were requested rather than whether the API is healthy.
 */
const readLatency = new Trend('read_latency', true);
const authLatency = new Trend('auth_latency', true);
const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    // Ramp rather than a step to 200: an instant 200-VU step measures cold
    // start — empty connection pools, unwarmed JIT, no Prisma pool — which is a
    // real thing to test but a different one from steady-state capacity.
    steady_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },  // warm up
        { duration: '30s', target: 200 }, // ramp to target
        { duration: '2m', target: 200 },  // hold — this is the measurement
        { duration: '30s', target: 0 },   // ramp down
      ],
      gracefulRampDown: '30s',
    },
  },

  thresholds: {
    // The requirement: p95 under 500ms on read paths.
    read_latency: ['p(95)<500'],

    // Login runs bcrypt at cost 12, which is ~250ms of deliberate CPU work per
    // call. Holding it to 500ms would be asking for the password hashing to be
    // weakened, which is the opposite of what anyone should want.
    auth_latency: ['p(95)<1500'],

    errors: ['rate<0.01'],
    // Aborts the run early if it is clearly failing, rather than burning four
    // minutes to confirm it.
    http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }],
  },
};

/**
 * Signs in once per VU and reuses the cookie.
 *
 * `setup()` would share one session across all 200 VUs, which is unrealistic and
 * also serialises them behind one rate-limit bucket. Per-VU login costs a bcrypt
 * hash each but produces a profile that resembles real traffic.
 */
export function setup() {
  const response = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (response.status !== 200) {
    throw new Error(
      `Setup login failed (${response.status}). Is the API running and seeded? ` +
        `Run: docker compose up -d && npm run db:migrate && npm run db:seed`,
    );
  }

  return { ready: true };
}

export default function () {
  const jar = http.cookieJar();

  group('auth', () => {
    const start = Date.now();
    const response = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({ email: EMAIL, password: PASSWORD }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'POST /auth/login' },
      },
    );
    authLatency.add(Date.now() - start);

    const ok = check(response, {
      'login 200': (r) => r.status === 200,
      'sets access cookie': (r) => String(r.headers['Set-Cookie'] ?? '').includes('access_token'),
    });
    errorRate.add(!ok);
  });

  // Cookies are held by the VU's jar and sent automatically from here on.
  const authed = { cookies: jar.cookiesForURL(BASE_URL) };

  group('read paths', () => {
    // The endpoints a logged-in user actually hits on every page load. These are
    // what the 500ms budget is about.
    const requests = [
      ['GET /auth/me', `${BASE_URL}/api/auth/me`],
      ['GET /documents', `${BASE_URL}/api/documents`],
      ['GET /billing/overview', `${BASE_URL}/api/billing/overview`],
      ['GET /billing/usage', `${BASE_URL}/api/billing/usage`],
      ['GET /taxonomy/tree', `${BASE_URL}/api/taxonomy/tree`],
      ['GET /notifications/unread-count', `${BASE_URL}/api/notifications/unread-count`],
    ];

    for (const [name, url] of requests) {
      const start = Date.now();
      const response = http.get(url, { ...authed, tags: { name } });
      readLatency.add(Date.now() - start);

      const ok = check(response, { [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
      errorRate.add(!ok);
    }
  });

  group('search', () => {
    // Lexical mode only. Hybrid mode spends an OpenAI embedding call per query —
    // at 200 VUs that is thousands of billable calls and it measures OpenAI's
    // latency rather than ours.
    const start = Date.now();
    const response = http.get(
      `${BASE_URL}/api/search?q=shartnoma&mode=lexical&limit=10`,
      { ...authed, tags: { name: 'GET /search' } },
    );
    readLatency.add(Date.now() - start);

    errorRate.add(!check(response, { 'search 2xx': (r) => r.status < 300 }));
  });

  group('health', () => {
    // Unauthenticated, and the endpoint the kubelet hits. If this degrades under
    // load, Kubernetes starts removing healthy pods from the Service — load
    // becomes an outage.
    const response = http.get(`${BASE_URL}/health/ready`, {
      tags: { name: 'GET /health/ready' },
    });

    errorRate.add(
      !check(response, {
        'ready 200': (r) => r.status === 200,
        'ready under 200ms': (r) => r.timings.duration < 200,
      }),
    );
  });

  // Think time. Without it every VU is a tight loop, which measures how fast the
  // server can reject a hammering rather than how it behaves under 200 users.
  sleep(Math.random() * 2 + 1);
}

export function handleSummary(data) {
  const read = data.metrics.read_latency?.values ?? {};
  const auth = data.metrics.auth_latency?.values ?? {};
  const failed = data.metrics.http_req_failed?.values?.rate ?? 0;

  const line = (label, value) => `  ${label.padEnd(28)} ${value}`;

  const summary = [
    '',
    '=== Load test summary ===',
    '',
    line('Read p95', `${(read['p(95)'] ?? 0).toFixed(0)}ms   (budget 500ms)`),
    line('Read p99', `${(read['p(99)'] ?? 0).toFixed(0)}ms`),
    line('Auth p95', `${(auth['p(95)'] ?? 0).toFixed(0)}ms   (budget 1500ms, bcrypt-bound)`),
    line('Failed requests', `${(failed * 100).toFixed(2)}%`),
    line('Peak VUs', `${data.metrics.vus_max?.values?.max ?? 0}`),
    '',
    (read['p(95)'] ?? Infinity) < 500
      ? '  PASS — read p95 within budget'
      : '  FAIL — read p95 over 500ms',
    '',
  ].join('\n');

  return {
    stdout: summary,
    // Machine-readable output, for tracking the trend across runs rather than
    // eyeballing one.
    'tests/load/summary.json': JSON.stringify(data, null, 2),
  };
}

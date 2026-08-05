/**
 * API location, safe to import from anywhere.
 *
 * Deliberately separate from `lib/api.ts`: that module imports `next/headers` to
 * forward the auth cookie, which makes it server-only and unbundleable into a
 * client component. Client components need the base URL and nothing else, so it
 * lives here on its own.
 *
 * `NEXT_PUBLIC_` prefix is required — the value is read in the browser, where a
 * server-only env var would be undefined.
 *
 * MUST INCLUDE THE `/api` PREFIX. The NestJS application is mounted under a
 * global `/api` prefix (see apps/api/src/main.ts), and the production Ingress
 * routes `/api` to it on the same origin. Omitting it makes every request 404 —
 * the page still renders, so it presents as "all the panels are broken" rather
 * than as a configuration error.
 */
const RAW = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

/**
 * Normalised base URL: no trailing slash, and the `/api` prefix guaranteed.
 *
 * The prefix is appended when missing rather than trusted, because this value
 * comes from an environment variable set in four different places (local .env,
 * the Dockerfile build arg, CI, and the Kubernetes manifest) and getting it wrong
 * in any one of them breaks that environment silently.
 */
export const apiBaseUrl = normalise(RAW);

function normalise(url: string): string {
  const trimmed = url.replace(/\/+$/, '');

  // Health and metrics are excluded from the prefix, but the frontend never
  // calls those — every path it uses is a prefixed application route.
  if (/\/api$/.test(trimmed)) return trimmed;

  return `${trimmed}/api`;
}

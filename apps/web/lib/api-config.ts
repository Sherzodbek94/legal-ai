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
 */
export const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

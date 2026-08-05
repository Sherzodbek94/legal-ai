/**
 * Coerces numeric settings out of the environment.
 *
 * `ConfigService.get<number>('X')` is a TypeScript assertion, not a runtime
 * conversion: everything in `process.env` is a string, so the generic lies and
 * the caller gets `"3"` where it believes it has `3`. The failure is delayed
 * and confusing — the value flows through arithmetic and comparisons that
 * silently coerce, until something type-checked rejects it. In this codebase it
 * first surfaced as Prisma refusing an OCR poll query with "Argument `lt`:
 * Expected Int, provided String", from a config value read three layers away.
 *
 * The defaults in the `config.get<number>(key, fallback)` call sites are real
 * numbers, so this only bites when a key IS present in `.env` — which is why it
 * stayed hidden until the API actually started reading the repository's `.env`.
 *
 * Registered via `load`, so these parsed values are found ahead of the raw
 * strings in `process.env`.
 *
 * KEEP IN SYNC: every key read with `config.get<number>(...)` belongs here.
 *     grep -rho "get<number>('[A-Z_0-9]*'" apps/api/src | sort -u
 *
 * Coercion is by explicit key rather than "anything that looks like a number",
 * because settings that are legitimately digit-strings exist — `ESKIZ_FROM` is
 * an SMS sender id of `4546`, and turning that into an integer would be wrong.
 */
const NUMERIC_KEYS = [
  'AI_MAX_TOKENS',
  'AI_TEMPERATURE',
  'BILLING_GRACE_PERIOD_DAYS',
  'BILLING_MAX_RENEWAL_ATTEMPTS',
  'BILLING_RENEWAL_BATCH_SIZE',
  'BILLING_USAGE_RETENTION_DAYS',
  'COMPANY_ASSET_MAX_BYTES',
  'DOCUMENT_VERIFICATION_MAX_AGE_SECONDS',
  'INVITATION_TTL_DAYS',
  'OCR_BATCH_SIZE',
  'OCR_MAX_ATTEMPTS',
  'OCR_MAX_CONCURRENT',
  'OCR_MAX_PDF_PAGES',
  'OCR_PDF_RASTER_DPI',
  'OTP_CODE_LENGTH',
  'OTP_MAX_ATTEMPTS',
  'OTP_MAX_SENDS_PER_HOUR',
  'OTP_RESEND_COOLDOWN_SECONDS',
  'OTP_TTL_SECONDS',
  'PAYMENT_ORDER_TTL_MS',
  'PDF_LAUNCH_TIMEOUT_MS',
  'PDF_MAX_CONCURRENT_PAGES',
  'PDF_RENDER_TIMEOUT_MS',
  'REFRESH_TOKEN_TTL_DAYS',
  'SHUTDOWN_DRAIN_SECONDS',
  'SMTP_MAX_CONNECTIONS',
  'SMTP_PORT',
  'THROTTLE_LIMIT',
  'THROTTLE_TTL',
] as const;

export function numericConfig(): Record<string, number> {
  const parsed: Record<string, number> = {};

  for (const key of NUMERIC_KEYS) {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') continue;

    const value = Number(raw);
    if (Number.isNaN(value)) {
      // Left unparsed rather than silently defaulted: the call site's own
      // fallback then applies, and a typo'd value should not masquerade as a
      // deliberate one.
      continue;
    }

    parsed[key] = value;
  }

  return parsed;
}

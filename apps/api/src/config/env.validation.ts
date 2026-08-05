import { z } from 'zod';

/**
 * Environment validation, run once at boot.
 *
 * The failure this prevents is the delayed one. Without it a typo'd
 * `PAYME_MERCHANT_KEY` costs nothing at startup, passes every health check, and
 * surfaces weeks later as a customer's payment callback being rejected — at
 * which point the deployment that introduced it is long merged. Every check
 * here turns that into a pod that refuses to start.
 *
 * Three kinds of rule, in rough order of how often each one actually fires:
 *
 *   1. **Partial integrations.** A provider configured with two of its three
 *      credentials. The affected feature reports itself unconfigured and
 *      disappears from the UI, which reads as "we didn't build that yet"
 *      rather than as a mistake.
 *   2. **Values outside the range something downstream requires.** These are
 *      couplings that live in two files and drift — `OTP_CODE_LENGTH` against
 *      the 4-8 digits the SMS templates accept, for instance.
 *   3. **Placeholders left in production.** The example secrets are in the
 *      repository, so shipping one is shipping a public key.
 *
 * Deliberately NOT a transformation. `validate` hands back exactly what it was
 * given: coercion belongs in `numericConfig`, and having two places that
 * reshape the environment is how a value ends up depending on which one ran.
 */

/** Set, and not the empty string — how an unused key is written in `.env`. */
const isSet = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Credentials that only work as a set.
 *
 * Listed as groups rather than individual required keys because every one of
 * these integrations is genuinely optional — a deployment without Stripe is a
 * normal deployment. What is never intended is half of one.
 *
 * `credentials` are the keys issued by the provider: setting one is what says
 * "I am turning this on". `alsoNeeded` are settings that ship pre-filled in
 * `.env.example` — the OAuth redirect URIs — and so say nothing about intent.
 * The distinction matters: a stock checkout has both redirect URIs populated
 * and every secret empty, and treating that as half-configured would refuse to
 * start on an environment that is simply not using OAuth.
 */
const GROUPS: Array<{ feature: string; credentials: string[]; alsoNeeded?: string[] }> = [
  {
    feature: 'OneID',
    credentials: ['ONEID_CLIENT_ID', 'ONEID_CLIENT_SECRET'],
    alsoNeeded: ['ONEID_REDIRECT_URI'],
  },
  {
    feature: 'Google sign-in',
    credentials: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    alsoNeeded: ['GOOGLE_REDIRECT_URI'],
  },
  { feature: 'CLICK', credentials: ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_SECRET_KEY'] },
  { feature: 'Payme', credentials: ['PAYME_MERCHANT_ID', 'PAYME_MERCHANT_KEY'] },
  { feature: 'Uzum', credentials: ['UZUM_MERCHANT_ID', 'UZUM_SECRET_KEY'] },
  { feature: 'Stripe', credentials: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  { feature: 'SMTP email', credentials: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] },
  {
    feature: 'S3 storage',
    credentials: ['S3_BUCKET_NAME', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
  },
];

/**
 * Values shipped in `.env.example`.
 *
 * Anything here is public: the file is in the repository. Reaching production
 * with one means the signing key for every session, or for every document
 * verification code, is readable by anyone who can clone the repo.
 */
const PLACEHOLDERS = new Set(['replace-with-a-strong-random-secret', 'sk-ant-...', 'sk-...']);

/** An integer within bounds, tolerated as either a string or a number. */
const boundedInt = (min: number, max: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .refine(
      (value) => {
        if (!isSet(value) && typeof value !== 'number') return true;
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= min && parsed <= max;
      },
      { message: `must be a whole number between ${min} and ${max}` },
    );

const schema = z
  .object({
    // --- Required everywhere -------------------------------------------------
    // The service cannot start without these, and failing here is the same
    // failure as failing later, only legible.
    DATABASE_URL: z.string().min(1, 'is required'),
    REDIS_URL: z.string().min(1, 'is required'),
    JWT_ACCESS_SECRET: z.string().min(1, 'is required'),

    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .optional()
      .or(z.literal('')),

    AI_PRIMARY_PROVIDER: z.enum(['anthropic', 'openai']).optional().or(z.literal('')),

    // --- Ranges something downstream depends on ------------------------------
    // The approved DevSMS templates take 4-8 digits and nothing else; a code
    // outside that is refused at send time, which is one code per locked-out
    // user rather than one error at boot.
    OTP_CODE_LENGTH: boundedInt(4, 8),
    // 1 confirm · 2 reset · 3 register · 4 sign in.
    DEVSMS_OTP_TEMPLATE: boundedInt(1, 4),
    // Appears inside the OTP message and is moderated by DevSMS; a name they
    // reject is charged for and not delivered.
    DEVSMS_SERVICE_NAME: z
      .string()
      .optional()
      .refine((value) => !isSet(value) || (value!.trim().length >= 2 && value!.trim().length <= 50), {
        message: 'must be 2-50 characters',
      }),
    SMTP_PORT: boundedInt(1, 65_535),
    PORT: boundedInt(1, 65_535),
  })
  // Unknown keys pass through untouched: this validates the environment, it
  // does not define it.
  .passthrough();

export class EnvValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Invalid environment (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Collects every problem before throwing.
 *
 * One at a time would mean a fix-restart-discover loop, and the person running
 * it is usually mid-deploy with a rollback window open.
 */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const problems: string[] = [];

  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${issue.path.join('.') || 'env'} ${issue.message}`);
    }
  }

  for (const { feature, credentials, alsoNeeded = [] } of GROUPS) {
    // Nothing issued by the provider is set, so the feature is off. Pre-filled
    // defaults sitting in `alsoNeeded` do not make it on.
    const supplied = credentials.filter((key) => isSet(raw[key]));
    if (supplied.length === 0) continue;

    const missing = [...credentials, ...alsoNeeded].filter((key) => !isSet(raw[key]));
    if (missing.length > 0) {
      problems.push(
        `${feature} is half-configured: ${missing.join(', ')} ${
          missing.length === 1 ? 'is' : 'are'
        } empty while ${supplied.join(', ')} ${supplied.length === 1 ? 'is' : 'are'} set. ` +
          'Set all of them, or none — a partial integration reports itself unconfigured and vanishes from the UI.',
      );
    }
  }

  if (raw.NODE_ENV === 'production') {
    for (const key of ['JWT_ACCESS_SECRET', 'DOCUMENT_VERIFICATION_SECRET']) {
      if (PLACEHOLDERS.has(String(raw[key] ?? ''))) {
        problems.push(
          `${key} is still the placeholder from .env.example, which is public. Generate one: openssl rand -base64 48`,
        );
      }
    }

    // The service refuses to sign with a shorter key anyway; catching it here
    // means finding out at deploy rather than at the first export.
    const verificationSecret = String(raw.DOCUMENT_VERIFICATION_SECRET ?? '');
    if (verificationSecret !== '' && verificationSecret.length < 32) {
      problems.push('DOCUMENT_VERIFICATION_SECRET must be at least 32 characters');
    }

    if (!isSet(raw.CORS_ORIGINS)) {
      problems.push(
        'CORS_ORIGINS is required in production: credentialed CORS cannot use "*", so an empty allowlist blocks the web app entirely',
      );
    }
  }

  if (problems.length > 0) throw new EnvValidationError(problems);

  return raw;
}

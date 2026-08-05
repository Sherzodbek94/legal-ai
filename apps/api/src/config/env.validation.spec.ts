/**
 * Boot-time environment validation.
 *
 * Every rule here exists because the failure it catches is otherwise silent and
 * late: a half-configured payment gateway rejects a real customer's callback, an
 * out-of-range OTP length locks out whoever tries to sign in, a placeholder
 * secret ships a public signing key. The tests are written around what each rule
 * costs to get wrong, not around the schema's shape.
 */
import { EnvValidationError, validateEnv } from './env.validation';

/** The minimum that must be present for any environment to be valid. */
const BASE = {
  DATABASE_URL: 'postgresql://localhost:5432/legaltech',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a-real-secret',
};

function problemsFor(env: Record<string, unknown>): string[] {
  try {
    validateEnv(env);
    return [];
  } catch (error) {
    if (error instanceof EnvValidationError) return error.problems;
    throw error;
  }
}

describe('validateEnv', () => {
  it('accepts a minimal environment', () => {
    expect(() => validateEnv({ ...BASE })).not.toThrow();
  });

  it('hands the environment back unchanged', () => {
    // It validates; it does not transform. Coercion lives in numericConfig, and
    // two places reshaping the environment is how a value starts depending on
    // which one ran.
    const env = { ...BASE, OTP_CODE_LENGTH: '6', SOMETHING_UNKNOWN: 'kept' };

    expect(validateEnv(env)).toBe(env);
  });

  describe('required everywhere', () => {
    it.each(['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET'])(
      'refuses to start without %s',
      (key) => {
        const env = { ...BASE };
        delete (env as Record<string, unknown>)[key];

        expect(problemsFor(env).join('\n')).toContain(key);
      },
    );
  });

  describe('half-configured integrations', () => {
    it('rejects two of three OneID credentials', () => {
      // The half-set case is the dangerous one: /auth/providers reports OneID
      // unconfigured, the button disappears, and it reads as a missing feature
      // rather than a mistake.
      const problems = problemsFor({
        ...BASE,
        ONEID_CLIENT_ID: 'id',
        ONEID_CLIENT_SECRET: 'secret',
        ONEID_REDIRECT_URI: '',
      });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('OneID');
      expect(problems[0]).toContain('ONEID_REDIRECT_URI');
    });

    it('accepts none of them', () => {
      // A deployment without OneID is a normal deployment.
      expect(problemsFor({ ...BASE })).toHaveLength(0);
    });

    it('does not count a pre-filled redirect URI as turning OAuth on', () => {
      // This is exactly what a stock checkout looks like: `.env.example` ships
      // both redirect URIs populated and every secret empty. Reading that as
      // half-configured would refuse to start on an environment that is simply
      // not using OAuth — which it did, the first time this ran against a real
      // .env.
      expect(
        problemsFor({
          ...BASE,
          ONEID_REDIRECT_URI: 'http://localhost:4000/api/auth/oneid/callback',
          GOOGLE_REDIRECT_URI: 'http://localhost:4000/api/auth/google/callback',
        }),
      ).toHaveLength(0);
    });

    it('still requires the redirect URI once a secret is set', () => {
      const problems = problemsFor({
        ...BASE,
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REDIRECT_URI: '',
      });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('GOOGLE_REDIRECT_URI');
    });

    it('accepts all of them', () => {
      expect(
        problemsFor({
          ...BASE,
          ONEID_CLIENT_ID: 'id',
          ONEID_CLIENT_SECRET: 'secret',
          ONEID_REDIRECT_URI: 'https://example.com/cb',
        }),
      ).toHaveLength(0);
    });

    it('treats an empty string as unset, the way .env writes it', () => {
      expect(
        problemsFor({ ...BASE, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }),
      ).toHaveLength(0);
    });

    it('treats whitespace as unset too', () => {
      expect(
        problemsFor({ ...BASE, PAYME_MERCHANT_ID: '   ', PAYME_MERCHANT_KEY: '   ' }),
      ).toHaveLength(0);
    });

    it.each([
      ['Google sign-in', { GOOGLE_CLIENT_ID: 'x' }],
      ['CLICK', { CLICK_SERVICE_ID: 'x' }],
      ['Payme', { PAYME_MERCHANT_ID: 'x' }],
      ['Uzum', { UZUM_MERCHANT_ID: 'x' }],
      ['Stripe', { STRIPE_SECRET_KEY: 'x' }],
      ['SMTP email', { SMTP_HOST: 'x' }],
      ['S3 storage', { S3_BUCKET_NAME: 'x' }],
    ])('catches a half-configured %s', (feature, partial) => {
      const problems = problemsFor({ ...BASE, ...partial });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(feature);
    });
  });

  describe('ranges something downstream depends on', () => {
    it.each(['3', '9', '0'])('rejects an OTP code length of %s', (length) => {
      // The approved SMS templates accept 4-8 digits. Outside that every send is
      // refused, which is one locked-out user per attempt.
      expect(problemsFor({ ...BASE, OTP_CODE_LENGTH: length })).toHaveLength(1);
    });

    it.each(['4', '6', '8', 6])('accepts an OTP code length of %s', (length) => {
      expect(problemsFor({ ...BASE, OTP_CODE_LENGTH: length })).toHaveLength(0);
    });

    it.each(['0', '5', 'four'])('rejects OTP template %s', (template) => {
      expect(problemsFor({ ...BASE, DEVSMS_OTP_TEMPLATE: template })).toHaveLength(1);
    });

    it('accepts the four real templates', () => {
      for (const template of ['1', '2', '3', '4']) {
        expect(problemsFor({ ...BASE, DEVSMS_OTP_TEMPLATE: template })).toHaveLength(0);
      }
    });

    it('rejects a service name outside 2-50 characters', () => {
      expect(problemsFor({ ...BASE, DEVSMS_SERVICE_NAME: 'L' })).toHaveLength(1);
      expect(
        problemsFor({ ...BASE, DEVSMS_SERVICE_NAME: 'x'.repeat(51) }),
      ).toHaveLength(1);
      expect(problemsFor({ ...BASE, DEVSMS_SERVICE_NAME: 'LegalTech' })).toHaveLength(0);
    });

    it('rejects a port outside the valid range', () => {
      expect(problemsFor({ ...BASE, SMTP_PORT: '70000' })).toHaveLength(1);
      expect(problemsFor({ ...BASE, PORT: '0' })).toHaveLength(1);
      expect(problemsFor({ ...BASE, PORT: '4000' })).toHaveLength(0);
    });

    it('rejects an unknown AI provider', () => {
      expect(problemsFor({ ...BASE, AI_PRIMARY_PROVIDER: 'gemini' })).toHaveLength(1);
      expect(problemsFor({ ...BASE, AI_PRIMARY_PROVIDER: 'anthropic' })).toHaveLength(0);
    });

    it('rejects an unknown NODE_ENV', () => {
      // Half the behaviour in this codebase branches on it, and a typo'd
      // "prodction" silently takes every non-production path.
      expect(problemsFor({ ...BASE, NODE_ENV: 'prodction' })).toHaveLength(1);
    });
  });

  describe('production-only rules', () => {
    const PROD = { ...BASE, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' };

    it('rejects the placeholder secret from .env.example', () => {
      // The file is in the repository, so shipping its value ships a public key.
      const problems = problemsFor({
        ...PROD,
        JWT_ACCESS_SECRET: 'replace-with-a-strong-random-secret',
      });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('placeholder');
    });

    it('allows the placeholder outside production', () => {
      // Local development is why the placeholder exists.
      expect(
        problemsFor({ ...BASE, JWT_ACCESS_SECRET: 'replace-with-a-strong-random-secret' }),
      ).toHaveLength(0);
    });

    it('requires a CORS allowlist', () => {
      // Credentialed CORS cannot use "*", so an empty allowlist blocks the web
      // app outright — and does it only in production.
      const problems = problemsFor({ ...PROD, CORS_ORIGINS: '' });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('CORS_ORIGINS');
    });

    it('rejects a document verification secret under 32 characters', () => {
      expect(
        problemsFor({ ...PROD, DOCUMENT_VERIFICATION_SECRET: 'too-short' }),
      ).toHaveLength(1);
      expect(
        problemsFor({ ...PROD, DOCUMENT_VERIFICATION_SECRET: 'x'.repeat(32) }),
      ).toHaveLength(0);
    });
  });

  describe('reporting', () => {
    it('reports every problem at once', () => {
      // One at a time means a fix-restart-discover loop, and whoever is running
      // it usually has a rollback window open.
      const problems = problemsFor({
        REDIS_URL: 'redis://localhost:6379',
        OTP_CODE_LENGTH: '99',
        GOOGLE_CLIENT_ID: 'only-this-one',
      });

      expect(problems.length).toBeGreaterThanOrEqual(4);
    });

    it('names every problem in the thrown message', () => {
      let message = '';
      try {
        validateEnv({ ...BASE, OTP_CODE_LENGTH: '99', DEVSMS_OTP_TEMPLATE: '9' });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('OTP_CODE_LENGTH');
      expect(message).toContain('DEVSMS_OTP_TEMPLATE');
      expect(message).toContain('2 problems');
    });
  });
});

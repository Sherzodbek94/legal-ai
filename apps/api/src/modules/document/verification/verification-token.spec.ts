import { VerificationTokenService } from './verification-token.service';

const SECRET = 'a'.repeat(48);

function makeService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    DOCUMENT_VERIFICATION_SECRET: SECRET,
    DOCUMENT_VERIFICATION_BASE_URL: 'https://legal.test/verify',
    ...overrides,
  };

  const config = {
    get: <T>(key: string, fallback?: T) =>
      (values[key] as T | undefined) ?? fallback,
    getOrThrow: <T>(key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`);
      return values[key] as T;
    },
  } as never;

  return new VerificationTokenService(config);
}

const CONTENT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pay 1000 USD' }] }],
};

describe('VerificationTokenService', () => {
  describe('signing', () => {
    it('produces a payload.signature token', () => {
      const token = makeService().sign('doc_1', CONTENT);
      expect(token.split('.')).toHaveLength(2);
    });

    it('uses url-safe characters, so the token survives being a path segment', () => {
      const token = makeService().sign('doc_1', CONTENT);
      expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    });

    it('round-trips through verify', () => {
      const service = makeService();
      const result = service.verify(service.sign('doc_1', CONTENT));

      expect(result.valid).toBe(true);
      expect(result.valid && result.payload.d).toBe('doc_1');
    });

    it('records the issue time', () => {
      const service = makeService();
      const issuedAt = new Date('2026-07-29T10:00:00Z');
      const result = service.verify(service.sign('doc_1', CONTENT, issuedAt));

      expect(result.valid && result.payload.i).toBe(
        Math.floor(issuedAt.getTime() / 1000),
      );
    });

    it('builds a verification URL from the token', () => {
      const service = makeService();
      const token = service.sign('doc_1', CONTENT);

      expect(service.buildVerificationUrl(token)).toBe(
        `https://legal.test/verify/${encodeURIComponent(token)}`,
      );
    });

    it('does not double up slashes when the base URL has a trailing one', () => {
      const service = makeService({
        DOCUMENT_VERIFICATION_BASE_URL: 'https://legal.test/verify/',
      });
      expect(service.buildVerificationUrl('t')).toBe('https://legal.test/verify/t');
    });
  });

  describe('tamper detection', () => {
    it('rejects a token signed with a different secret', () => {
      const forged = makeService({
        DOCUMENT_VERIFICATION_SECRET: 'b'.repeat(48),
      }).sign('doc_1', CONTENT);

      expect(makeService().verify(forged)).toEqual({
        valid: false,
        reason: 'signature mismatch',
      });
    });

    it('rejects a token whose payload was swapped for another document', () => {
      const service = makeService();
      const mine = service.sign('doc_1', CONTENT);
      const theirs = service.sign('doc_2', CONTENT);

      // Keep a valid signature, substitute a different payload.
      const spliced = `${theirs.split('.')[0]}.${mine.split('.')[1]}`;
      expect(service.verify(spliced).valid).toBe(false);
    });

    it('rejects a flipped bit in the signature', () => {
      const service = makeService();
      const token = service.sign('doc_1', CONTENT);
      const [payload, signature] = token.split('.');

      const flipped = `${signature.slice(0, -1)}${signature.at(-1) === 'A' ? 'B' : 'A'}`;
      expect(service.verify(`${payload}.${flipped}`).valid).toBe(false);
    });

    it('rejects a malformed token without attempting to parse it', () => {
      const service = makeService();
      expect(service.verify('not-a-token')).toEqual({
        valid: false,
        reason: 'malformed token',
      });
      expect(service.verify('')).toEqual({
        valid: false,
        reason: 'malformed token',
      });
    });

    it('rejects a token with an empty signature', () => {
      expect(makeService().verify('payload.').valid).toBe(false);
    });

    it('rejects a signature of the wrong length rather than throwing', () => {
      const service = makeService();
      const [payload] = service.sign('doc_1', CONTENT).split('.');
      expect(() => service.verify(`${payload}.short`)).not.toThrow();
      expect(service.verify(`${payload}.short`).valid).toBe(false);
    });
  });

  describe('content binding', () => {
    it('confirms content that has not changed', () => {
      const service = makeService();
      const result = service.verify(service.sign('doc_1', CONTENT));

      expect(result.valid && service.matchesContent(result.payload, CONTENT)).toBe(
        true,
      );
    });

    it('detects an altered amount in an otherwise identical document', () => {
      const service = makeService();
      const result = service.verify(service.sign('doc_1', CONTENT));

      const altered = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Pay 100000 USD' }],
          },
        ],
      };

      expect(result.valid && service.matchesContent(result.payload, altered)).toBe(
        false,
      );
    });

    it('is insensitive to key order, so a document verifies against itself', () => {
      const service = makeService();

      const a = { type: 'doc', attrs: { x: 1, y: 2 } };
      const b = { attrs: { y: 2, x: 1 }, type: 'doc' };

      expect(service.contentHash(a)).toBe(service.contentHash(b));
    });

    it('is sensitive to array order, which changes clause sequence', () => {
      const service = makeService();

      expect(service.contentHash({ c: ['a', 'b'] })).not.toBe(
        service.contentHash({ c: ['b', 'a'] }),
      );
    });

    it('produces a 128-bit digest', () => {
      expect(makeService().contentHash(CONTENT)).toHaveLength(32);
    });
  });

  describe('expiry', () => {
    it('never expires by default, because a contract binds indefinitely', () => {
      const service = makeService();
      const old = new Date('2019-01-01T00:00:00Z');

      expect(service.verify(service.sign('doc_1', CONTENT, old)).valid).toBe(true);
    });

    it('rejects a token older than a configured maximum age', () => {
      const service = makeService({
        DOCUMENT_VERIFICATION_MAX_AGE_SECONDS: 3600,
      });
      const old = new Date(Date.now() - 7200_000);

      expect(service.verify(service.sign('doc_1', CONTENT, old))).toEqual({
        valid: false,
        reason: 'token expired',
      });
    });

    it('accepts a token inside the maximum age', () => {
      const service = makeService({
        DOCUMENT_VERIFICATION_MAX_AGE_SECONDS: 3600,
      });
      const recent = new Date(Date.now() - 60_000);

      expect(service.verify(service.sign('doc_1', CONTENT, recent)).valid).toBe(
        true,
      );
    });
  });

  describe('secret hygiene', () => {
    it('refuses a secret too short to be a meaningful HMAC key', () => {
      const service = makeService({ DOCUMENT_VERIFICATION_SECRET: 'short' });
      expect(() => service.sign('doc_1', CONTENT)).toThrow(/at least 32/);
    });

    it('fails loudly when no secret is configured at all', () => {
      const service = makeService({ DOCUMENT_VERIFICATION_SECRET: undefined });
      expect(() => service.sign('doc_1', CONTENT)).toThrow(/DOCUMENT_VERIFICATION_SECRET/);
    });
  });
});

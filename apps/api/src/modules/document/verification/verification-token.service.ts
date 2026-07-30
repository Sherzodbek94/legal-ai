import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signs and checks the verification code printed on every exported document.
 *
 * The threat this addresses is a forged contract: someone takes a real
 * generated document, edits a payment amount, and presents it as issued by the
 * firm. The QR code on the page resolves to a public endpoint that says whether
 * *this exact text* was issued, so a verifier with the paper in hand can tell.
 *
 * That means the token has to bind two things, not one: which document it is,
 * and what the document said. Binding only the id would let an attacker keep a
 * genuine QR code on top of altered text.
 */

export interface VerificationPayload {
  /** Format version, so the token can change shape without breaking old ones. */
  v: 1;
  /** Document id. */
  d: string;
  /** Issued-at, epoch seconds. */
  i: number;
  /** SHA-256 of the canonical content, truncated — see `contentHash`. */
  h: string;
}

export type VerificationResult =
  | { valid: true; payload: VerificationPayload }
  | { valid: false; reason: string };

/**
 * Truncation length for the content digest, in hex characters.
 *
 * 32 hex chars is 128 bits. The digest is not a secret and is covered by the
 * HMAC, so this only needs to make a second-preimage collision infeasible —
 * 128 bits does, and it keeps the printed token short enough to type by hand.
 */
const CONTENT_HASH_LENGTH = 32;

/** An HMAC key shorter than this is not worth the ceremony around it. */
const MIN_SECRET_LENGTH = 32;

@Injectable()
export class VerificationTokenService {
  private readonly logger = new Logger(VerificationTokenService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Resolved per call rather than cached at construction so the app still boots
   * in an environment that has not configured document verification yet — the
   * failure surfaces on the first export instead of at startup.
   */
  private get secret(): string {
    const secret = this.config.getOrThrow<string>(
      'DOCUMENT_VERIFICATION_SECRET',
    );

    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `DOCUMENT_VERIFICATION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
      );
    }
    return secret;
  }

  /** Verification links stop resolving after this; 0 disables expiry. */
  private get maxAgeSeconds(): number {
    return this.config.get<number>('DOCUMENT_VERIFICATION_MAX_AGE_SECONDS', 0);
  }

  private get baseUrl(): string {
    return this.config
      .get<string>('DOCUMENT_VERIFICATION_BASE_URL', 'http://localhost:3000/verify')
      .replace(/\/+$/, '');
  }

  /**
   * Digest of the document body.
   *
   * Keys are sorted before serialising so two structurally identical documents
   * hash the same regardless of the order Prisma happened to return the JSON
   * in — otherwise a document would fail to verify against itself.
   */
  contentHash(content: unknown): string {
    return createHash('sha256')
      .update(canonicalJson(content))
      .digest('hex')
      .slice(0, CONTENT_HASH_LENGTH);
  }

  sign(documentId: string, content: unknown, issuedAt = new Date()): string {
    const payload: VerificationPayload = {
      v: 1,
      d: documentId,
      i: Math.floor(issuedAt.getTime() / 1000),
      h: this.contentHash(content),
    };

    const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
    return `${encoded}.${this.hmac(encoded)}`;
  }

  /** The URL the QR code encodes. */
  buildVerificationUrl(token: string): string {
    return `${this.baseUrl}/${encodeURIComponent(token)}`;
  }

  verify(token: string): VerificationResult {
    if (typeof token !== 'string' || !token.includes('.')) {
      return { valid: false, reason: 'malformed token' };
    }

    const separator = token.lastIndexOf('.');
    const encoded = token.slice(0, separator);
    const signature = token.slice(separator + 1);

    if (!encoded || !signature) {
      return { valid: false, reason: 'malformed token' };
    }

    // Signature first, always. Parsing attacker-controlled JSON before
    // establishing that we wrote it is how a verifier becomes the attack
    // surface it was meant to protect.
    if (!this.signatureMatches(encoded, signature)) {
      return { valid: false, reason: 'signature mismatch' };
    }

    let payload: VerificationPayload;
    try {
      payload = JSON.parse(base64UrlDecode(encoded).toString('utf8'));
    } catch {
      return { valid: false, reason: 'malformed payload' };
    }

    if (payload?.v !== 1 || typeof payload.d !== 'string' || typeof payload.i !== 'number') {
      return { valid: false, reason: 'unsupported token version' };
    }

    const maxAge = this.maxAgeSeconds;
    if (maxAge > 0) {
      const ageSeconds = Math.floor(Date.now() / 1000) - payload.i;
      if (ageSeconds > maxAge) {
        return { valid: false, reason: 'token expired' };
      }
    }

    return { valid: true, payload };
  }

  /** Whether a stored document still matches the digest inside its token. */
  matchesContent(payload: VerificationPayload, content: unknown): boolean {
    const expected = Buffer.from(payload.h, 'utf8');
    const actual = Buffer.from(this.contentHash(content), 'utf8');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private hmac(encoded: string): string {
    return base64UrlEncode(
      createHmac('sha256', this.secret).update(encoded).digest(),
    );
  }

  private signatureMatches(encoded: string, presented: string): boolean {
    const expected = Buffer.from(this.hmac(encoded), 'utf8');
    const actual = Buffer.from(presented, 'utf8');

    // timingSafeEqual throws on a length mismatch, and the length itself is
    // not a secret — a wrong-length signature is simply wrong.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Stable serialisation: object keys sorted, arrays left in order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);

  return `{${entries.join(',')}}`;
}

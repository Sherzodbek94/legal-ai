/**
 * Stripe webhook signature verification.
 *
 * Implemented directly rather than via the `stripe` SDK: the check is thirty
 * lines, and doing it here means the timestamp tolerance and the multi-
 * signature handling are visible and testable rather than being a library
 * detail nobody on the team has read.
 *
 *   Stripe-Signature: t=1614556800,v1=<hex>,v1=<hex>
 *
 * The signed payload is `${timestamp}.${rawBody}` — the *raw* body. Re-
 * serialising the parsed JSON produces different bytes (key order, whitespace,
 * unicode escaping) and every signature check fails.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How far a webhook's timestamp may be from now.
 *
 * Without this, a signature stays valid forever and an attacker who captures
 * one payment-succeeded callback can replay it indefinitely. Five minutes is
 * Stripe's own recommendation and comfortably covers clock skew.
 */
export const STRIPE_DEFAULT_TOLERANCE_SECONDS = 300;

export interface StripeSignatureHeader {
  timestamp: number;
  /** All v1 signatures — Stripe sends several while a secret is being rotated. */
  signatures: string[];
}

export function parseStripeSignatureHeader(
  header: string | undefined,
): StripeSignatureHeader | null {
  if (!header) return null;

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export type StripeVerificationResult =
  | { valid: true }
  | { valid: false; reason: 'MALFORMED_HEADER' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'NO_MATCHING_SIGNATURE' };

/**
 * @param rawBody the exact bytes Stripe posted, before any JSON parsing.
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): StripeVerificationResult {
  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: 'MALFORMED_HEADER' };

  const tolerance = options.toleranceSeconds ?? STRIPE_DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  // Absolute difference: a timestamp far in the *future* is as suspicious as
  // one far in the past, and only checking the past leaves a forward-dated
  // replay window open.
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { valid: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  }

  const payload = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.`, 'utf8'),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'),
  ]);

  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  // Every candidate is compared even after a match is found, so the number of
  // comparisons does not depend on which signature matched.
  let matched = false;
  for (const candidate of parsed.signatures) {
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (candidateBuffer.length !== expectedBuffer.length) continue;
    if (timingSafeEqual(expectedBuffer, candidateBuffer)) matched = true;
  }

  return matched ? { valid: true } : { valid: false, reason: 'NO_MATCHING_SIGNATURE' };
}

/** Builds a header in Stripe's format — used by tests and local tooling. */
export function buildStripeSignatureHeader(
  rawBody: Buffer | string,
  secret: string,
  timestamp: number,
): string {
  const payload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'),
  ]);
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

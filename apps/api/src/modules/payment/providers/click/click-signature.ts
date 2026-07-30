/**
 * CLICK SHOP-API request signing.
 *
 * CLICK authenticates each callback with an MD5 of a fixed concatenation of the
 * request fields and the merchant secret key. The order of the fields is part
 * of the protocol and differs between the two actions — getting it wrong makes
 * every callback fail signature verification with no other symptom.
 *
 *   Prepare  (action=0): click_trans_id + service_id + SECRET + merchant_trans_id
 *                        + amount + action + sign_time
 *   Complete (action=1): click_trans_id + service_id + SECRET + merchant_trans_id
 *                        + merchant_prepare_id + amount + action + sign_time
 *
 * MD5 is not a defensible choice in 2026 — it is collision-broken and this is a
 * keyed construction it was never designed for. It is used because it is what
 * the operator's protocol specifies; we do not get to pick. What we *can* do is
 * compare in constant time and never let a comparison shortcut leak.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const CLICK_ACTION_PREPARE = 0;
export const CLICK_ACTION_COMPLETE = 1;

export interface ClickSignatureInput {
  click_trans_id: string | number;
  service_id: string | number;
  merchant_trans_id: string;
  /** Present only for the Complete callback. */
  merchant_prepare_id?: string | number | null;
  /**
   * CLICK sends the amount as a decimal string ("49.00"). It is concatenated
   * verbatim — reformatting it, even to an equivalent number, changes the
   * digest and fails the check.
   */
  amount: string | number;
  action: string | number;
  sign_time: string;
}

/**
 * Builds the digest CLICK should have sent.
 *
 * `amount` and every other field are stringified exactly as received. That is
 * deliberate: `String(49.0)` is `"49"`, which would not match the `"49.00"`
 * CLICK signed.
 */
export function buildClickSignString(
  input: ClickSignatureInput,
  secretKey: string,
): string {
  const isComplete = String(input.action) === String(CLICK_ACTION_COMPLETE);

  const parts: (string | number)[] = [
    input.click_trans_id,
    input.service_id,
    secretKey,
    input.merchant_trans_id,
    ...(isComplete ? [input.merchant_prepare_id ?? ''] : []),
    input.amount,
    input.action,
    input.sign_time,
  ];

  return createHash('md5').update(parts.join(''), 'utf8').digest('hex');
}

/**
 * Constant-time comparison of the presented signature.
 *
 * A byte-by-byte comparison that returns early leaks how much of a guessed
 * signature was correct, which turns forging one into a per-character search
 * rather than a 2^128 problem.
 */
export function verifyClickSignature(
  input: ClickSignatureInput & { sign_string?: string },
  secretKey: string,
): boolean {
  const presented = input.sign_string;
  if (typeof presented !== 'string' || presented.length === 0) return false;

  const expected = buildClickSignString(input, secretKey);

  // Digests are fixed-length hex, so a length mismatch is simply a wrong
  // signature and revealing it discloses nothing.
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const presentedBuffer = Buffer.from(presented.toLowerCase(), 'utf8');

  if (expectedBuffer.length !== presentedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, presentedBuffer);
}

/**
 * Converts CLICK's decimal-string amount into minor units.
 *
 * Parsing to a float and multiplying by 100 is the obvious approach and it is
 * wrong: `49.29 * 100` is `4928.9999...` in IEEE 754, which truncates to a cent
 * less than the customer paid. Splitting on the decimal point keeps it exact.
 */
export function parseClickAmountToMinorUnits(amount: string | number): number | null {
  const raw = String(amount).trim();

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;

  const [whole, fraction = ''] = raw.split('.');
  const padded = fraction.padEnd(2, '0');

  return Number(whole) * 100 + Number(padded);
}

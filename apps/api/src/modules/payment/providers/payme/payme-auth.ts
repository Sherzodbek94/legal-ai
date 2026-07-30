/**
 * Payme Merchant API authentication.
 *
 * Payme sends HTTP Basic with a fixed login of `Paycom` and the merchant key as
 * the password:
 *
 *   Authorization: Basic base64("Paycom:" + MERCHANT_KEY)
 *
 * The login is part of the protocol, not a credential, so the key is the only
 * secret — which makes constant-time comparison of it the whole of the defence.
 */
import { timingSafeEqual } from 'node:crypto';

export const PAYME_LOGIN = 'Paycom';

/**
 * Verifies the Basic header against the merchant key.
 *
 * Returns a boolean rather than throwing so the caller can decide the protocol
 * response — Payme wants a JSON-RPC error at HTTP 200, not a 401.
 */
export function verifyPaymeAuth(
  authorizationHeader: string | undefined,
  merchantKey: string,
): boolean {
  if (!authorizationHeader || !merchantKey) return false;

  const [scheme, encoded] = authorizationHeader.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }

  // Split on the first colon only: the key itself may legitimately contain one.
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;

  const login = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  if (login !== PAYME_LOGIN) return false;

  const expected = Buffer.from(merchantKey, 'utf8');
  const presented = Buffer.from(password, 'utf8');

  // Length is not secret — a key of the wrong length is simply the wrong key —
  // and timingSafeEqual throws unless the buffers match in length.
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

/**
 * Payme quotes amounts in tiyin (1 UZS = 100 tiyin), which is already the
 * minor unit our orders are stored in. The conversion is a no-op today; it
 * exists so the assumption is written down at the boundary rather than being
 * rediscovered when someone adds a gateway that does not agree.
 */
export function paymeAmountToMinorUnits(amount: unknown): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (!Number.isInteger(amount) || amount < 0) return null;
  return amount;
}

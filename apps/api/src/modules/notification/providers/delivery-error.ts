/**
 * Distinguishing a failure worth retrying from one that never will be.
 *
 * This is the single most consequential decision a notification worker makes.
 * Retrying a permanent failure — an invalid phone number, a bot the user blocked,
 * a rejected recipient address — burns the retry budget, delays every job behind
 * it, and in the case of SMS costs money per attempt. Not retrying a transient one
 * silently drops a notification the user needed.
 */

export type DeliveryFailureKind =
  /** Worth another attempt: network, 5xx, rate limit. */
  | 'transient'
  /** Never worth another attempt: bad address, blocked, malformed. */
  | 'permanent'
  /** Our configuration is wrong — missing credentials. Not the recipient's fault. */
  | 'misconfigured';

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: DeliveryFailureKind,
    /** Provider's own status or error code, preserved for diagnosis. */
    readonly providerCode?: string | number,
    /** Honour a provider-supplied retry delay in preference to our backoff. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }

  get retryable(): boolean {
    return this.kind === 'transient';
  }
}

/**
 * Classifies an HTTP status.
 *
 * 408 and 429 are the two 4xx codes that are genuinely transient — a timeout and
 * a rate limit. Every other 4xx means the request was wrong, and sending the same
 * request again produces the same answer.
 */
export function classifyHttpStatus(status: number | undefined): DeliveryFailureKind {
  if (status === undefined) return 'transient'; // Network-level failure.
  if (status === 408 || status === 429) return 'transient';
  if (status === 401 || status === 403) return 'misconfigured';
  if (status >= 500) return 'transient';
  if (status >= 400) return 'permanent';
  return 'transient';
}

/** Reads a `Retry-After` header, in either of its two documented forms. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  // HTTP-date form.
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

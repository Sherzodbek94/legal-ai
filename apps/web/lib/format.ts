/**
 * Display formatting for admin figures.
 *
 * Money arrives from the API in minor units (cents) or micro-USD and is
 * formatted here rather than in each page, so a currency never renders three
 * different ways across one dashboard.
 */

/** Minor units to a currency string. */
export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Minor units with cents shown — for figures small enough that they matter. */
export function formatCentsExact(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Micro-USD to a currency string.
 *
 * Four decimal places by default: AI call costs are routinely a fraction of a
 * cent, and rounding them to two makes a real bill render as `$0.00`.
 */
export function formatMicroUsd(microUsd: number, decimals = 4): string {
  return `$${(microUsd / 1_000_000).toFixed(decimals)}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/** Compact form for token counts, which run to millions. */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * A rate as a percentage, or an em dash when it is undefined.
 *
 * Null is meaningful here: a churn rate over an empty opening balance is not
 * zero, and showing 0% would claim a retention record that does not exist.
 */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // Operational timestamps are compared across regions; showing the zone
    // avoids the "is that my 3pm or theirs" question entirely.
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date);
}

/** Relative time for recent events, falling back to a date when older. */
export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return formatDate(date);
}

/** Signed value with an explicit sign, for movement figures. */
export function formatSignedCents(cents: number, currency = 'USD'): string {
  const formatted = formatCents(Math.abs(cents), currency);
  if (cents === 0) return formatted;
  return `${cents > 0 ? '+' : '−'}${formatted}`;
}

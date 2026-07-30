/**
 * Billing window arithmetic.
 *
 * Usage counters are keyed by the start of the window they belong to, so this
 * has to be deterministic: the same instant must always resolve to the same
 * window, or a quota silently resets mid-period.
 *
 * All arithmetic is UTC. Local time would make a company's quota reset at a
 * different instant depending on where the server happens to run, and would
 * skip or repeat an hour twice a year.
 */

export interface BillingPeriod {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

export interface PeriodSource {
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
}

/**
 * Adds months, clamping to the last day of the target month.
 *
 * A subscription started on the 31st has no 31st in February. Rolling over into
 * March instead — which naive date arithmetic does — moves the renewal date
 * permanently and bills the customer early every year.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const targetMonth = month + months;
  // Day 0 of the following month is the last day of the target month.
  const lastDayOfTarget = new Date(
    Date.UTC(year, targetMonth + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      targetMonth,
      Math.min(day, lastDayOfTarget),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** The UTC calendar month containing `now`. */
export function calendarMonth(now: Date): BillingPeriod {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  return { start, end: addMonthsUtc(start, 1) };
}

/**
 * The window a company's usage should be counted against.
 *
 * A subscription's own period wins when it covers `now`. Otherwise — no
 * subscription at all (Free), or a subscription whose period has lapsed and
 * whose renewal has not yet run — usage falls back to the calendar month.
 *
 * That fallback matters: without it, a lapsed subscription would keep counting
 * into a window that never rolls over, and the customer's quota would never
 * reset even after they paid.
 */
export function resolveBillingPeriod(
  subscription: PeriodSource | null | undefined,
  now: Date = new Date(),
): BillingPeriod {
  const start = subscription?.currentPeriodStart;
  const end = subscription?.currentPeriodEnd;

  if (start && end && start <= now && now < end) {
    return { start, end };
  }

  return calendarMonth(now);
}

/** The next window after `period`, used when advancing a renewal. */
export function nextPeriod(period: BillingPeriod): BillingPeriod {
  return { start: period.end, end: addMonthsUtc(period.end, 1) };
}

/** Whole days remaining, floored at zero. */
export function daysUntil(target: Date, now: Date = new Date()): number {
  const ms = target.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

import {
  addMonthsUtc,
  calendarMonth,
  daysUntil,
  nextPeriod,
  resolveBillingPeriod,
} from './billing-period';

describe('addMonthsUtc', () => {
  it('advances by whole months', () => {
    expect(addMonthsUtc(new Date('2026-03-15T10:00:00Z'), 1).toISOString()).toBe(
      '2026-04-15T10:00:00.000Z',
    );
  });

  it('clamps to the last day when the target month is shorter', () => {
    // Rolling into March instead would move the renewal date permanently.
    expect(addMonthsUtc(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('clamps to 29 February in a leap year', () => {
    expect(addMonthsUtc(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('crosses a year boundary', () => {
    expect(addMonthsUtc(new Date('2026-12-15T00:00:00Z'), 1).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });

  it('preserves the time of day', () => {
    expect(
      addMonthsUtc(new Date('2026-03-15T13:45:30.123Z'), 2).toISOString(),
    ).toBe('2026-05-15T13:45:30.123Z');
  });

  it('goes backwards for a negative count', () => {
    expect(addMonthsUtc(new Date('2026-03-31T00:00:00Z'), -1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('does not permanently shift a 31st across several hops', () => {
    // Feb clamps to the 28th, but March must return to the 31st rather than
    // staying stuck on the 28th for the rest of the year.
    const jan31 = new Date('2026-01-31T00:00:00Z');
    expect(addMonthsUtc(jan31, 2).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });
});

describe('calendarMonth', () => {
  it('spans the first of the month to the first of the next', () => {
    const period = calendarMonth(new Date('2026-07-15T13:00:00Z'));
    expect(period.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('is computed in UTC, not the server timezone', () => {
    // 23:30 on the 31st is still July in UTC; a local-time implementation east
    // of Greenwich would report August and reset the quota a day early.
    const period = calendarMonth(new Date('2026-07-31T23:30:00Z'));
    expect(period.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('handles December rolling into the next year', () => {
    expect(calendarMonth(new Date('2026-12-10T00:00:00Z')).end.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

describe('resolveBillingPeriod', () => {
  const now = new Date('2026-07-15T12:00:00Z');

  it('uses the subscription window when it covers now', () => {
    const period = resolveBillingPeriod(
      {
        currentPeriodStart: new Date('2026-07-08T00:00:00Z'),
        currentPeriodEnd: new Date('2026-08-08T00:00:00Z'),
      },
      now,
    );
    expect(period.start.toISOString()).toBe('2026-07-08T00:00:00.000Z');
  });

  it('falls back to the calendar month with no subscription', () => {
    expect(resolveBillingPeriod(null, now).start.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('falls back when the subscription window has lapsed', () => {
    // Without this, a lapsed subscription counts into a window that never rolls
    // over and the customer's quota never resets — even after they pay.
    const period = resolveBillingPeriod(
      {
        currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      },
      now,
    );
    expect(period.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('falls back when the window has not started yet', () => {
    const period = resolveBillingPeriod(
      {
        currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      },
      now,
    );
    expect(period.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('falls back when the window is only half recorded', () => {
    expect(
      resolveBillingPeriod(
        { currentPeriodStart: new Date('2026-07-08T00:00:00Z'), currentPeriodEnd: null },
        now,
      ).start.toISOString(),
    ).toBe('2026-07-01T00:00:00.000Z');
  });

  it('treats the window start as inclusive and the end as exclusive', () => {
    const window = {
      currentPeriodStart: new Date('2026-07-08T00:00:00Z'),
      currentPeriodEnd: new Date('2026-08-08T00:00:00Z'),
    };

    expect(
      resolveBillingPeriod(window, window.currentPeriodStart).start.toISOString(),
    ).toBe('2026-07-08T00:00:00.000Z');

    // On the boundary instant the old window is over; usage belongs to the next.
    expect(
      resolveBillingPeriod(window, window.currentPeriodEnd).start.toISOString(),
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('is stable — the same instant always resolves to the same window', () => {
    const a = resolveBillingPeriod(null, now);
    const b = resolveBillingPeriod(null, now);
    expect(a.start.getTime()).toBe(b.start.getTime());
  });
});

describe('nextPeriod', () => {
  it('starts where the previous window ended, leaving no gap', () => {
    const period = {
      start: new Date('2026-07-08T00:00:00Z'),
      end: new Date('2026-08-08T00:00:00Z'),
    };
    const next = nextPeriod(period);

    expect(next.start.toISOString()).toBe(period.end.toISOString());
    expect(next.end.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
});

describe('daysUntil', () => {
  const now = new Date('2026-07-30T12:00:00Z');

  it('counts whole days remaining', () => {
    expect(daysUntil(new Date('2026-08-02T12:00:00Z'), now)).toBe(3);
  });

  it('rounds a partial day up, so "1 day left" is not shown as zero', () => {
    expect(daysUntil(new Date('2026-07-30T18:00:00Z'), now)).toBe(1);
  });

  it('floors at zero for a date already passed', () => {
    expect(daysUntil(new Date('2026-07-01T00:00:00Z'), now)).toBe(0);
  });
});

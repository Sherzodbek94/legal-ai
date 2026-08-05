/**
 * Display formatting.
 *
 * These render money and time on the admin dashboard, so the failures are the
 * quiet kind: a real AI bill rounded to `$0.00`, a churn rate of "no data"
 * shown as a perfect 0%, a timestamp that means a different hour depending on
 * who reads it. Each of those looks like a working page.
 */
import {
  formatCents,
  formatCentsExact,
  formatCompact,
  formatDate,
  formatDateTime,
  formatMicroUsd,
  formatNumber,
  formatRate,
  formatRelative,
  formatSignedCents,
} from './format';

describe('money', () => {
  it('renders minor units as whole currency', () => {
    expect(formatCents(123_456)).toBe('$1,235');
  });

  it('shows cents when asked', () => {
    expect(formatCentsExact(1234)).toBe('$12.34');
  });

  it('honours a currency other than the default', () => {
    expect(formatCents(100_000, 'EUR')).toContain('1,000');
  });

  it('keeps four decimals on micro-USD', () => {
    // AI calls routinely cost a fraction of a cent. Two decimals would render
    // a real bill as $0.00, which reads as "the meter is broken".
    expect(formatMicroUsd(1500)).toBe('$0.0015');
    expect(formatMicroUsd(0)).toBe('$0.0000');
  });

  it('rounds micro-USD to the requested precision', () => {
    expect(formatMicroUsd(2_500_000, 2)).toBe('$2.50');
  });
});

describe('formatSignedCents', () => {
  it('marks a rise with a plus', () => {
    expect(formatSignedCents(50_000)).toBe('+$500');
  });

  it('marks a fall with a minus sign, not a hyphen', () => {
    // U+2212, so the figure lines up with the positive case in a table.
    expect(formatSignedCents(-50_000)).toBe('−$500');
  });

  it('leaves zero unsigned', () => {
    // "+$0" claims a movement that did not happen.
    expect(formatSignedCents(0)).toBe('$0');
  });
});

describe('formatRate', () => {
  it('renders a rate to one decimal place', () => {
    expect(formatRate(0.1234)).toBe('12.3%');
  });

  it.each([null, undefined])('renders %p as an em dash, not 0%%', (value) => {
    // Churn over an empty opening balance is undefined, not zero. Showing 0%
    // would claim a retention record nobody earned.
    expect(formatRate(value)).toBe('—');
  });

  it('renders a genuine zero as 0%', () => {
    expect(formatRate(0)).toBe('0.0%');
  });
});

describe('dates', () => {
  it('formats a date from a string', () => {
    expect(formatDate('2026-03-09T10:30:00Z')).toBe('09 Mar 2026');
  });

  it('formats a Date object identically', () => {
    expect(formatDate(new Date('2026-03-09T10:30:00Z'))).toBe('09 Mar 2026');
  });

  it.each([null, undefined, '', 'not a date'])(
    'renders %p as an em dash rather than "Invalid Date"',
    (value) => {
      expect(formatDate(value as string)).toBe('—');
    },
  );

  it('states the zone on a timestamp', () => {
    // Operational timestamps are compared across regions; without the zone the
    // reader cannot tell whose 3pm it is.
    const formatted = formatDateTime('2026-03-09T10:30:00Z');

    expect(formatted).toContain('09 Mar 2026');
    expect(formatted).toContain('UTC');
  });

  it('renders a bad timestamp as an em dash too', () => {
    expect(formatDateTime('nonsense')).toBe('—');
  });
});

describe('formatRelative', () => {
  const NOW = new Date('2026-03-09T12:00:00Z').getTime();

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('says "just now" under a minute', () => {
    expect(formatRelative(ago(30_000))).toBe('just now');
  });

  it('counts minutes up to an hour', () => {
    expect(formatRelative(ago(5 * 60_000))).toBe('5m ago');
    expect(formatRelative(ago(59 * 60_000))).toBe('59m ago');
  });

  it('counts hours up to a day', () => {
    expect(formatRelative(ago(3 * 3_600_000))).toBe('3h ago');
  });

  it('counts days up to a week', () => {
    expect(formatRelative(ago(3 * 86_400_000))).toBe('3d ago');
  });

  it('falls back to a date beyond a week', () => {
    // "94d ago" is not something a reader can convert to a date in their head.
    expect(formatRelative(ago(30 * 86_400_000))).toBe('07 Feb 2026');
  });

  it('renders nothing as an em dash', () => {
    expect(formatRelative(null)).toBe('—');
  });
});

describe('counts', () => {
  it('groups thousands', () => {
    expect(formatNumber(1_234_567)).toBe('1,234,567');
  });

  it('compacts figures that run to millions', () => {
    expect(formatCompact(1_500_000)).toBe('1.5M');
    expect(formatCompact(2_400)).toBe('2.4K');
  });
});

/**
 * Provider-level classification and formatting.
 *
 * These are the pure decisions each provider makes before or after its network
 * call: is this failure worth retrying, is this phone number even valid, does this
 * message need escaping. Wrong answers here are expensive — a permanent failure
 * classified as transient bills five SMS attempts, and unescaped HTML in a Telegram
 * message fails to send at all.
 */
import {
  DeliveryError,
  classifyHttpStatus,
  parseRetryAfter,
} from './delivery-error';
import { normalizeUzbekPhone } from './eskiz-sms.service';
import { classifyTelegramError, formatMessage } from './telegram.service';
import { classifySmtpError, toHtml } from './email.service';

describe('classifyHttpStatus', () => {
  it('treats 408 and 429 as transient', () => {
    // The only two 4xx codes that are genuinely worth retrying.
    expect(classifyHttpStatus(408)).toBe('transient');
    expect(classifyHttpStatus(429)).toBe('transient');
  });

  it('treats other 4xx as permanent', () => {
    expect(classifyHttpStatus(400)).toBe('permanent');
    expect(classifyHttpStatus(404)).toBe('permanent');
    expect(classifyHttpStatus(422)).toBe('permanent');
  });

  it('treats auth failures as our misconfiguration', () => {
    expect(classifyHttpStatus(401)).toBe('misconfigured');
    expect(classifyHttpStatus(403)).toBe('misconfigured');
  });

  it('treats 5xx as transient', () => {
    expect(classifyHttpStatus(500)).toBe('transient');
    expect(classifyHttpStatus(503)).toBe('transient');
  });

  it('treats a missing status as transient', () => {
    // No status means the request never got a response — a network failure.
    expect(classifyHttpStatus(undefined)).toBe('transient');
  });
});

describe('DeliveryError', () => {
  it('marks only transient failures retryable', () => {
    expect(new DeliveryError('x', 'transient').retryable).toBe(true);
    expect(new DeliveryError('x', 'permanent').retryable).toBe(false);
    expect(new DeliveryError('x', 'misconfigured').retryable).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('reads the seconds form', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads the HTTP-date form', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).toBeGreaterThan(50_000);
    expect(parsed).toBeLessThanOrEqual(61_000);
  });

  it('clamps a past date to zero', () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it('returns undefined for a missing or unparseable value', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('normalizeUzbekPhone', () => {
  it('accepts the full international form', () => {
    expect(normalizeUzbekPhone('+998901234567')).toBe('998901234567');
    expect(normalizeUzbekPhone('998901234567')).toBe('998901234567');
  });

  it('expands the local nine-digit form', () => {
    expect(normalizeUzbekPhone('901234567')).toBe('998901234567');
  });

  it('strips the separators people actually type', () => {
    expect(normalizeUzbekPhone('+998 90 123 45 67')).toBe('998901234567');
    expect(normalizeUzbekPhone('(90) 123-45-67')).toBe('998901234567');
  });

  it('rejects a number of the wrong length', () => {
    // Rejected here as permanent rather than paying for five delivery attempts to
    // a number that cannot exist.
    expect(normalizeUzbekPhone('12345')).toBeNull();
    expect(normalizeUzbekPhone('9989012345678')).toBeNull();
  });

  it('rejects a foreign country code of the same length', () => {
    expect(normalizeUzbekPhone('447911123456')).toBeNull();
  });

  it('rejects empty and non-numeric input', () => {
    expect(normalizeUzbekPhone('')).toBeNull();
    expect(normalizeUzbekPhone('not a phone')).toBeNull();
  });
});

describe('classifyTelegramError', () => {
  it('treats a blocked bot as permanent', () => {
    // The chat id is dead; no number of retries revives it.
    expect(classifyTelegramError(403, 'Forbidden: bot was blocked by the user')).toBe(
      'permanent',
    );
  });

  it('treats an unknown chat as permanent', () => {
    expect(classifyTelegramError(400, 'Bad Request: chat not found')).toBe(
      'permanent',
    );
  });

  it('treats a deactivated user as permanent', () => {
    expect(classifyTelegramError(403, 'Forbidden: user is deactivated')).toBe(
      'permanent',
    );
  });

  it('treats a kicked bot as permanent', () => {
    expect(
      classifyTelegramError(403, 'Forbidden: bot was kicked from the group chat'),
    ).toBe('permanent');
  });

  it('treats a bad token as our misconfiguration', () => {
    expect(classifyTelegramError(401, 'Unauthorized')).toBe('misconfigured');
  });

  it('treats rate limiting as transient', () => {
    expect(classifyTelegramError(429, 'Too Many Requests')).toBe('transient');
  });

  it('reads the description, not just the status', () => {
    // Both are 403; only the text distinguishes a dead chat from a transient
    // authorisation glitch.
    expect(classifyTelegramError(403, 'bot was blocked by the user')).toBe(
      'permanent',
    );
    expect(classifyTelegramError(403, 'something transient')).toBe('misconfigured');
  });
});

describe('formatMessage', () => {
  it('bolds the title', () => {
    expect(formatMessage('Approval', 'Body')).toBe('<b>Approval</b>\n\nBody');
  });

  it('escapes HTML in user-controlled text', () => {
    // Notification bodies carry document titles and party names. Unescaped angle
    // brackets make Telegram reject the message outright.
    const message = formatMessage('Contract <Acme & Co>', 'Clause 5 > Clause 4');
    expect(message).not.toMatch(/<(?!\/?b>)/);
    expect(message).toContain('&lt;Acme &amp; Co&gt;');
    expect(message).toContain('Clause 5 &gt; Clause 4');
  });

  it('escapes ampersands before the entities they introduce', () => {
    expect(formatMessage('A', '&lt;')).toContain('&amp;lt;');
  });
});

describe('classifySmtpError', () => {
  it('treats a 5xx response as permanent', () => {
    // 550 (no such mailbox) retried five times is five deliverability complaints
    // against the sending domain.
    expect(classifySmtpError({ responseCode: 550 })).toBe('permanent');
    expect(classifySmtpError({ responseCode: 553 })).toBe('permanent');
  });

  it('treats a 4xx response as transient', () => {
    // SMTP is explicit: 4xx means try again later.
    expect(classifySmtpError({ responseCode: 421 })).toBe('transient');
    expect(classifySmtpError({ responseCode: 450 })).toBe('transient');
  });

  it('treats a connection failure as transient', () => {
    expect(classifySmtpError(new Error('ECONNREFUSED'))).toBe('transient');
    expect(classifySmtpError(new Error('timeout'))).toBe('transient');
  });

  it('treats bad credentials as our misconfiguration', () => {
    expect(classifySmtpError(new Error('Invalid login: 535 auth failed'))).toBe(
      'misconfigured',
    );
  });
});

describe('toHtml', () => {
  it('wraps the body in paragraphs', () => {
    const html = toHtml('Subject', 'First paragraph.\n\nSecond paragraph.');
    expect(html.match(/<p /g)).toHaveLength(3); // two body paragraphs + footer
  });

  it('turns a single newline into a line break', () => {
    expect(toHtml('S', 'Line one\nLine two')).toContain('Line one<br />Line two');
  });

  it('escapes user-controlled text', () => {
    const html = toHtml('<script>alert(1)</script>', 'Acme & Co <b>bold</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Acme &amp; Co');
  });

  it('references no external resources', () => {
    // A remote image makes the message look like tracking to spam filters, and
    // every client strips stylesheets anyway.
    const html = toHtml('S', 'B');
    expect(html).not.toMatch(/<img|<link|https?:\/\//);
  });
});

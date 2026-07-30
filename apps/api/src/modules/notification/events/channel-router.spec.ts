import { NotificationChannel } from '@legaltech/database';
import {
  canDeliverDuringQuietHours,
  isWithinQuietHours,
  localHour,
  msUntilQuietHoursEnd,
  routeEvent,
  type RecipientPreferences,
} from './channel-router';
import { NOTIFICATION_EVENTS, configurableEvents } from './notification-events';

const { IN_APP, EMAIL, SMS, TELEGRAM } = NotificationChannel;

const preferences = (
  overrides: Partial<RecipientPreferences> = {},
): RecipientPreferences => ({
  enabledChannels: [EMAIL, SMS, TELEGRAM],
  email: 'user@example.uz',
  phone: '+998901234567',
  telegramChatId: '123456',
  timezone: 'Asia/Tashkent',
  ...overrides,
});

const channelsOf = (result: ReturnType<typeof routeEvent>) =>
  result.deliver.map((decision) => decision.channel);

describe('isWithinQuietHours', () => {
  it('handles a window inside one day', () => {
    expect(isWithinQuietHours(12, 9, 17)).toBe(true);
    expect(isWithinQuietHours(8, 9, 17)).toBe(false);
    expect(isWithinQuietHours(17, 9, 17)).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    // 22:00–08:00 is how almost everyone configures this, and a naive
    // `start <= h && h < end` comparison silently disables it for all of them.
    expect(isWithinQuietHours(23, 22, 8)).toBe(true);
    expect(isWithinQuietHours(3, 22, 8)).toBe(true);
    expect(isWithinQuietHours(7, 22, 8)).toBe(true);
    expect(isWithinQuietHours(8, 22, 8)).toBe(false);
    expect(isWithinQuietHours(12, 22, 8)).toBe(false);
  });

  it('treats the start hour as inclusive and the end as exclusive', () => {
    expect(isWithinQuietHours(22, 22, 8)).toBe(true);
    expect(isWithinQuietHours(8, 22, 8)).toBe(false);
  });

  it('is disabled when either end is missing', () => {
    expect(isWithinQuietHours(3, null, 8)).toBe(false);
    expect(isWithinQuietHours(3, 22, null)).toBe(false);
    expect(isWithinQuietHours(3, undefined, undefined)).toBe(false);
  });

  it('treats an identical start and end as disabled, not as all day', () => {
    expect(isWithinQuietHours(5, 9, 9)).toBe(false);
  });
});

describe('localHour', () => {
  it('converts to the recipient’s zone', () => {
    // 20:00 UTC is 01:00 the next day in Tashkent (UTC+5).
    const at20Utc = new Date('2026-07-30T20:00:00Z');
    expect(localHour('Asia/Tashkent', at20Utc)).toBe(1);
  });

  it('falls back to UTC with no timezone', () => {
    const at20Utc = new Date('2026-07-30T20:00:00Z');
    expect(localHour(undefined, at20Utc)).toBe(20);
  });

  it('falls back to UTC on an invalid zone rather than throwing', () => {
    // A bad timezone string should degrade the quiet-hours rule, not drop the
    // notification.
    const at20Utc = new Date('2026-07-30T20:00:00Z');
    expect(localHour('Mars/Olympus_Mons', at20Utc)).toBe(20);
  });

  it('handles midnight without reporting 24', () => {
    const atMidnight = new Date('2026-07-30T19:00:00Z'); // 00:00 Tashkent
    expect(localHour('Asia/Tashkent', atMidnight)).toBe(0);
  });
});

describe('routeEvent', () => {
  const daytime = new Date('2026-07-30T09:00:00Z'); // 14:00 Tashkent

  describe('event permissions', () => {
    it('delivers only the channels the event allows', () => {
      // ocr.completed is in-app only, however many channels the user enabled.
      const result = routeEvent('ocr.completed', preferences(), { now: daytime });
      expect(channelsOf(result)).toEqual([IN_APP]);
    });

    it('sends nothing for an unknown event', () => {
      // An unknown key is a caller bug; fanning it out to every channel would turn
      // that bug into an incident.
      const result = routeEvent('does.not.exist', preferences(), { now: daytime });
      expect(result.deliver).toEqual([]);
      expect(result.skipped).toEqual([]);
    });
  });

  describe('user preferences', () => {
    it('always delivers in-app, regardless of preferences', () => {
      const result = routeEvent(
        'document.approval_requested',
        preferences({ enabledChannels: [] }),
        { now: daytime },
      );
      expect(channelsOf(result)).toContain(IN_APP);
    });

    it('skips a channel the user disabled', () => {
      const result = routeEvent(
        'document.approval_requested',
        preferences({ enabledChannels: [EMAIL] }),
        { now: daytime },
      );

      expect(channelsOf(result)).toEqual([IN_APP, EMAIL]);
      expect(result.skipped).toEqual([
        { channel: TELEGRAM, reason: 'USER_DISABLED_CHANNEL' },
      ]);
    });

    it('overrides a disabled channel for a mandatory event', () => {
      // Being told your payment failed is not a marketing preference.
      const result = routeEvent(
        'billing.payment_failed',
        preferences({ enabledChannels: [] }),
        { now: daytime },
      );
      expect(channelsOf(result)).toContain(SMS);
      expect(channelsOf(result)).toContain(EMAIL);
    });
  });

  describe('destinations', () => {
    it('skips a channel with no address on file', () => {
      const result = routeEvent(
        'document.approval_requested',
        preferences({ telegramChatId: null }),
        { now: daytime },
      );

      expect(channelsOf(result)).not.toContain(TELEGRAM);
      expect(result.skipped).toContainEqual({
        channel: TELEGRAM,
        reason: 'NO_DESTINATION',
      });
    });

    it('falls back to the account email when no override is set', () => {
      const result = routeEvent(
        'document.approval_requested',
        preferences({ email: null }),
        { now: daytime, fallbackEmail: 'account@example.uz' },
      );

      const email = result.deliver.find((decision) => decision.channel === EMAIL);
      expect(email?.destination).toBe('account@example.uz');
    });

    it('still needs an address for a mandatory event', () => {
      // There is no sending an SMS to a number we do not have, mandatory or not.
      const result = routeEvent(
        'billing.payment_failed',
        preferences({ phone: null, enabledChannels: [] }),
        { now: daytime },
      );

      expect(channelsOf(result)).not.toContain(SMS);
      expect(result.skipped).toContainEqual({
        channel: SMS,
        reason: 'NO_DESTINATION',
      });
    });

    it('carries the resolved destination for each channel', () => {
      const result = routeEvent('document.approval_requested', preferences(), {
        now: daytime,
      });

      const telegram = result.deliver.find((d) => d.channel === TELEGRAM);
      expect(telegram?.destination).toBe('123456');
      // In-app addresses the user directly and needs no destination.
      const inApp = result.deliver.find((d) => d.channel === IN_APP);
      expect(inApp?.destination).toBeUndefined();
    });
  });

  describe('quiet hours', () => {
    // 22:00 Tashkent, inside a 22–08 window.
    const night = new Date('2026-07-30T17:00:00Z');
    const quiet = preferences({ quietHoursStart: 22, quietHoursEnd: 8 });

    it('holds a normal-urgency event on interruptive channels', () => {
      const result = routeEvent('document.approval_requested', quiet, {
        now: night,
      });

      expect(channelsOf(result)).toEqual([IN_APP]);
      expect(result.skipped).toContainEqual({
        channel: EMAIL,
        reason: 'QUIET_HOURS',
      });
    });

    it('still delivers in-app during quiet hours', () => {
      // In-app does not interrupt anyone; it waits to be looked at.
      const result = routeEvent('document.approval_requested', quiet, {
        now: night,
      });
      expect(channelsOf(result)).toContain(IN_APP);
    });

    it('breaks through for a critical event', () => {
      // A payment failure has a deadline attached; holding it until morning can
      // cost the customer their service.
      const result = routeEvent('billing.payment_failed', quiet, { now: night });
      expect(channelsOf(result)).toContain(SMS);
      expect(channelsOf(result)).toContain(EMAIL);
    });

    it('delivers normally outside the window', () => {
      const result = routeEvent('document.approval_requested', quiet, {
        now: daytime,
      });
      expect(channelsOf(result)).toContain(EMAIL);
    });
  });
});

describe('canDeliverDuringQuietHours', () => {
  it('permits only critical events', () => {
    expect(canDeliverDuringQuietHours('critical')).toBe(true);
    expect(canDeliverDuringQuietHours('normal')).toBe(false);
    expect(canDeliverDuringQuietHours('low')).toBe(false);
  });
});

describe('msUntilQuietHoursEnd', () => {
  it('measures forward to the end of the window', () => {
    // 23:00 Tashkent, window ends at 08:00 → nine hours.
    const at23 = new Date('2026-07-30T18:00:00Z');
    const delay = msUntilQuietHoursEnd(
      preferences({ quietHoursStart: 22, quietHoursEnd: 8 }),
      at23,
    );
    expect(delay).toBe(9 * 60 * 60 * 1000);
  });

  it('handles being past midnight already', () => {
    // 03:00 Tashkent → five hours to 08:00.
    const at3 = new Date('2026-07-30T22:00:00Z');
    const delay = msUntilQuietHoursEnd(
      preferences({ quietHoursStart: 22, quietHoursEnd: 8 }),
      at3,
    );
    expect(delay).toBe(5 * 60 * 60 * 1000);
  });

  it('returns zero when no window is configured', () => {
    expect(msUntilQuietHoursEnd(preferences())).toBe(0);
  });
});

describe('event catalogue', () => {
  it('gives every event at least one channel', () => {
    for (const event of Object.values(NOTIFICATION_EVENTS)) {
      expect(event.channels.length).toBeGreaterThan(0);
    }
  });

  it('keys each event by its own key', () => {
    for (const [key, event] of Object.entries(NOTIFICATION_EVENTS)) {
      expect(event.key).toBe(key);
    }
  });

  it('reserves SMS for critical events only', () => {
    // SMS costs money per message and interrupts. Spending it on routine events
    // trains users to ignore it.
    for (const event of Object.values(NOTIFICATION_EVENTS)) {
      if (event.channels.includes(SMS)) {
        expect(event.urgency).toBe('critical');
      }
    }
  });

  it('keeps low-urgency events off interruptive channels entirely', () => {
    for (const event of Object.values(NOTIFICATION_EVENTS)) {
      if (event.urgency === 'low') {
        expect(event.channels).not.toContain(SMS);
        expect(event.channels).not.toContain(TELEGRAM);
      }
    }
  });

  it('excludes mandatory events from the configurable list', () => {
    // Offering a toggle that does nothing is worse than offering none.
    for (const event of configurableEvents()) {
      expect(event.mandatory).toBeFalsy();
    }
  });

  it('marks security and billing-failure events mandatory', () => {
    expect(NOTIFICATION_EVENTS['security.account_locked'].mandatory).toBe(true);
    expect(NOTIFICATION_EVENTS['billing.payment_failed'].mandatory).toBe(true);
    expect(
      NOTIFICATION_EVENTS['security.impersonation_started'].mandatory,
    ).toBe(true);
  });
});

/**
 * Deciding which channels an event actually reaches.
 *
 * Three inputs have to agree: what the event permits, what the user accepts, and
 * whether the address to reach them on exists. Pure functions, because this is
 * where an accidental "always send" or "never send" hides — and both are bad in
 * ways that only show up in production.
 */
import { NotificationChannel } from '@legaltech/database';
import { getEventDefinition, type NotificationUrgency } from './notification-events';

export interface RecipientPreferences {
  enabledChannels: NotificationChannel[];
  email?: string | null;
  phone?: string | null;
  telegramChatId?: string | null;
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
  timezone?: string;
}

export interface RoutingDecision {
  channel: NotificationChannel;
  destination?: string;
}

export interface RoutingResult {
  deliver: RoutingDecision[];
  /** Channels not used, with why — surfaced in the notification row as SKIPPED. */
  skipped: { channel: NotificationChannel; reason: SkipReason }[];
}

export type SkipReason =
  | 'EVENT_DOES_NOT_USE_CHANNEL'
  | 'USER_DISABLED_CHANNEL'
  | 'NO_DESTINATION'
  | 'QUIET_HOURS';

/**
 * Whether a local hour falls inside a quiet window.
 *
 * Handles the wrap across midnight, which is the normal case: quiet hours run
 * 22:00–08:00 far more often than 09:00–17:00, and a naive `start <= h && h < end`
 * comparison silently disables the feature for everyone who configured it the
 * usual way.
 */
export function isWithinQuietHours(
  hour: number,
  start: number | null | undefined,
  end: number | null | undefined,
): boolean {
  if (start === null || start === undefined) return false;
  if (end === null || end === undefined) return false;
  if (start === end) return false; // Degenerate window; treat as disabled.

  if (start < end) return hour >= start && hour < end;

  // Wraps midnight: 22 → 8 means 22, 23, 0…7.
  return hour >= start || hour < end;
}

/**
 * The recipient's local hour.
 *
 * Uses `Intl` rather than a fixed offset: Uzbekistan does not observe DST, but
 * users elsewhere do, and a stored offset would be an hour wrong for half the
 * year. Falls back to UTC on an invalid zone rather than throwing — a bad
 * timezone string should degrade the quiet-hours rule, not drop the
 * notification.
 */
export function localHour(timezone: string | undefined, now = new Date()): number {
  if (!timezone) return now.getUTCHours();

  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(now);

    const hour = Number.parseInt(formatted, 10);
    return Number.isFinite(hour) ? hour % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/** Channels that interrupt someone. IN_APP does not; it waits to be looked at. */
const INTERRUPTIVE: NotificationChannel[] = [
  NotificationChannel.EMAIL,
  NotificationChannel.SMS,
  NotificationChannel.TELEGRAM,
];

function destinationFor(
  channel: NotificationChannel,
  preferences: RecipientPreferences,
  fallbackEmail?: string,
): string | undefined {
  switch (channel) {
    case NotificationChannel.EMAIL:
      return preferences.email ?? fallbackEmail ?? undefined;
    case NotificationChannel.SMS:
      return preferences.phone ?? undefined;
    case NotificationChannel.TELEGRAM:
      // Telegram cannot be messaged first — a chat id only exists once the user
      // has contacted the bot. Its absence is normal, not a misconfiguration.
      return preferences.telegramChatId ?? undefined;
    case NotificationChannel.IN_APP:
    default:
      return undefined;
  }
}

/**
 * Resolves the channels for one recipient.
 *
 * IN_APP is always delivered when the event allows it, regardless of preferences:
 * it is the user's own inbox and there is nothing to opt out of. Mandatory events
 * bypass the channel opt-out but still respect a missing address — there is no
 * sending an SMS to a phone number we do not have.
 */
export function routeEvent(
  eventKey: string,
  preferences: RecipientPreferences,
  options: { fallbackEmail?: string; now?: Date } = {},
): RoutingResult {
  const definition = getEventDefinition(eventKey);

  if (!definition) {
    // An unknown event key is a bug in the caller. Delivering it to every channel
    // would turn that bug into an incident, so nothing is sent.
    return { deliver: [], skipped: [] };
  }

  const deliver: RoutingDecision[] = [];
  const skipped: RoutingResult['skipped'] = [];

  const hour = localHour(preferences.timezone, options.now);
  const quiet = isWithinQuietHours(
    hour,
    preferences.quietHoursStart,
    preferences.quietHoursEnd,
  );

  for (const channel of Object.values(NotificationChannel)) {
    if (!definition.channels.includes(channel)) {
      // Not listed for this event; not a skip worth recording.
      continue;
    }

    if (channel === NotificationChannel.IN_APP) {
      deliver.push({ channel });
      continue;
    }

    const optedIn =
      definition.mandatory || preferences.enabledChannels.includes(channel);

    if (!optedIn) {
      skipped.push({ channel, reason: 'USER_DISABLED_CHANNEL' });
      continue;
    }

    if (
      quiet &&
      INTERRUPTIVE.includes(channel) &&
      !canDeliverDuringQuietHours(definition.urgency)
    ) {
      skipped.push({ channel, reason: 'QUIET_HOURS' });
      continue;
    }

    const destination = destinationFor(channel, preferences, options.fallbackEmail);
    if (!destination) {
      skipped.push({ channel, reason: 'NO_DESTINATION' });
      continue;
    }

    deliver.push({ channel, destination });
  }

  return { deliver, skipped };
}

/**
 * Only `critical` events break through quiet hours.
 *
 * `low` never touches an interruptive channel at all, so it never reaches this;
 * `normal` is held rather than dropped — the caller re-queues it with a delay.
 */
export function canDeliverDuringQuietHours(urgency: NotificationUrgency): boolean {
  return urgency === 'critical';
}

/**
 * Delay until quiet hours end, in milliseconds.
 *
 * A held `normal` notification is re-queued with this delay instead of being
 * dropped: an approval request that arrives at 23:00 still matters at 08:00, and
 * discarding it loses information the user needed.
 */
export function msUntilQuietHoursEnd(
  preferences: RecipientPreferences,
  now = new Date(),
): number {
  const end = preferences.quietHoursEnd;
  if (end === null || end === undefined) return 0;

  const hour = localHour(preferences.timezone, now);
  const hoursUntil = hour < end ? end - hour : 24 - hour + end;

  // Rounded to the hour boundary rather than the exact minute: a stampede of
  // held notifications all firing on the same second is worse than a few minutes
  // of imprecision.
  return hoursUntil * 60 * 60 * 1000;
}

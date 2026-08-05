import type { JobsOptions } from 'bullmq';
import type { NotificationChannel } from '@legaltech/database';

/**
 * One queue per channel, not one queue for all notifications.
 *
 * The channels fail differently and at different rates: the SMS gateway enforces
 * its own throughput limits, Telegram allows one message per second per chat, and SMTP
 * connections are slow to establish. Sharing a queue means a stalled SMS provider
 * holds up every email behind it — and the emails are usually the ones carrying
 * the deadline.
 */
/**
 * Hyphen-separated, not colon-separated. BullMQ uses `:` to build its own Redis
 * key structure (`bull:<queue>:<id>`) and rejects a queue name containing one
 * outright — "Queue name cannot contain :", thrown at module init, so the API
 * does not boot at all.
 */
export const QUEUE_NAMES = {
  EMAIL: 'notifications-email',
  SMS: 'notifications-sms',
  TELEGRAM: 'notifications-telegram',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** The payload every channel worker receives. */
export interface NotificationJob {
  /** `Notification.id` — the row the worker updates as it progresses. */
  notificationId: string;
  channel: NotificationChannel;
  destination: string;
  title: string;
  body: string;
  event: string;
  /** For log correlation and per-tenant rate accounting. */
  companyId?: string;
  userId?: string;
}

/**
 * Default retry policy.
 *
 * Exponential from 5 seconds: a provider that just rate-limited us will still be
 * rate-limiting us a second later, and retrying immediately converts one 429 into
 * five. Five attempts across roughly 80 seconds of backoff covers a provider
 * blip; beyond that the failure is not transient and a human should see it.
 *
 * `removeOnComplete` keeps a window of recent successes for debugging without
 * letting Redis grow without bound — the durable record is the `Notification`
 * row, not the job.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  // Failures are kept far longer: they are the ones worth inspecting.
  removeOnFail: { age: 24 * 3600 },
};

/**
 * Per-queue worker limits.
 *
 * These are throughput ceilings, chosen from what each provider tolerates rather
 * than from what this service can produce.
 */
export const WORKER_LIMITS: Record<
  QueueName,
  { concurrency: number; limiter?: { max: number; duration: number } }
> = {
  // SMTP handshakes are slow and most providers cap concurrent connections.
  [QUEUE_NAMES.EMAIL]: {
    concurrency: 5,
    limiter: { max: 100, duration: 60_000 },
  },
  // DevSMS publishes no hard figure; this is deliberately conservative because
  // exceeding it gets an account throttled rather than individual messages
  // rejected, which is much harder to notice.
  [QUEUE_NAMES.SMS]: {
    concurrency: 2,
    limiter: { max: 60, duration: 60_000 },
  },
  // Telegram's documented ceiling is 30 messages/second overall. Well under it:
  // the bot API responds to a burst by returning 429 with a retry_after, and
  // respecting that is cheaper than recovering from it.
  [QUEUE_NAMES.TELEGRAM]: {
    concurrency: 3,
    limiter: { max: 20, duration: 1000 },
  },
};

export function queueForChannel(channel: NotificationChannel): QueueName | null {
  switch (channel) {
    case 'EMAIL':
      return QUEUE_NAMES.EMAIL;
    case 'SMS':
      return QUEUE_NAMES.SMS;
    case 'TELEGRAM':
      return QUEUE_NAMES.TELEGRAM;
    // IN_APP is a local write plus a socket push. Queuing it would add latency
    // and a failure mode to something that cannot fail independently of the
    // database it already needs.
    case 'IN_APP':
    default:
      return null;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../providers/email.service';
import { DevSmsService } from '../providers/devsms.service';
import { TelegramService } from '../providers/telegram.service';
import {
  BaseNotificationProcessor,
  type DeliveryOutcome,
} from './notification.processor';
import { QUEUE_NAMES, WORKER_LIMITS, type NotificationJob } from './queue.constants';

/**
 * Email worker.
 *
 * Concurrency and rate are bounded by what mail providers tolerate rather than by
 * what this service can produce — a burst of a thousand emails is the fastest way
 * to get a sending domain throttled, and a throttled domain affects every later
 * message including the ones that matter.
 */
@Injectable()
@Processor(QUEUE_NAMES.EMAIL, {
  concurrency: WORKER_LIMITS[QUEUE_NAMES.EMAIL].concurrency,
  limiter: WORKER_LIMITS[QUEUE_NAMES.EMAIL].limiter,
})
export class EmailProcessor extends BaseNotificationProcessor {
  protected readonly logger = new Logger(EmailProcessor.name);

  constructor(
    prisma: PrismaService,
    private readonly email: EmailService,
  ) {
    super(prisma);
  }

  protected deliver(job: NotificationJob): Promise<DeliveryOutcome> {
    return this.email.send(job.destination, job.title, job.body);
  }
}

/**
 * SMS worker.
 *
 * The tightest limits of the three, for two reasons: every attempt is billable, and
 * an SMS gateway responds to sustained excess by throttling the account rather than
 * rejecting individual messages — which is much harder to notice than an error.
 */
@Injectable()
@Processor(QUEUE_NAMES.SMS, {
  concurrency: WORKER_LIMITS[QUEUE_NAMES.SMS].concurrency,
  limiter: WORKER_LIMITS[QUEUE_NAMES.SMS].limiter,
})
export class SmsProcessor extends BaseNotificationProcessor {
  protected readonly logger = new Logger(SmsProcessor.name);

  constructor(
    prisma: PrismaService,
    private readonly sms: DevSmsService,
  ) {
    super(prisma);
  }

  protected deliver(job: NotificationJob): Promise<DeliveryOutcome> {
    // SMS carries no title: a 160-character budget spent on a subject line is a
    // budget not spent on the message. The title is folded into the body upstream
    // by the template.
    return this.sms.send(job.destination, composeSms(job.title, job.body));
  }
}

/**
 * Telegram worker.
 *
 * Allowed the most throughput of the three — Telegram's ceiling is 30 messages a
 * second and messages are free — but still well under it, because the Bot API
 * answers a burst with a 429 carrying a `retry_after` that the base processor then
 * has to honour.
 */
@Injectable()
@Processor(QUEUE_NAMES.TELEGRAM, {
  concurrency: WORKER_LIMITS[QUEUE_NAMES.TELEGRAM].concurrency,
  limiter: WORKER_LIMITS[QUEUE_NAMES.TELEGRAM].limiter,
})
export class TelegramProcessor extends BaseNotificationProcessor {
  protected readonly logger = new Logger(TelegramProcessor.name);

  constructor(
    prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {
    super(prisma);
  }

  protected deliver(job: NotificationJob): Promise<DeliveryOutcome> {
    return this.telegram.send(job.destination, job.title, job.body);
  }
}

/**
 * Folds a notification into one SMS.
 *
 * Kept under 160 characters where possible. Beyond that the message is billed as a
 * multipart SMS — two or three times the cost for one notification — and Cyrillic
 * makes this much easier to hit than it looks: a UCS-2 encoded message carries only
 * 70 characters per part, so a Russian-language notification is over the line at a
 * third of the length an English one would be.
 */
export function composeSms(title: string, body: string): string {
  const combined = `${title}: ${body}`.replace(/\s+/g, ' ').trim();

  const hasCyrillic = /[Ѐ-ӿ]/.test(combined);
  // 70 for UCS-2, 160 for GSM-7. Three characters are reserved for the ellipsis.
  const budget = hasCyrillic ? 70 : 160;

  if (combined.length <= budget) return combined;

  const cut = combined.slice(0, budget - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > budget * 0.6 ? lastSpace : budget - 1)}…`;
}

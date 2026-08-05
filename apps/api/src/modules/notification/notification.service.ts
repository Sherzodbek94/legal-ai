import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  NotificationChannel,
  NotificationStatus,
  Prisma,
} from '@legaltech/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationGateway } from './gateway/notification.gateway';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  queueForChannel,
  type NotificationJob,
} from './queues/queue.constants';
import {
  msUntilQuietHoursEnd,
  routeEvent,
  type RecipientPreferences,
} from './events/channel-router';
import { getEventDefinition } from './events/notification-events';

export interface DispatchInput {
  /** Event key from the catalogue. */
  event: string;
  /** Recipient. */
  userId: string;
  companyId?: string;
  title: string;
  body: string;
  /** Structured payload for in-app rendering and deep links. */
  data?: Record<string, unknown>;
  /**
   * Collapses duplicates.
   *
   * Supply something stable and specific — `approval:${documentId}:${stepId}` —
   * so a reminder job that runs twice produces one notification.
   */
  dedupeKey?: string;
}

export interface DispatchResult {
  notificationIds: string[];
  delivered: NotificationChannel[];
  skipped: { channel: NotificationChannel; reason: string }[];
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationGateway,
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly emailQueue: Queue<NotificationJob>,
    @InjectQueue(QUEUE_NAMES.SMS) private readonly smsQueue: Queue<NotificationJob>,
    @InjectQueue(QUEUE_NAMES.TELEGRAM)
    private readonly telegramQueue: Queue<NotificationJob>,
  ) {}

  /**
   * Fans one event out across the channels it should reach.
   *
   * The in-app copy is written and pushed synchronously; the external channels are
   * queued. That asymmetry is deliberate — the in-app notification is a row in a
   * database this request is already talking to, so queuing it would add latency
   * and a failure mode to something that cannot fail independently. The external
   * channels talk to third parties over the network and belong on a queue with
   * retries.
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const definition = getEventDefinition(input.event);
    if (!definition) {
      // An unknown key is a caller bug. Sending to every channel would turn it
      // into an incident, so nothing is sent and it is logged loudly.
      this.logger.error(
        `Unknown notification event "${input.event}"; nothing dispatched`,
      );
      return { notificationIds: [], delivered: [], skipped: [] };
    }

    const recipient = await this.loadRecipient(input.userId);
    if (!recipient) {
      return { notificationIds: [], delivered: [], skipped: [] };
    }

    const routing = routeEvent(input.event, recipient.preferences, {
      fallbackEmail: recipient.email ?? undefined,
    });

    const notificationIds: string[] = [];
    const delivered: NotificationChannel[] = [];

    for (const target of routing.deliver) {
      const notification = await this.createNotification(input, target.channel, target.destination);

      // Null means the dedupe key already existed — an earlier dispatch of the
      // same event already handled it, and this one has nothing to do.
      if (!notification) continue;

      notificationIds.push(notification.id);
      delivered.push(target.channel);

      if (target.channel === NotificationChannel.IN_APP) {
        this.pushInApp(input, notification.id, recipient.userId);
        continue;
      }

      await this.enqueue(notification.id, target.channel, target.destination!, input);
    }

    // Skipped channels are recorded, not discarded. "Why did I not get an SMS"
    // is a support question, and the answer has to be in the data.
    for (const skip of routing.skipped) {
      const notification = await this.createNotification(
        input,
        skip.channel,
        undefined,
        NotificationStatus.SKIPPED,
        skip.reason,
      );
      if (notification) notificationIds.push(notification.id);
    }

    // A `normal` event held by quiet hours is re-queued rather than dropped: an
    // approval request arriving at 23:00 still matters at 08:00.
    await this.rescheduleHeldChannels(input, routing, recipient);

    return {
      notificationIds,
      delivered,
      skipped: routing.skipped.map((skip) => ({
        channel: skip.channel,
        reason: skip.reason,
      })),
    };
  }

  /** Dispatches one event to several recipients. */
  async dispatchMany(
    inputs: DispatchInput[],
  ): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const input of inputs) {
      try {
        results.push(await this.dispatch(input));
      } catch (error) {
        // One recipient's failure must not stop the rest — a notification fan-out
        // to an approval chain should reach the other approvers.
        this.logger.error(
          `Dispatch failed for user ${input.userId}: ${
            (error as Error)?.message ?? 'unknown error'
          }`,
        );
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // In-app inbox
  // ---------------------------------------------------------------------------

  async listForUser(
    userId: string,
    options: { unreadOnly?: boolean; take?: number; cursor?: string } = {},
  ) {
    const take = Math.min(options.take ?? 30, 100);

    const rows = await this.prisma.client.notification.findMany({
      where: {
        userId,
        channel: NotificationChannel.IN_APP,
        ...(options.unreadOnly ? { readAt: null } : {}),
      },
      take: take + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        event: true,
        title: true,
        body: true,
        data: true,
        readAt: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async countUnread(userId: string): Promise<number> {
    return this.prisma.client.notification.count({
      where: { userId, channel: NotificationChannel.IN_APP, readAt: null },
    });
  }

  /**
   * Marks a notification read.
   *
   * Scoped by userId so an id belonging to someone else does not resolve — an
   * unscoped update would let any authenticated user mark another's notifications
   * read, which is a small but real information leak about what ids exist.
   */
  async markRead(notificationId: string, userId: string): Promise<void> {
    const { count } = await this.prisma.client.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (count === 0) {
      // Either already read or not theirs. Both are indistinguishable to the
      // caller by design.
      const exists = await this.prisma.client.notification.findFirst({
        where: { id: notificationId, userId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Notification not found');
    }

    this.gateway.pushToUser(userId, 'notification.read', { id: notificationId });
  }

  async markAllRead(userId: string): Promise<number> {
    const { count } = await this.prisma.client.notification.updateMany({
      where: { userId, channel: NotificationChannel.IN_APP, readAt: null },
      data: { readAt: new Date() },
    });

    this.gateway.pushToUser(userId, 'notification.all_read', { count });
    return count;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async loadRecipient(userId: string) {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        lockedAt: true,
        notificationPreference: true,
      },
    });

    if (!user) {
      this.logger.warn(`Notification for unknown or deleted user ${userId}`);
      return null;
    }

    // A suspended account is not sent anything. Continuing to email someone whose
    // access was revoked for abuse is both pointless and a way to keep engaging
    // with a party you have decided to stop dealing with.
    if (user.lockedAt) {
      this.logger.debug(`Skipping notification for locked user ${userId}`);
      return null;
    }

    const preference = user.notificationPreference;

    const preferences: RecipientPreferences = {
      // No preference row means defaults, not silence: a user who has never
      // opened the settings screen should still get their email notifications.
      enabledChannels: preference?.enabledChannels ?? [
        NotificationChannel.IN_APP,
        NotificationChannel.EMAIL,
      ],
      email: preference?.email ?? user.email,
      phone: preference?.phone ?? null,
      telegramChatId: preference?.telegramChatId ?? null,
      quietHoursStart: preference?.quietHoursStart ?? null,
      quietHoursEnd: preference?.quietHoursEnd ?? null,
      timezone: preference?.timezone ?? 'Asia/Tashkent',
    };

    return { userId: user.id, email: user.email, preferences };
  }

  /**
   * Creates a notification row, or returns null if the dedupe key is taken.
   *
   * The unique constraint does the work. A pre-insert existence check is something
   * two concurrent dispatches can both pass, which is exactly the case dedupe
   * exists to prevent.
   */
  private async createNotification(
    input: DispatchInput,
    channel: NotificationChannel,
    destination?: string,
    status: NotificationStatus = NotificationStatus.PENDING,
    skipReason?: string,
  ) {
    // The key is per channel: the same event legitimately produces one in-app and
    // one email row, and a single key across both would suppress the second.
    const dedupeKey = input.dedupeKey
      ? `${input.dedupeKey}:${channel}`
      : undefined;

    try {
      return await this.prisma.client.notification.create({
        data: {
          companyId: input.companyId,
          userId: input.userId,
          event: input.event,
          channel,
          status,
          title: input.title.slice(0, 300),
          body: input.body.slice(0, 4000),
          data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
          destination,
          dedupeKey,
          lastError: skipReason,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.debug(
          `Suppressed duplicate notification for ${dedupeKey}`,
        );
        return null;
      }
      throw error;
    }
  }

  private pushInApp(
    input: DispatchInput,
    notificationId: string,
    userId: string,
  ): void {
    // Marked SENT immediately: the durable row is the delivery, and whether a
    // socket happened to be open is not part of whether the user was notified.
    void this.prisma.client.notification
      .update({
        where: { id: notificationId },
        data: { status: NotificationStatus.SENT, sentAt: new Date() },
      })
      .catch((error: Error) => {
        this.logger.error(
          `Failed to mark in-app notification ${notificationId} sent: ${error.message}`,
        );
      });

    this.gateway.pushToUser(userId, 'notification.created', {
      id: notificationId,
      event: input.event,
      title: input.title,
      body: input.body,
      data: input.data,
      createdAt: new Date().toISOString(),
    });
  }

  private async enqueue(
    notificationId: string,
    channel: NotificationChannel,
    destination: string,
    input: DispatchInput,
    delayMs = 0,
  ): Promise<void> {
    const queueName = queueForChannel(channel);
    if (!queueName) return;

    const job: NotificationJob = {
      notificationId,
      channel,
      destination,
      title: input.title,
      body: input.body,
      event: input.event,
      companyId: input.companyId,
      userId: input.userId,
    };

    const queue = this.queueFor(queueName);

    await queue.add(input.event, job, {
      ...DEFAULT_JOB_OPTIONS,
      ...(delayMs > 0 ? { delay: delayMs } : {}),
      // The job id is the notification id, so BullMQ itself refuses a duplicate
      // enqueue of the same notification — a second layer under the database
      // constraint, covering the case where dispatch is retried after the row
      // was created but before the job was added.
      jobId: notificationId,
    });

    await this.prisma.client.notification.update({
      where: { id: notificationId },
      data: { status: NotificationStatus.QUEUED },
    });
  }

  /** Re-queues interruptive channels held by quiet hours. */
  private async rescheduleHeldChannels(
    input: DispatchInput,
    routing: ReturnType<typeof routeEvent>,
    recipient: { preferences: RecipientPreferences },
  ): Promise<void> {
    const held = routing.skipped.filter((skip) => skip.reason === 'QUIET_HOURS');
    if (held.length === 0) return;

    const delayMs = msUntilQuietHoursEnd(recipient.preferences);
    if (delayMs <= 0) return;

    for (const skip of held) {
      const destination = destinationForChannel(skip.channel, recipient.preferences);
      if (!destination) continue;

      const notification = await this.createNotification(
        input,
        skip.channel,
        destination,
        NotificationStatus.PENDING,
      );
      if (!notification) continue;

      await this.enqueue(
        notification.id,
        skip.channel,
        destination,
        input,
        delayMs,
      );

      this.logger.debug(
        `Held ${skip.channel} notification for ${input.userId} until quiet hours end (${Math.round(delayMs / 60_000)}m)`,
      );
    }
  }

  private queueFor(name: string): Queue<NotificationJob> {
    switch (name) {
      case QUEUE_NAMES.SMS:
        return this.smsQueue;
      case QUEUE_NAMES.TELEGRAM:
        return this.telegramQueue;
      case QUEUE_NAMES.EMAIL:
      default:
        return this.emailQueue;
    }
  }
}

function destinationForChannel(
  channel: NotificationChannel,
  preferences: RecipientPreferences,
): string | undefined {
  switch (channel) {
    case NotificationChannel.EMAIL:
      return preferences.email ?? undefined;
    case NotificationChannel.SMS:
      return preferences.phone ?? undefined;
    case NotificationChannel.TELEGRAM:
      return preferences.telegramChatId ?? undefined;
    default:
      return undefined;
  }
}

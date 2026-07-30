import { Logger } from '@nestjs/common';
import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { NotificationStatus } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { DeliveryError } from '../providers/delivery-error';
import type { NotificationJob } from './queue.constants';

export interface DeliveryOutcome {
  providerMessageId?: string;
}

/**
 * Shared behaviour for every channel worker.
 *
 * The three channels differ only in which provider they call; everything around
 * that call — recording the attempt, classifying the failure, deciding whether to
 * retry — is identical and belongs in one place. Reimplementing it per channel is
 * how one channel ends up retrying permanent failures forever while another
 * gives up on a transient blip.
 */
export abstract class BaseNotificationProcessor extends WorkerHost {
  protected abstract readonly logger: Logger;

  constructor(protected readonly prisma: PrismaService) {
    super();
  }

  /** Hands the message to the provider. Throws DeliveryError on failure. */
  protected abstract deliver(job: NotificationJob): Promise<DeliveryOutcome>;

  async process(job: Job<NotificationJob>): Promise<DeliveryOutcome> {
    const { notificationId, channel, destination } = job.data;

    await this.prisma.client.notification.update({
      where: { id: notificationId },
      data: { attempts: { increment: 1 } },
    });

    try {
      const outcome = await this.deliver(job.data);

      await this.prisma.client.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          providerMessageId: outcome.providerMessageId,
          lastError: null,
        },
      });

      this.logger.log(
        `Delivered ${channel} notification ${notificationId} to ${redact(destination)}`,
      );

      return outcome;
    } catch (error) {
      await this.handleFailure(job, error);
      // Unreachable: handleFailure always throws. Present so the compiler sees a
      // total function.
      throw error;
    }
  }

  /**
   * Records the failure and decides whether BullMQ should try again.
   *
   * `UnrecoverableError` is what stops the retry chain — throwing an ordinary
   * error would burn all five attempts against a phone number that cannot exist
   * or a bot the user has blocked. For SMS each of those attempts is billable, so
   * getting this wrong costs money as well as time.
   */
  private async handleFailure(
    job: Job<NotificationJob>,
    error: unknown,
  ): Promise<never> {
    const { notificationId, channel } = job.data;

    const delivery =
      error instanceof DeliveryError
        ? error
        : new DeliveryError(
            (error as Error)?.message ?? 'unknown error',
            // An unclassified exception is treated as transient. Being wrong in
            // this direction wastes a retry; being wrong the other way silently
            // drops a notification.
            'transient',
          );

    const attemptsMade = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const willRetry = delivery.retryable && attemptsMade < maxAttempts;

    await this.prisma.client.notification.update({
      where: { id: notificationId },
      data: {
        // Kept QUEUED while retries remain, so the UI does not report a failure
        // that has not happened yet.
        status: willRetry ? NotificationStatus.QUEUED : NotificationStatus.FAILED,
        lastError: `${delivery.kind}: ${delivery.message}`.slice(0, 1000),
      },
    });

    const level = delivery.kind === 'transient' ? 'warn' : 'error';
    this.logger[level](
      `${channel} notification ${notificationId} failed (${delivery.kind}, attempt ${attemptsMade}/${maxAttempts}): ${delivery.message}`,
    );

    if (!delivery.retryable) {
      throw new UnrecoverableError(`${delivery.kind}: ${delivery.message}`);
    }

    // A provider-supplied backoff beats ours: Telegram's 429 says exactly how long
    // to wait, and guessing shorter just earns another 429.
    if (delivery.retryAfterMs && delivery.retryAfterMs > 0) {
      await job.moveToDelayed(Date.now() + delivery.retryAfterMs, job.token);
    }

    throw delivery;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<NotificationJob> | undefined, error: Error): void {
    if (!job) return;

    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (exhausted) {
      this.logger.error(
        `Giving up on ${job.data.channel} notification ${job.data.notificationId}: ${error.message}`,
      );
    }
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    // Worker-level rather than job-level: usually a lost Redis connection.
    this.logger.error(`Worker error: ${error.message}`);
  }
}

/**
 * Masks a recipient address for logging.
 *
 * Notification logs are read routinely during support work and shipped to
 * whatever aggregator is configured. A phone number or email address in every line
 * turns operational logging into a standing personal-data export.
 */
export function redact(destination: string | undefined): string {
  if (!destination) return '(none)';

  if (destination.includes('@')) {
    const [local, domain] = destination.split('@');
    const visible = local.slice(0, 2);
    return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }

  // Phone or chat id: keep the last three digits, which is enough to correlate
  // with a user's own report without identifying them from the log alone.
  if (destination.length <= 4) return '*'.repeat(destination.length);
  return `${'*'.repeat(destination.length - 3)}${destination.slice(-3)}`;
}

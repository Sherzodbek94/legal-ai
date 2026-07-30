/**
 * Queue processor behaviour.
 *
 * The property under test is the retry decision. A permanent failure retried five
 * times costs five billable SMS attempts and delays every job behind it; a
 * transient failure not retried silently drops a notification. Both are invisible
 * without a test that asserts which happened.
 */
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { NotificationChannel, NotificationStatus } from '@legaltech/database';
import {
  BaseNotificationProcessor,
  redact,
  type DeliveryOutcome,
} from './notification.processor';
import { DeliveryError } from '../providers/delivery-error';
import { composeSms } from './channel.processors';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { NotificationJob } from './queue.constants';

interface UpdateCall {
  where: { id: string };
  data: Record<string, unknown>;
}

function makePrisma() {
  const updates: UpdateCall[] = [];

  const prisma = {
    client: {
      notification: {
        update: jest.fn(async (call: UpdateCall) => {
          updates.push(call);
          return { id: call.where.id };
        }),
      },
    },
  } as unknown as PrismaService;

  return { prisma, updates };
}

/** Concrete processor whose delivery outcome the test controls. */
class TestProcessor extends BaseNotificationProcessor {
  protected readonly logger = new Logger('TestProcessor');

  constructor(
    prisma: PrismaService,
    private readonly behaviour: () => Promise<DeliveryOutcome>,
  ) {
    super(prisma);
  }

  protected deliver(): Promise<DeliveryOutcome> {
    return this.behaviour();
  }
}

const jobData: NotificationJob = {
  notificationId: 'notif_1',
  channel: NotificationChannel.SMS,
  destination: '998901234567',
  title: 'Approval required',
  body: 'A document is waiting on your approval.',
  event: 'document.approval_requested',
  companyId: 'co_1',
  userId: 'user_1',
};

function makeJob(overrides: Partial<Job<NotificationJob>> = {}): Job<NotificationJob> {
  return {
    data: jobData,
    attemptsMade: 0,
    opts: { attempts: 5 },
    token: 'token',
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Job<NotificationJob>;
}

describe('BaseNotificationProcessor', () => {
  describe('success', () => {
    it('marks the notification sent and records the provider id', async () => {
      const { prisma, updates } = makePrisma();
      const processor = new TestProcessor(prisma, async () => ({
        providerMessageId: 'provider-42',
      }));

      const outcome = await processor.process(makeJob());

      expect(outcome.providerMessageId).toBe('provider-42');

      const final = updates[updates.length - 1];
      expect(final.data).toMatchObject({
        status: NotificationStatus.SENT,
        providerMessageId: 'provider-42',
        lastError: null,
      });
    });

    it('counts the attempt before delivering', async () => {
      const { prisma, updates } = makePrisma();
      const processor = new TestProcessor(prisma, async () => ({}));

      await processor.process(makeJob());

      // Incremented up front so a worker that dies mid-delivery still shows the
      // attempt — otherwise a crash loop looks like it never tried.
      expect(updates[0].data).toEqual({ attempts: { increment: 1 } });
    });

    it('clears a previous error on a later success', async () => {
      const { prisma, updates } = makePrisma();
      const processor = new TestProcessor(prisma, async () => ({}));

      await processor.process(makeJob({ attemptsMade: 2 }));

      expect(updates[updates.length - 1].data).toMatchObject({ lastError: null });
    });
  });

  describe('permanent failures', () => {
    it('throws UnrecoverableError so BullMQ stops retrying', async () => {
      // An invalid number will not become valid, and each SMS attempt is billable.
      const { prisma } = makePrisma();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('invalid number', 'permanent');
      });

      await expect(processor.process(makeJob())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it('marks the notification FAILED immediately, not after the retries', async () => {
      const { prisma, updates } = makePrisma();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('bot was blocked by the user', 'permanent');
      });

      await expect(processor.process(makeJob())).rejects.toThrow();

      expect(updates[updates.length - 1].data).toMatchObject({
        status: NotificationStatus.FAILED,
      });
    });

    it('stops retrying a misconfiguration too', async () => {
      // A missing API key is our problem; hammering the provider does not fix it.
      const { prisma } = makePrisma();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('no API key', 'misconfigured');
      });

      await expect(processor.process(makeJob())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it('records the failure kind alongside the message', async () => {
      const { prisma, updates } = makePrisma();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('chat not found', 'permanent');
      });

      await expect(processor.process(makeJob())).rejects.toThrow();

      expect(updates[updates.length - 1].data.lastError).toBe(
        'permanent: chat not found',
      );
    });
  });

  describe('transient failures', () => {
    it('rethrows so BullMQ retries', async () => {
      const { prisma } = makePrisma();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('gateway timeout', 'transient');
      });

      const error = await processor.process(makeJob()).catch((caught) => caught);

      expect(error).toBeInstanceOf(DeliveryError);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
    });

    it('keeps the notification QUEUED while attempts remain', async () => {
      // Reporting FAILED on attempt 1 of 5 would show the user a failure that has
      // not happened yet.
      const { prisma, updates } = makePrisma();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('503', 'transient');
      });

      await expect(processor.process(makeJob({ attemptsMade: 0 }))).rejects.toThrow();

      expect(updates[updates.length - 1].data).toMatchObject({
        status: NotificationStatus.QUEUED,
      });
    });

    it('marks FAILED once the final attempt is exhausted', async () => {
      const { prisma, updates } = makePrisma();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('503', 'transient');
      });

      await expect(
        processor.process(makeJob({ attemptsMade: 4, opts: { attempts: 5 } as never })),
      ).rejects.toThrow();

      expect(updates[updates.length - 1].data).toMatchObject({
        status: NotificationStatus.FAILED,
      });
    });

    it('treats an unclassified exception as transient', async () => {
      // Being wrong in this direction wastes a retry. The other way silently drops
      // the notification.
      const { prisma, updates } = makePrisma();
      const processor = new TestProcessor(prisma, async () => {
        throw new Error('socket hang up');
      });

      await expect(processor.process(makeJob())).rejects.not.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(updates[updates.length - 1].data.lastError).toBe(
        'transient: socket hang up',
      );
    });

    it('honours a provider-supplied retry delay over our backoff', async () => {
      // Telegram's 429 says exactly how long to wait; guessing shorter earns
      // another 429.
      const { prisma } = makePrisma();
      const job = makeJob();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('rate limited', 'transient', 429, 30_000);
      });

      await expect(processor.process(job)).rejects.toThrow();

      expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
      const [delayUntil] = (job.moveToDelayed as jest.Mock).mock.calls[0];
      expect(delayUntil).toBeGreaterThan(Date.now() + 25_000);
    });

    it('does not reschedule when the provider gave no delay', async () => {
      const { prisma } = makePrisma();
      const job = makeJob();
      const processor = new TestProcessor(prisma, async () => {
        throw new DeliveryError('timeout', 'transient');
      });

      await expect(processor.process(job)).rejects.toThrow();
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    });
  });
});

describe('redact', () => {
  it('masks the local part of an email but keeps the domain', () => {
    // Enough to correlate with a user's own report; not enough to be a personal
    // data export in every log line.
    // 'aziz.karimov' is 12 characters: two visible, ten masked.
    expect(redact('aziz.karimov@example.uz')).toBe('az**********@example.uz');
  });

  it('keeps only the last three digits of a phone number', () => {
    expect(redact('998901234567')).toBe('*********567');
  });

  it('masks a very short value entirely', () => {
    expect(redact('12')).toBe('**');
  });

  it('handles a missing destination', () => {
    expect(redact(undefined)).toBe('(none)');
  });
});

describe('composeSms', () => {
  it('joins title and body', () => {
    expect(composeSms('Approval', 'Document ready')).toBe(
      'Approval: Document ready',
    );
  });

  it('collapses whitespace', () => {
    expect(composeSms('A\n B', 'C  D')).toBe('A B: C D');
  });

  it('keeps a Latin message within one 160-character part', () => {
    const message = composeSms('Approval required', 'x'.repeat(400));
    expect(message.length).toBeLessThanOrEqual(160);
  });

  it('uses the tighter 70-character budget for Cyrillic', () => {
    // UCS-2 encoding carries 70 characters per part, not 160 — a Russian
    // notification bills as multipart at a third of the length an English one
    // would.
    const message = composeSms('Требуется подтверждение', 'д'.repeat(400));
    expect(message.length).toBeLessThanOrEqual(70);
  });

  it('truncates at a word boundary', () => {
    // Comfortably over 160 characters, so truncation actually engages.
    const message = composeSms(
      'Approval required',
      'The supplier shall deliver the goods to the address specified in Annex 1 within thirty calendar days of the date of signature hereof, failing which the penalty in clause 9 applies.',
    );

    expect(message.length).toBeLessThanOrEqual(160);
    expect(message.endsWith('…')).toBe(true);
    // Cut before the space, not after it: "obliga …" reads as corrupted output.
    expect(message).not.toMatch(/\s…$/);
  });

  it('leaves a short message untouched', () => {
    expect(composeSms('Hi', 'There')).toBe('Hi: There');
  });
});

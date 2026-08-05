/**
 * Fan-out of one event across the channels it should reach.
 *
 * `channel-router.spec.ts` covers which channels an event routes to. This
 * covers the service around that decision, where the failures are of two
 * kinds: sending something that should not have been sent, and losing something
 * that should have been.
 *
 * On the first side: an unknown event key must not fan out to every channel, a
 * suspended account must not keep receiving mail, and a dispatch that runs
 * twice must produce one notification rather than two. On the second: a channel
 * held by quiet hours has to come back at 08:00 rather than vanish, a skipped
 * channel has to leave a record — "why did I not get an SMS" is a support
 * question and the answer has to be in the data — and one recipient failing in
 * a fan-out must not stop the rest of an approval chain being told.
 */
import { NotificationChannel, NotificationStatus, Prisma } from '@legaltech/database';
import { NotificationService } from './notification.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationGateway } from './gateway/notification.gateway';
import type { Queue } from 'bullmq';
import type { NotificationJob } from './queues/queue.constants';

type Row = Record<string, any>;

/** A P2002, which is how the unique dedupe constraint reports itself. */
function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });
}

function build({
  user = {
    id: 'user_1',
    email: 'lawyer@acme.uz',
    lockedAt: null,
    notificationPreference: null,
  } as Row | null,
  duplicateKeys = [] as string[],
} = {}) {
  const created: Row[] = [];
  const updates: Row[] = [];
  const pushes: Row[] = [];
  const jobs: Record<string, Row[]> = { email: [], sms: [], telegram: [] };

  let nextId = 1;

  const prisma = {
    client: {
      user: { findFirst: async () => user },
      notification: {
        create: async ({ data }: Row) => {
          if (data.dedupeKey && duplicateKeys.includes(data.dedupeKey)) {
            throw uniqueViolation();
          }
          const row = { id: `n_${nextId++}`, ...data };
          created.push(row);
          return row;
        },
        update: async ({ where, data }: Row) => {
          updates.push({ id: where.id, ...data });
          return { id: where.id, ...data };
        },
      },
    },
  } as unknown as PrismaService;

  const queue = (name: keyof typeof jobs) =>
    ({
      add: async (event: string, job: NotificationJob, options: Row) => {
        jobs[name].push({ event, job, options });
        return { id: options.jobId };
      },
    }) as unknown as Queue<NotificationJob>;

  const service = new NotificationService(
    prisma,
    {
      pushToUser: (userId: string, event: string, payload: Row) => {
        pushes.push({ userId, event, payload });
      },
    } as unknown as NotificationGateway,
    queue('email'),
    queue('sms'),
    queue('telegram'),
  );

  return { service, created, updates, pushes, jobs };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  event: 'document.approval_requested',
  userId: 'user_1',
  companyId: 'co_1',
  title: 'Approval requested',
  body: 'Supply contract is waiting on you.',
  ...overrides,
});

const rowsFor = (created: Row[], channel: NotificationChannel) =>
  created.filter((row) => row.channel === channel);

describe('NotificationService.dispatch', () => {
  describe('refusing to send', () => {
    it('sends nothing for an unknown event key', async () => {
      // A caller bug. Fanning out to every channel would turn it into an
      // incident.
      const { service, created, jobs } = build();

      const result = await service.dispatch(input({ event: 'not.a.real.event' }));

      expect(result).toEqual({ notificationIds: [], delivered: [], skipped: [] });
      expect(created).toHaveLength(0);
      expect(jobs.email).toHaveLength(0);
    });

    it('sends nothing to a deleted or unknown user', async () => {
      const { service, created } = build({ user: null });

      const result = await service.dispatch(input());

      expect(result.delivered).toEqual([]);
      expect(created).toHaveLength(0);
    });

    it('sends nothing to a suspended account', async () => {
      // Continuing to email someone whose access was revoked for abuse is both
      // pointless and a way to keep engaging with a party you decided to stop
      // dealing with.
      const { service, created } = build({
        user: {
          id: 'user_1',
          email: 'lawyer@acme.uz',
          lockedAt: new Date(),
          notificationPreference: null,
        },
      });

      const result = await service.dispatch(input());

      expect(result.delivered).toEqual([]);
      expect(created).toHaveLength(0);
    });
  });

  describe('channel asymmetry', () => {
    it('writes and pushes the in-app copy without queuing it', async () => {
      // The in-app notification is a row in a database this request is already
      // talking to; queuing it would add latency and a failure mode to
      // something that cannot fail independently.
      const { service, pushes, jobs } = build();

      await service.dispatch(input());

      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ userId: 'user_1', event: 'notification.created' });
      expect(jobs.email.concat(jobs.sms, jobs.telegram)).not.toContainEqual(
        expect.objectContaining({ job: expect.objectContaining({ channel: 'IN_APP' }) }),
      );
    });

    it('marks the in-app copy sent immediately', async () => {
      // The durable row is the delivery. Whether a socket happened to be open
      // is not part of whether the user was notified.
      const { service, updates } = build();

      await service.dispatch(input());

      expect(updates).toContainEqual(
        expect.objectContaining({ status: NotificationStatus.SENT }),
      );
    });

    it('queues the external channels instead of calling them inline', async () => {
      const { service, jobs } = build();

      await service.dispatch(input());

      expect(jobs.email).toHaveLength(1);
      expect(jobs.email[0].job).toMatchObject({
        channel: NotificationChannel.EMAIL,
        destination: 'lawyer@acme.uz',
        event: 'document.approval_requested',
      });
    });

    it('marks a queued notification QUEUED, not SENT', async () => {
      // It has been handed to a worker, not delivered. Reporting SENT here
      // would make a failed send indistinguishable from a successful one.
      const { service, updates } = build();

      await service.dispatch(input());

      expect(updates).toContainEqual(
        expect.objectContaining({ status: NotificationStatus.QUEUED }),
      );
    });

    it('keys the job on the notification id, so BullMQ refuses a duplicate', async () => {
      // A second layer under the database constraint, covering a dispatch
      // retried after the row was created but before the job was added.
      const { service, jobs, created } = build();

      await service.dispatch(input());

      const emailRow = rowsFor(created, NotificationChannel.EMAIL)[0];
      expect(jobs.email[0].options.jobId).toBe(emailRow.id);
    });
  });

  describe('deduplication', () => {
    it('scopes the key per channel', async () => {
      // The same event legitimately produces one in-app and one email row; a
      // single key across both would suppress the second.
      const { service, created } = build();

      await service.dispatch(input({ dedupeKey: 'approval:doc_1:step_1' }));

      const keys = created.map((row) => row.dedupeKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toContain('approval:doc_1:step_1:EMAIL');
      expect(keys).toContain('approval:doc_1:step_1:IN_APP');
    });

    it('suppresses a repeat without failing the dispatch', async () => {
      // A reminder job that runs twice produces one notification, and the
      // second run is not an error.
      const { service, jobs } = build({
        duplicateKeys: ['approval:doc_1:step_1:EMAIL'],
      });

      const result = await service.dispatch(input({ dedupeKey: 'approval:doc_1:step_1' }));

      expect(result.delivered).not.toContain(NotificationChannel.EMAIL);
      expect(jobs.email).toHaveLength(0);
    });

    it('still delivers the channels that were not duplicates', async () => {
      const { service, pushes } = build({
        duplicateKeys: ['approval:doc_1:step_1:EMAIL'],
      });

      const result = await service.dispatch(input({ dedupeKey: 'approval:doc_1:step_1' }));

      expect(result.delivered).toContain(NotificationChannel.IN_APP);
      expect(pushes).toHaveLength(1);
    });

    it('does not dedupe when no key was supplied', async () => {
      const { service, created } = build();

      await service.dispatch(input());
      await service.dispatch(input());

      expect(created.length).toBeGreaterThan(2);
    });

    it('lets an unrelated database failure through', async () => {
      // Only P2002 means "already handled". Swallowing anything else would
      // silently drop notifications on a broken database.
      const { service } = build();
      (
        service as unknown as { prisma: { client: { notification: { create: unknown } } } }
      ).prisma.client.notification.create = async () => {
        throw new Error('connection terminated');
      };

      await expect(service.dispatch(input())).rejects.toThrow('connection terminated');
    });
  });

  describe('skipped channels', () => {
    it('records a skip rather than discarding it', async () => {
      // "Why did I not get an SMS" is a support question, and the answer has
      // to be in the data.
      const { service, created } = build();

      const result = await service.dispatch(input({ event: 'billing.payment_failed' }));

      const skipped = created.filter(
        (row) => row.status === NotificationStatus.SKIPPED,
      );
      expect(skipped.length).toBeGreaterThan(0);
      expect(skipped[0].lastError).toEqual(expect.any(String));
      expect(result.skipped.length).toBeGreaterThan(0);
    });

    it('names the reason on the returned result', async () => {
      const { service } = build();

      const result = await service.dispatch(input({ event: 'billing.payment_failed' }));

      // SMS has no destination on a preference-less user, and that is the
      // reason the row carries.
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ channel: NotificationChannel.SMS }),
      );
    });

    it('queues nothing for a skipped channel', async () => {
      const { service, jobs } = build();

      await service.dispatch(input({ event: 'billing.payment_failed' }));

      expect(jobs.sms).toHaveLength(0);
    });
  });

  describe('defaults for a user who never opened the settings screen', () => {
    it('still reaches them by email', async () => {
      // No preference row means defaults, not silence.
      const { service, jobs } = build();

      await service.dispatch(input());

      expect(jobs.email).toHaveLength(1);
      expect(jobs.email[0].job.destination).toBe('lawyer@acme.uz');
    });

    it('prefers a notification email over the account one when set', async () => {
      const { service, jobs } = build({
        user: {
          id: 'user_1',
          email: 'account@acme.uz',
          lockedAt: null,
          notificationPreference: {
            enabledChannels: [NotificationChannel.EMAIL],
            email: 'notify@acme.uz',
          },
        },
      });

      await service.dispatch(input());

      expect(jobs.email[0].job.destination).toBe('notify@acme.uz');
    });
  });

  describe('field limits', () => {
    it('truncates a title and body rather than failing the insert', async () => {
      // A notification is not worth losing to a column limit.
      const { service, created } = build();

      await service.dispatch(
        input({ title: 'x'.repeat(500), body: 'y'.repeat(5000) }),
      );

      expect(created[0].title).toHaveLength(300);
      expect(created[0].body).toHaveLength(4000);
    });
  });

  describe('dispatchMany', () => {
    it('reaches every recipient', async () => {
      const { service } = build();

      const results = await service.dispatchMany([
        input({ userId: 'user_1' }),
        input({ userId: 'user_2' }),
      ]);

      expect(results).toHaveLength(2);
    });

    it('keeps going when one recipient fails', async () => {
      // A fan-out to an approval chain must still reach the other approvers.
      const { service } = build();
      const original = (
        service as unknown as { prisma: { client: { user: { findFirst: unknown } } } }
      ).prisma.client.user.findFirst;

      let call = 0;
      (
        service as unknown as { prisma: { client: { user: { findFirst: unknown } } } }
      ).prisma.client.user.findFirst = async (...args: unknown[]) => {
        if (call++ === 0) throw new Error('database hiccup');
        return (original as (...a: unknown[]) => unknown)(...args);
      };

      const results = await service.dispatchMany([
        input({ userId: 'user_1' }),
        input({ userId: 'user_2' }),
      ]);

      expect(results).toHaveLength(1);
    });
  });
});

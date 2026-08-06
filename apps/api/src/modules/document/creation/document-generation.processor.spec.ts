/**
 * The AI drafting worker.
 *
 * The document row already exists, holding the interpolated template, before
 * this worker runs at all. Everything below follows from that: the worker is
 * never the difference between a document and no document, only between the
 * template text and a drafted version of it. So the failure paths are the
 * interesting ones — they have to leave a customer with a usable document, an
 * allowance they were not charged for work they did not get, and no row stuck
 * claiming a draft is still running.
 *
 * The subtle one is the release. `attemptsMade` counts the current attempt, and
 * a job that retries three times passes through the catch three times.
 * Releasing on each would hand the same allowance back three times over.
 */
import { GeneratedDocumentStatus } from '@legaltech/database';
import { DocumentGenerationProcessor } from './document-generation.processor';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AiEngineService } from '../../ai-engine/ai-engine.service';
import type { UsageService } from '../../billing/limits/usage.service';
import type { NotificationGateway } from '../../notification/gateway/notification.gateway';
import type { DocumentGenerationJob } from '../../notification/queues/queue.constants';

const RESERVATION = {
  companyId: 'co_1',
  metric: 'AI_GENERATIONS',
  periodStart: '2026-08-01T00:00:00.000Z',
  amount: 1,
};

/** Matches `LegalDocumentDraft`; a partial fixture fails inside draftToSummary. */
const DRAFT = {
  title: 'Mehnat shartnomasi',
  sections: [{ heading: '1. Predmet', body: 'Matn' }],
  missingFields: ['counterparty_bank_account'],
  reviewNotes: [],
};

function job(overrides: Partial<DocumentGenerationJob> = {}, opts = {}) {
  return {
    data: {
      documentId: 'doc_1',
      companyId: 'co_1',
      userId: 'user_1',
      reservation: RESERVATION,
      documentType: 'Mehnat shartnomasi',
      locale: 'uz-Latn',
      variables: { party_name: 'Acme' },
      ...overrides,
    } as DocumentGenerationJob,
    attemptsMade: 1,
    opts: { attempts: 3, ...opts },
  };
}

function build({ aiError }: { aiError?: Error } = {}) {
  const updates: Record<string, unknown>[] = [];
  const pushes: Record<string, unknown>[] = [];

  const prisma = {
    client: {
      generatedDocument: {
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { id: 'doc_1', ...data };
        }),
      },
    },
  } as unknown as PrismaService;

  const generateLegalDocument = jest.fn(async () => {
    if (aiError) throw aiError;
    return { document: DRAFT };
  });

  // Parameter declared so `mock.calls[0][0]` types as the reservation rather
  // than as an element of an empty tuple.
  const release = jest.fn(async (_reservation: Record<string, unknown>) => undefined);

  const processor = new DocumentGenerationProcessor(
    prisma,
    { generateLegalDocument } as unknown as AiEngineService,
    { release } as unknown as UsageService,
    {
      pushToUser: (userId: string, event: string, payload: Record<string, unknown>) => {
        pushes.push({ userId, event, ...payload });
      },
    } as unknown as NotificationGateway,
  );

  return { processor, prisma, generateLegalDocument, release, updates, pushes };
}

describe('DocumentGenerationProcessor', () => {
  describe('a successful draft', () => {
    it('replaces the template body and marks the document generated', async () => {
      const { processor, updates } = build();

      await processor.process(job() as never);

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        status: GeneratedDocumentStatus.GENERATED,
      });
      expect(updates[0].content).toBeDefined();
    });

    it('attributes the call to the caller carried on the job', async () => {
      const { processor, generateLegalDocument } = build();

      await processor.process(job() as never);

      expect(generateLegalDocument).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'co_1', userId: 'user_1' }),
      );
    });

    it('keeps the allowance it was charged', async () => {
      const { processor, release } = build();

      await processor.process(job() as never);

      expect(release).not.toHaveBeenCalled();
    });

    it('tells the caller, and says the draft landed', async () => {
      const { processor, pushes } = build();

      await processor.process(job() as never);

      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({
        userId: 'user_1',
        event: 'document.generation_finished',
        documentId: 'doc_1',
        drafted: true,
      });
    });

    it('carries the fields the model could not fill', async () => {
      // A document whose clauses rendered blank looks finished; the person who
      // asked for it is the only one positioned to notice.
      const { processor, pushes } = build();

      await processor.process(job() as never);

      expect(pushes[0].unresolvedVariables).toEqual(['counterparty_bank_account']);
    });
  });

  describe('a failure with attempts left', () => {
    const failing = () => build({ aiError: new Error('provider down') });

    it('rethrows, so BullMQ schedules the retry', async () => {
      const { processor } = failing();

      await expect(
        processor.process(job({}, { attempts: 3 }) as never),
      ).rejects.toThrow('provider down');
    });

    it('does not release the allowance yet', async () => {
      // Releasing per attempt would hand the same allowance back three times
      // over for one job.
      const { processor, release } = failing();

      await processor
        .process(job({}, { attempts: 3 }) as never)
        .catch(() => undefined);

      expect(release).not.toHaveBeenCalled();
    });

    it('leaves the document alone', async () => {
      const { processor, updates } = failing();

      await processor
        .process(job({}, { attempts: 3 }) as never)
        .catch(() => undefined);

      expect(updates).toHaveLength(0);
    });
  });

  describe('a failure on the last attempt', () => {
    /** Third of three — the attempt after which BullMQ gives up. */
    function exhausted() {
      const context = build({ aiError: new Error('provider down') });
      const exhaustedJob = job();
      exhaustedJob.attemptsMade = 3;
      return { ...context, exhaustedJob };
    }

    it('settles rather than rethrowing', async () => {
      // Rethrowing would leave the row reporting GENERATING with nothing left
      // to run.
      const { processor, exhaustedJob } = exhausted();

      await expect(processor.process(exhaustedJob as never)).resolves.toBeUndefined();
    });

    it('hands the allowance back', async () => {
      // A vendor outage must not cost the customer a generation.
      const { processor, release, exhaustedJob } = exhausted();

      await processor.process(exhaustedJob as never);

      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'co_1', amount: 1 }),
      );
    });

    it('revives the period as a Date, not the string it crossed Redis as', async () => {
      const { processor, release, exhaustedJob } = exhausted();

      await processor.process(exhaustedJob as never);

      expect((release.mock.calls[0][0] as { periodStart: unknown }).periodStart)
        .toBeInstanceOf(Date);
    });

    it('clears GENERATING without touching the body', async () => {
      // The template text is the fallback, and it is already in the column.
      const { processor, updates, exhaustedJob } = exhausted();

      await processor.process(exhaustedJob as never);

      expect(updates).toEqual([{ status: GeneratedDocumentStatus.GENERATED }]);
    });

    it('tells the caller the draft did not land, and why', async () => {
      const { processor, pushes, exhaustedJob } = exhausted();

      await processor.process(exhaustedJob as never);

      expect(pushes[0]).toMatchObject({ drafted: false });
      expect(String(pushes[0].reason)).toMatch(/template text was kept/i);
    });

    it('releases nothing when the job carried no reservation', async () => {
      const context = build({ aiError: new Error('down') });
      const noReservation = job({ reservation: undefined });
      noReservation.attemptsMade = 3;

      await context.processor.process(noReservation as never);

      expect(context.release).not.toHaveBeenCalled();
    });

    it('still notifies when clearing the status fails', async () => {
      // A row stuck reporting GENERATING is a cosmetic lie; the document is
      // readable either way, and the caller should still hear.
      const context = build({ aiError: new Error('down') });
      (
        context.prisma.client.generatedDocument.update as jest.Mock
      ).mockRejectedValue(new Error('database gone'));
      const exhaustedJob = job();
      exhaustedJob.attemptsMade = 3;

      await expect(
        context.processor.process(exhaustedJob as never),
      ).resolves.toBeUndefined();
      expect(context.pushes).toHaveLength(1);
    });
  });

  describe('the notification is best effort', () => {
    it('does not fail a landed draft because a socket push threw', async () => {
      // Whether a socket happened to be open is not part of whether the
      // document was drafted.
      const { processor } = build();
      const throwing = new DocumentGenerationProcessor(
        (processor as unknown as { prisma: PrismaService }).prisma,
        (processor as unknown as { aiEngine: AiEngineService }).aiEngine,
        (processor as unknown as { usage: UsageService }).usage,
        {
          pushToUser: () => {
            throw new Error('no socket');
          },
        } as unknown as NotificationGateway,
      );

      await expect(throwing.process(job() as never)).resolves.toBeUndefined();
    });
  });
});

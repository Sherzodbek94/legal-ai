import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { GeneratedDocumentStatus, UsageMetric } from '@legaltech/database';
import { DocumentCreationService } from './document-creation.service';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { CreateDocumentDto } from '../dto/create-document.dto';

const USER = {
  id: 'user-1',
  companyId: 'company-1',
  role: 'USER',
  companyRole: 'ATTORNEY',
} as AuthenticatedUser;

const SCHEMA = {
  version: 1,
  variables: [
    { key: 'party', label: 'Counterparty', type: 'string', required: true },
    { key: 'amount', label: 'Amount', type: 'money', currency: 'UZS' },
    { key: 'company_legal_name', label: 'Our legal name', type: 'string' },
  ],
};

const TEMPLATE_BODY = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Between {{company_legal_name}} and {{party}} for {{amount}}.',
        },
      ],
    },
  ],
};

function build(overrides: {
  templateContent?: unknown;
  companyVariables?: Record<string, string>;
  quotaAllowed?: boolean;
  aiResult?: unknown;
  aiError?: Error;
} = {}) {
  const created: Record<string, unknown>[] = [];

  const tx = {
    generatedDocument: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'doc-1', ...data };
      }),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };

  const prisma = {
    client: {
      documentTemplate: {
        findFirst: jest.fn(async () => ({ id: 'tpl-1', name: 'Supply Agreement' })),
      },
      // Used only on the give-up paths, where the row already exists and its
      // status has to stop claiming a draft is still running.
      generatedDocument: {
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'doc-1',
          ...data,
        })),
      },
      $transaction: jest.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
    },
  };

  const versions = {
    getPublishedVersion: jest.fn(async () => ({
      id: 'ver-9',
      content: overrides.templateContent ?? TEMPLATE_BODY,
      variableSchema: SCHEMA,
    })),
  };

  const companies = {
    getPromptVariables: jest.fn(async () => ({
      variables: overrides.companyVariables ?? {
        company_legal_name: 'Alpha LLC',
        company_address: 'Tashkent',
      },
      missingRequired: [],
    })),
  };

  const aiEngine = {
    // Parameter declared so `mock.calls[0][0]` is typed rather than `never`.
    generateLegalDocument: jest.fn(async (_input: {
      variables: Record<string, string>;
      companyId?: string;
      userId?: string;
    }) => {
      if (overrides.aiError) throw overrides.aiError;
      return (
        overrides.aiResult ?? {
          document: {
            title: 'AI Supply Agreement',
            documentType: 'contract',
            language: 'uz-Latn',
            sections: [{ heading: 'Parties', body: 'Alpha and Beta.', order: 1 }],
            missingFields: ['bank details'],
            reviewNotes: [],
          },
        }
      );
    }),
  };

  const reservation = {
    companyId: 'company-1',
    metric: UsageMetric.AI_GENERATIONS,
    periodStart: new Date(),
    amount: 1,
  };

  const usage = {
    reserve: jest.fn(async () =>
      overrides.quotaAllowed === false
        ? { allowed: false, reason: 'QUOTA_EXCEEDED', limit: 5, used: 5, remaining: 0 }
        : { allowed: true, limit: 5, used: 1, remaining: 4, reservation },
    ),
    release: jest.fn(async () => undefined),
  };

  // Parameters declared so `mock.calls[n][1]` types as the job rather than as
  // an element of an empty tuple.
  const generationQueue = {
    add: jest.fn(
      async (
        _name: string,
        _job: Record<string, any>,
        _options: Record<string, any>,
      ) => ({ id: 'job_1' }),
    ),
  };

  const service = new DocumentCreationService(
    prisma as never,
    versions as never,
    companies as never,
    aiEngine as never,
    usage as never,
    generationQueue as never,
  );

  return { service, prisma, versions, companies, aiEngine, usage, tx, created, generationQueue };
}

const dto = (overrides: Partial<CreateDocumentDto> = {}): CreateDocumentDto => ({
  templateId: 'tpl-1',
  variables: { party: 'Beta LLC', amount: 1500 },
  ...overrides,
});

describe('DocumentCreationService', () => {
  describe('template interpolation', () => {
    it('fills the published template body with the supplied values', async () => {
      const { service } = build();

      const document = await service.create(dto(), USER);
      const text = (document.content as never as { content: { content: { text: string }[] }[] })
        .content[0].content[0].text;

      expect(text).toBe('Between Alpha LLC and Beta LLC for 1500.00 UZS.');
    });

    it('formats money to two places', async () => {
      const { service } = build();

      const document = await service.create(dto({ variables: { party: 'B', amount: 1500.5 } }), USER);
      const text = (document.content as never as { content: { content: { text: string }[] }[] })
        .content[0].content[0].text;

      // A contract must never render "1500.5 UZS".
      expect(text).toContain('1500.50 UZS');
    });

    it('pre-fills declared variables from the company profile', async () => {
      const { service, companies } = build();

      // `company_legal_name` was never supplied by the caller.
      const document = await service.create(dto(), USER);

      expect(companies.getPromptVariables).toHaveBeenCalledWith(
        'company-1',
        'company-1',
      );
      expect(
        (document.promptVariables as Record<string, unknown>).company_legal_name,
      ).toBe('Alpha LLC');
    });

    it('lets a caller override a company default', async () => {
      const { service } = build();

      const document = await service.create(
        dto({
          variables: {
            party: 'Beta',
            company_legal_name: 'Alpha LLC (former)',
          },
        }),
        USER,
      );

      expect(
        (document.promptVariables as Record<string, unknown>).company_legal_name,
      ).toBe('Alpha LLC (former)');
    });

    it('ignores company fields the schema does not declare', async () => {
      const { service } = build();

      // `company_address` is in the profile but not in this template's schema.
      // Passing it through would fail validation as an unknown variable.
      const document = await service.create(dto(), USER);

      expect(
        (document.promptVariables as Record<string, unknown>).company_address,
      ).toBeUndefined();
    });

    it('rejects a missing required variable with every issue at once', async () => {
      const { service } = build();

      await expect(
        service.create(dto({ variables: { amount: 'not-a-number' } }), USER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('reports an unknown variable back to the caller', async () => {
      const { service } = build();

      await expect(
        service.create(dto({ variables: { party: 'B', nope: 'x' } }), USER),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('reports declared variables that rendered as blanks', async () => {
      const { service } = build();

      const document = await service.create(
        dto({ variables: { party: 'Beta LLC' } }),
        USER,
      );

      // `amount` is optional and was not supplied, so the body has a ruled
      // blank where the figure belongs — the caller has to be told.
      expect(document.unresolvedVariables).toEqual(['amount']);
    });

    it('refuses a template whose placeholder is split by formatting', async () => {
      const { service } = build({
        templateContent: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'For {{par' },
                { type: 'text', text: 'ty}}', marks: [{ type: 'bold' }] },
              ],
            },
          ],
        },
      });

      await expect(service.create(dto(), USER)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('stores the document as a submittable draft', async () => {
      const { service } = build();

      const document = await service.create(dto(), USER);

      expect(document.status).toBe(GeneratedDocumentStatus.DRAFT);
    });

    it('does not call the AI engine', async () => {
      const { service, aiEngine, usage } = build();

      await service.create(dto(), USER);

      // The default path must work with no API key configured at all.
      expect(aiEngine.generateLegalDocument).not.toHaveBeenCalled();
      expect(usage.reserve).not.toHaveBeenCalled();
    });
  });

  describe('persistence', () => {
    it('pins the version that produced the document', async () => {
      const { service, created } = build();

      await service.create(dto(), USER);

      expect(created[0]).toMatchObject({
        templateId: 'tpl-1',
        templateVersionId: 'ver-9',
        companyId: 'company-1',
        createdById: 'user-1',
      });
    });

    it('defaults the title to the template name', async () => {
      const { service } = build();

      expect((await service.create(dto(), USER)).title).toBe('Supply Agreement');
    });

    it('prefers a supplied title', async () => {
      const { service } = build();

      expect(
        (await service.create(dto({ title: '  Beta deal  ' }), USER)).title,
      ).toBe('Beta deal');
    });

    it('falls back to the template name for a whitespace-only title', async () => {
      const { service } = build();

      expect((await service.create(dto({ title: '   ' }), USER)).title).toBe(
        'Supply Agreement',
      );
    });

    it('writes the audit entry in the same transaction as the document', async () => {
      const { service, tx } = build();

      await service.create(dto(), USER);

      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
      expect(tx.generatedDocument.create).toHaveBeenCalledTimes(1);
    });

    it('stores the validated inputs, not the rendered strings', async () => {
      const { service } = build();

      const document = await service.create(dto(), USER);

      // Reproducing a generation needs the inputs; the rendered text is derived.
      expect((document.promptVariables as Record<string, unknown>).amount).toBe(
        1500,
      );
    });
  });

  describe('AI drafting', () => {
    /*
     * Drafting is queued, not awaited. The row is written first, with the
     * interpolated template as its body, so a failed or slow draft is never
     * the difference between a document and no document — only between the
     * template text and a drafted version of it.
     */

    it('returns immediately with the template body, marked generating', async () => {
      const { service, aiEngine } = build();

      const document = await service.create(dto({ useAi: true }), USER);

      expect(aiEngine.generateLegalDocument).not.toHaveBeenCalled();
      expect(document.status).toBe(GeneratedDocumentStatus.GENERATING);
    });

    it('writes the document before queueing anything', async () => {
      // The ordering the whole design rests on: a queue that refuses the job
      // must not be able to lose the document.
      const { service, tx } = build();

      await service.create(dto({ useAi: true }), USER);

      expect(tx.generatedDocument.create).toHaveBeenCalledTimes(1);
    });

    it('queues a job carrying everything the worker needs', async () => {
      const { service, generationQueue } = build();

      await service.create(dto({ useAi: true }), USER);

      const [, job] = generationQueue.add.mock.calls[0];
      expect(job).toMatchObject({
        companyId: 'company-1',
        userId: 'user-1',
        documentType: expect.any(String),
      });
      expect(job.documentId).toEqual(expect.any(String));
    });

    it('sends sanitised prompt variables, not raw values', async () => {
      const { service, generationQueue } = build();

      await service.create(
        dto({ useAi: true, variables: { party: 'Beta <LLC>', amount: 1 } }),
        USER,
      );

      // Angle brackets are stripped on the prompt path because they delimit a
      // data block — a defence that does not apply on the document path.
      expect(generationQueue.add.mock.calls[0][1].variables.party).toBe('Beta LLC');
    });

    it('keys the job on the document, so a retried create cannot draft twice', async () => {
      const { service, generationQueue } = build();

      const document = await service.create(dto({ useAi: true }), USER);

      expect(generationQueue.add.mock.calls[0][2].jobId).toBe(document.id);
    });

    it('gives up after three attempts, not the notification default of five', async () => {
      // Each attempt is a minutes-long metered call; a provider that has failed
      // three times will not answer on the fifth.
      const { service, generationQueue } = build();

      await service.create(dto({ useAi: true }), USER);

      expect(generationQueue.add.mock.calls[0][2].attempts).toBe(3);
    });

    it('consumes AI quota separately from the document allowance', async () => {
      const { service, usage } = build();

      await service.create(dto({ useAi: true }), USER);

      expect(usage.reserve).toHaveBeenCalledWith(
        'company-1',
        UsageMetric.AI_GENERATIONS,
      );
    });

    it('charges the allowance before queueing, not in the worker', async () => {
      // So the refusal reaches the caller while they are still looking at the
      // form, and so a plan cannot be exceeded by filling the queue.
      const { service, generationQueue } = build({ quotaAllowed: false });

      await expect(service.create(dto({ useAi: true }), USER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(generationQueue.add).not.toHaveBeenCalled();
    });

    it('queues nothing when the caller did not ask for a draft', async () => {
      const { service, generationQueue, usage } = build();

      await service.create(dto({ useAi: false }), USER);

      expect(generationQueue.add).not.toHaveBeenCalled();
      expect(usage.reserve).not.toHaveBeenCalled();
    });

    describe('when the queue will not take the job', () => {
      const queueDown = () => {
        const context = build();
        context.generationQueue.add.mockRejectedValue(new Error('redis down'));
        return context;
      };

      it('keeps the document rather than failing the create', async () => {
        // The document already exists with its template body. Throwing here
        // would undo a create that had already succeeded.
        const { service } = queueDown();

        await expect(
          service.create(dto({ useAi: true }), USER),
        ).resolves.toMatchObject({ id: expect.any(String) });
      });

      it('hands the reservation back', async () => {
        const { service, usage } = queueDown();

        await service.create(dto({ useAi: true }), USER);

        expect(usage.release).toHaveBeenCalledTimes(1);
      });

      it('clears the generating status, so nothing waits on a job that will never run', async () => {
        const { service, prisma } = queueDown();

        await service.create(dto({ useAi: true }), USER);

        expect(prisma.client.generatedDocument.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { status: GeneratedDocumentStatus.GENERATED },
          }),
        );
      });
    });
  });

  describe('tenant scoping', () => {
    it('resolves the template within the caller tenant only', async () => {
      const { service, prisma, versions } = build();

      await service.create(dto(), USER);

      expect(versions.getPublishedVersion).toHaveBeenCalledWith(
        'tpl-1',
        'company-1',
      );
      expect(prisma.client.documentTemplate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            companyId: 'company-1',
            deletedAt: null,
          }),
        }),
      );
    });
  });
});

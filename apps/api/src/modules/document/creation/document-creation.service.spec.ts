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

  const service = new DocumentCreationService(
    prisma as never,
    versions as never,
    companies as never,
    aiEngine as never,
    usage as never,
  );

  return { service, prisma, versions, companies, aiEngine, usage, tx, created };
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
    it('builds the body from the model draft', async () => {
      const { service, aiEngine } = build();

      const document = await service.create(dto({ useAi: true }), USER);

      expect(aiEngine.generateLegalDocument).toHaveBeenCalledTimes(1);
      expect(document.status).toBe(GeneratedDocumentStatus.GENERATED);
    });

    it("carries the model's own caveats into the summary", async () => {
      const { service } = build();

      const document = await service.create(dto({ useAi: true }), USER);

      expect(document.aiSummary).toContain('bank details');
    });

    it('attributes the call to the caller, never to the request body', async () => {
      const { service, aiEngine } = build();

      await service.create(dto({ useAi: true }), USER);

      expect(aiEngine.generateLegalDocument).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      );
    });

    it('sends sanitised prompt variables, not raw values', async () => {
      const { service, aiEngine } = build();

      await service.create(
        dto({ useAi: true, variables: { party: 'Beta <LLC>', amount: 1 } }),
        USER,
      );

      const sent = aiEngine.generateLegalDocument.mock.calls[0][0];
      // Angle brackets are stripped on the prompt path because they delimit a
      // data block — a defence that does not apply on the document path.
      expect(sent.variables.party).toBe('Beta LLC');
    });

    it('consumes AI quota separately from the document allowance', async () => {
      const { service, usage } = build();

      await service.create(dto({ useAi: true }), USER);

      expect(usage.reserve).toHaveBeenCalledWith(
        'company-1',
        UsageMetric.AI_GENERATIONS,
      );
    });

    it('refuses when the AI allowance is spent', async () => {
      const { service, aiEngine } = build({ quotaAllowed: false });

      await expect(service.create(dto({ useAi: true }), USER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(aiEngine.generateLegalDocument).not.toHaveBeenCalled();
    });

    it('hands the reservation back when the provider fails', async () => {
      const { service, usage } = build({ aiError: new Error('provider down') });

      await expect(service.create(dto({ useAi: true }), USER)).rejects.toThrow(
        'provider down',
      );

      // A vendor outage must not cost the customer a generation.
      expect(usage.release).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when the provider fails', async () => {
      const { service, tx } = build({ aiError: new Error('provider down') });

      await expect(
        service.create(dto({ useAi: true }), USER),
      ).rejects.toThrow();

      expect(tx.generatedDocument.create).not.toHaveBeenCalled();
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

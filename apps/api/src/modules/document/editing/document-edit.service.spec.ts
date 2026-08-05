import { ConflictException, NotFoundException } from '@nestjs/common';
import { GeneratedDocumentStatus } from '@legaltech/database';
import { DocumentEditService } from './document-edit.service';

const DOC: {
  id: string;
  title: string;
  content: Record<string, unknown>;
  status: GeneratedDocumentStatus;
  revision: number;
  approvalRound: number;
} = {
  id: 'doc_1',
  title: 'Ijara shartnomasi',
  content: { type: 'doc', content: [] },
  status: GeneratedDocumentStatus.DRAFT,
  revision: 3,
  approvalRound: 0,
};

function build(overrides: Partial<typeof DOC> = {}, updateCount = 1) {
  const document = { ...DOC, ...overrides };

  const state = {
    versions: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
  };

  const tx = {
    generatedDocumentVersion: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.versions.push(data);
        return data;
      }),
    },
    generatedDocument: {
      updateMany: jest.fn(async (args: Record<string, unknown>) => {
        state.updates.push(args);
        return { count: updateCount };
      }),
      findUniqueOrThrow: jest.fn(async () => ({
        ...document,
        revision: document.revision + 1,
        updatedAt: new Date(),
      })),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.audits.push(data);
        return data;
      }),
    },
  };

  const client = {
    generatedDocument: {
      findFirst: jest.fn(async () => document),
      findFirstOrThrow: jest.fn(async () => document),
    },
    generatedDocumentVersion: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => ({
        id: 'ver_1',
        version: 2,
        title: 'Eski sarlavha',
        content: { type: 'doc', content: [] },
        approvalRound: 0,
        createdAt: new Date(),
        editedBy: null,
      })),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return {
    state,
    tx,
    document,
    service: new DocumentEditService({ client } as never),
    client,
  };
}

describe('DocumentEditService', () => {
  describe('update', () => {
    it('saves an edit and bumps the revision', async () => {
      const built = build();

      const result = await built.service.update('doc_1', 'co_1', 'user_1', {
        title: 'Yangi sarlavha',
        expectedRevision: 3,
      });

      expect(result.revision).toBe(4);
    });

    it('snapshots the state being displaced, not the new one', async () => {
      // What makes the list "the states this document passed through". The
      // current state is the live row, which is where a reader already looks.
      const built = build();

      await built.service.update('doc_1', 'co_1', 'user_1', {
        title: 'Yangi sarlavha',
        expectedRevision: 3,
      });

      expect(built.state.versions[0]).toMatchObject({
        version: 3,
        title: 'Ijara shartnomasi',
        editedById: 'user_1',
      });
    });

    it('records who edited it', async () => {
      const built = build();

      await built.service.update('doc_1', 'co_1', 'user_1', {
        expectedRevision: 3,
        title: 'X',
      });

      expect(built.state.audits[0]).toMatchObject({
        entityId: 'doc_1',
        userId: 'user_1',
        metadata: expect.objectContaining({ revision: 4 }),
      });
    });

    it('refuses a document from another tenant', async () => {
      const built = build();
      built.client.generatedDocument.findFirst.mockResolvedValueOnce(
        null as never,
      );

      await expect(
        built.service.update('doc_1', 'other_co', 'user_1', {
          expectedRevision: 3,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('documents that must not change under someone', () => {
    it.each([
      [GeneratedDocumentStatus.PENDING_APPROVAL],
      [GeneratedDocumentStatus.COMPLETED],
      [GeneratedDocumentStatus.FINALIZED],
      [GeneratedDocumentStatus.GENERATING],
    ])('refuses to edit a %s document', async (status) => {
      // Editing after approval silently converts other people's decisions into
      // approval of text they never saw — the same class of failure as letting
      // a submitter approve their own document.
      const built = build({ status });

      await expect(
        built.service.update('doc_1', 'co_1', 'user_1', {
          expectedRevision: 3,
          title: 'X',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(built.state.versions).toHaveLength(0);
    });

    it('says what to do about a document awaiting approval', async () => {
      const built = build({ status: GeneratedDocumentStatus.PENDING_APPROVAL });

      await expect(
        built.service.update('doc_1', 'co_1', 'user_1', { expectedRevision: 3 }),
      ).rejects.toThrow(/withdraw it before editing/i);
    });

    it.each([
      [GeneratedDocumentStatus.DRAFT],
      [GeneratedDocumentStatus.GENERATED],
      [GeneratedDocumentStatus.REJECTED],
    ])('allows editing a %s document', async (status) => {
      // A rejected document is exactly the one somebody needs to correct.
      const built = build({ status });

      await expect(
        built.service.update('doc_1', 'co_1', 'user_1', {
          expectedRevision: 3,
          title: 'X',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('concurrent edits', () => {
    it('refuses a save against a stale revision', async () => {
      // Last-write-wins presents as a colleague finding their clause gone with
      // nothing to indicate it existed.
      const built = build();

      await expect(
        built.service.update('doc_1', 'co_1', 'user_1', {
          expectedRevision: 2,
          title: 'X',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('reports the current revision so the client can reload', async () => {
      const built = build();

      await built.service
        .update('doc_1', 'co_1', 'user_1', { expectedRevision: 2 })
        .catch((error: ConflictException) => {
          expect(error.getResponse()).toMatchObject({ currentRevision: 3 });
        });

      expect.assertions(1);
    });

    it('refuses when the conditional update matches no row', async () => {
      // Two saves both pass the revision check and race into the transaction;
      // this is what makes the second update nothing rather than overwrite.
      const built = build({}, 0);

      await expect(
        built.service.update('doc_1', 'co_1', 'user_1', {
          expectedRevision: 3,
          title: 'X',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('scopes the update on the revision, not the id alone', async () => {
      const built = build();

      await built.service.update('doc_1', 'co_1', 'user_1', {
        expectedRevision: 3,
        title: 'X',
      });

      expect(built.state.updates[0]).toMatchObject({
        where: { id: 'doc_1', revision: 3 },
      });
    });
  });

  describe('restore', () => {
    it('snapshots the current state, so restoring is itself undoable', async () => {
      const built = build();

      await built.service.restore('doc_1', 'co_1', 'user_1', 'ver_1');

      expect(built.state.versions[0]).toMatchObject({
        version: 3,
        title: 'Ijara shartnomasi',
      });
    });

    it('writes the old state back as the live one', async () => {
      const built = build();

      await built.service.restore('doc_1', 'co_1', 'user_1', 'ver_1');

      expect(built.state.updates[0]).toMatchObject({
        data: expect.objectContaining({ title: 'Eski sarlavha' }),
      });
    });

    it('refuses to restore into a locked document', async () => {
      const built = build({ status: GeneratedDocumentStatus.COMPLETED });

      await expect(
        built.service.restore('doc_1', 'co_1', 'user_1', 'ver_1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

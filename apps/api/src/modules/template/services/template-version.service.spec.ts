/**
 * Template versions — where every generated document comes from.
 *
 * Publishing is the highest-consequence write in the product. Three rows have
 * to agree afterwards: the incumbent archived, the draft published, the
 * template repointed. Land two of the three and the template either has two
 * published versions or none, and "none" means every generation from it starts
 * failing with nothing to point at.
 *
 * The other property worth stating: a version is re-validated on the way out of
 * draft, not trusted because it validated on the way in. A body that references
 * a variable the schema does not declare renders a blank where a party's name
 * should be, in a document somebody signs. Catching it at publish is the last
 * point at which it is cheap.
 *
 * Prisma is faked rather than mocked. Atomicity, the single-published
 * invariant, and version allocation are all statements about what the rows look
 * like afterwards; asserting on call arguments would prove the service talks to
 * Prisma, not that a template ends up in a coherent state.
 */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, TemplateStatus } from '@legaltech/database';
import { TemplateVersionService } from './template-version.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

type Row = Record<string, any>;

const SCHEMA = {
  version: 1,
  variables: [{ key: 'party_name', label: 'Party', type: 'string', required: true }],
};

const CHAIN = [{ order: 1, role: 'OWNER', label: 'Signatory' }];

/** A TipTap body referencing exactly the declared placeholder. */
const CONTENT = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Tomon: {{party_name}}' }],
    },
  ],
};

const USER = { id: 'user_1', companyId: 'co_1' } as AuthenticatedUser;

function uniqueViolation(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target },
  });
}

function serializationFailure() {
  return new Prisma.PrismaClientKnownRequestError('could not serialize access', {
    code: 'P2034',
    clientVersion: '5.22.0',
  });
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === null) return row[key] === null || row[key] === undefined;
    return row[key] === value;
  });
}

class FakePrisma {
  templates: Row[] = [];
  versions: Row[] = [];
  audits: Row[] = [];

  /** Thrown by the next `$transaction` body, once. */
  failNextTransactionWith: unknown = null;
  transactions = 0;

  private nextId = 1;

  readonly client = {
    documentTemplate: {
      findFirst: async ({ where }: Row = {}) =>
        this.templates.find((t) => matches(t, where)) ?? null,
      update: async ({ where, data }: Row) => {
        const row = this.templates.find((t) => t.id === where.id);
        if (!row) throw new Error('template not found');
        Object.assign(row, data);
        return { ...row };
      },
    },
    templateVersion: {
      findFirst: async ({ where, orderBy }: Row = {}) => {
        let rows = this.versions.filter((v) => matches(v, where));
        if (orderBy?.version === 'desc') {
          rows = [...rows].sort((a, b) => b.version - a.version);
        }
        return rows[0] ? { ...rows[0] } : null;
      },
      findMany: async ({ where }: Row = {}) =>
        this.versions.filter((v) => matches(v, where)).map((v) => ({ ...v })),
      create: async ({ data }: Row) => {
        // The real uniqueness guarantee, so a colliding allocation behaves the
        // way the retry loop expects.
        if (
          this.versions.some(
            (v) => v.templateId === data.templateId && v.version === data.version,
          )
        ) {
          throw uniqueViolation(['templateId', 'version']);
        }
        const row = { id: `tv_${this.nextId++}`, archivedAt: null, publishedAt: null, ...data };
        this.versions.push(row);
        return { ...row };
      },
      update: async ({ where, data }: Row) => {
        const row = this.versions.find((v) => v.id === where.id);
        if (!row) throw new Error('version not found');
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = this.versions.filter((v) => matches(v, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    auditLog: {
      create: async ({ data }: Row) => {
        this.audits.push({ ...data });
        return { ...data };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      this.transactions += 1;

      // Snapshot, so a body that throws leaves nothing half-applied — which is
      // the whole property the publish tests are about.
      const snapshot = {
        templates: this.templates.map((r) => ({ ...r })),
        versions: this.versions.map((r) => ({ ...r })),
        audits: this.audits.map((r) => ({ ...r })),
      };

      try {
        if (this.failNextTransactionWith) {
          const error = this.failNextTransactionWith;
          this.failNextTransactionWith = null;
          throw error;
        }
        return await fn(this.client);
      } catch (error) {
        this.templates = snapshot.templates;
        this.versions = snapshot.versions;
        this.audits = snapshot.audits;
        throw error;
      }
    },
  };
}

function build(
  {
    templateId = 'tpl_1',
    companyId = 'co_1',
    versions = [] as Row[],
  }: { templateId?: string; companyId?: string; versions?: Row[] } = {},
) {
  const db = new FakePrisma();
  db.templates.push({
    id: templateId,
    companyId,
    deletedAt: null,
    categoryKind: null,
    version: versions.length,
  });
  for (const version of versions) {
    db.versions.push({
      id: version.id ?? `tv_seed_${version.version}`,
      templateId,
      content: CONTENT,
      variableSchema: SCHEMA,
      approvalChain: CHAIN,
      archivedAt: null,
      publishedAt: null,
      ...version,
    });
  }

  const service = new TemplateVersionService(db as unknown as PrismaService);
  return { service, db };
}

const published = (db: FakePrisma) =>
  db.versions.filter((v) => v.status === TemplateStatus.PUBLISHED);

const draft = (overrides: Row = {}) => ({
  version: 1,
  status: TemplateStatus.DRAFT,
  ...overrides,
});

describe('TemplateVersionService', () => {
  // -------------------------------------------------------------------------
  // publish — the write that matters
  // -------------------------------------------------------------------------

  describe('publish', () => {
    it('archives the incumbent, publishes the draft, and repoints the template', async () => {
      const { service, db } = build({
        versions: [
          { id: 'tv_old', version: 1, status: TemplateStatus.PUBLISHED },
          { id: 'tv_new', version: 2, status: TemplateStatus.DRAFT },
        ],
      });

      await service.publish('tpl_1', 'tv_new', {}, USER);

      expect(db.versions.find((v) => v.id === 'tv_old')!.status).toBe(
        TemplateStatus.ARCHIVED,
      );
      expect(db.versions.find((v) => v.id === 'tv_new')!.status).toBe(
        TemplateStatus.PUBLISHED,
      );
      expect(db.templates[0].currentVersionId).toBe('tv_new');
    });

    it('leaves exactly one published version', async () => {
      // The invariant every read path assumes. Two published versions and
      // "which one generates" becomes whichever the query happened to order
      // first.
      const { service, db } = build({
        versions: [
          { id: 'tv_1', version: 1, status: TemplateStatus.PUBLISHED },
          { id: 'tv_2', version: 2, status: TemplateStatus.DRAFT },
          { id: 'tv_3', version: 3, status: TemplateStatus.DRAFT },
        ],
      });

      await service.publish('tpl_1', 'tv_2', {}, USER);
      await service.publish('tpl_1', 'tv_3', {}, USER);

      expect(published(db).map((v) => v.id)).toEqual(['tv_3']);
    });

    it('stamps the incumbent and the newcomer with the same instant', async () => {
      // One archivedAt and one publishedAt from a single `now`, so history
      // cannot show a gap where the template had no published version.
      const { service, db } = build({
        versions: [
          { id: 'tv_old', version: 1, status: TemplateStatus.PUBLISHED },
          { id: 'tv_new', version: 2, status: TemplateStatus.DRAFT },
        ],
      });

      await service.publish('tpl_1', 'tv_new', {}, USER);

      expect(db.versions.find((v) => v.id === 'tv_old')!.archivedAt).toEqual(
        db.versions.find((v) => v.id === 'tv_new')!.publishedAt,
      );
    });

    it('denormalises the body onto the template', async () => {
      const { service, db } = build({
        versions: [draft({ id: 'tv_1' })],
      });

      await service.publish('tpl_1', 'tv_1', {}, USER);

      expect(db.templates[0].content).toEqual(CONTENT);
      expect(db.templates[0].version).toBe(1);
      expect(db.templates[0].status).toBe(TemplateStatus.PUBLISHED);
    });

    it('applies nothing at all when the transaction fails', async () => {
      // The failure this method is written as one transaction to prevent:
      // a partial apply leaves the template with two published versions or
      // none, and none means every generation from it starts failing.
      const { service, db } = build({
        versions: [
          { id: 'tv_old', version: 1, status: TemplateStatus.PUBLISHED },
          { id: 'tv_new', version: 2, status: TemplateStatus.DRAFT },
        ],
      });
      db.failNextTransactionWith = new Error('connection lost');

      await expect(service.publish('tpl_1', 'tv_new', {}, USER)).rejects.toThrow(
        'connection lost',
      );

      expect(published(db).map((v) => v.id)).toEqual(['tv_old']);
      expect(db.templates[0].currentVersionId).toBeUndefined();
    });

    it('records the transition in the audit log', async () => {
      const { service, db } = build({ versions: [draft({ id: 'tv_1' })] });

      await service.publish('tpl_1', 'tv_1', {}, USER);

      expect(db.audits).toHaveLength(1);
      expect(db.audits[0].metadata).toMatchObject({
        templateId: 'tpl_1',
        version: 1,
        transition: 'PUBLISHED',
      });
    });

    it('keeps the draft note when publishing supplies none', async () => {
      const { service, db } = build({
        versions: [draft({ id: 'tv_1', changeNote: 'Added indemnity clause' })],
      });

      await service.publish('tpl_1', 'tv_1', {}, USER);

      expect(db.versions[0].changeNote).toBe('Added indemnity clause');
    });

    describe('refusals', () => {
      it('refuses a version that is already published', async () => {
        const { service } = build({
          versions: [{ id: 'tv_1', version: 1, status: TemplateStatus.PUBLISHED }],
        });

        await expect(
          service.publish('tpl_1', 'tv_1', {}, USER),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('refuses an archived version, and says to roll it forward', async () => {
        // History stays append-only: republishing in place would make version 3
        // silently become current again months after it was retired.
        const { service } = build({
          versions: [{ id: 'tv_1', version: 1, status: TemplateStatus.ARCHIVED }],
        });

        await expect(service.publish('tpl_1', 'tv_1', {}, USER)).rejects.toThrow(
          /roll it forward/,
        );
      });

      it('refuses a version that belongs to another template', async () => {
        const { service } = build({ versions: [draft({ id: 'tv_1' })] });

        await expect(
          service.publish('tpl_1', 'tv_missing', {}, USER),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('refuses a template belonging to another company', async () => {
        const { service } = build({ companyId: 'co_2', versions: [draft({ id: 'tv_1' })] });

        await expect(
          service.publish('tpl_1', 'tv_1', {}, USER),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('re-validation on the way out of draft', () => {
      it('refuses a body naming a variable the schema does not declare', async () => {
        // It would render as a blank where a party's name belongs, in a
        // document somebody signs. Publish is the last cheap place to catch it.
        const { service, db } = build({
          versions: [
            draft({
              id: 'tv_1',
              content: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Tomon: {{undeclared_key}}' }],
                  },
                ],
              },
            }),
          ],
        });

        await expect(
          service.publish('tpl_1', 'tv_1', {}, USER),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(published(db)).toHaveLength(0);
      });

      it('names the undeclared variables rather than just refusing', async () => {
        const { service } = build({
          versions: [
            draft({
              id: 'tv_1',
              content: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '{{a_missing}} {{b_missing}}' }],
                  },
                ],
              },
            }),
          ],
        });

        const error = await service
          .publish('tpl_1', 'tv_1', {}, USER)
          .catch((caught) => caught);

        expect(error.getResponse().undeclared).toEqual(['a_missing', 'b_missing']);
      });

      it('refuses a schema that stopped being valid', async () => {
        const { service } = build({
          versions: [draft({ id: 'tv_1', variableSchema: { version: 1, variables: 'no' } })],
        });

        await expect(service.publish('tpl_1', 'tv_1', {}, USER)).rejects.toThrow();
      });

      it('accepts a body that declares fewer placeholders than the schema', async () => {
        // The schema may declare a variable the body does not yet use; the
        // reverse is the error.
        const { service, db } = build({
          versions: [
            draft({
              id: 'tv_1',
              variableSchema: {
                version: 1,
                variables: [
                  ...SCHEMA.variables,
                  { key: 'unused_key', label: 'Unused', type: 'string' },
                ],
              },
            }),
          ],
        });

        await service.publish('tpl_1', 'tv_1', {}, USER);

        expect(published(db)).toHaveLength(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // createDraft — version allocation
  // -------------------------------------------------------------------------

  describe('createDraft', () => {
    const dto = { content: CONTENT, variableSchema: SCHEMA, approvalChain: CHAIN };

    it('allocates the first version as 1', async () => {
      const { service } = build();

      const created = await service.createDraft('tpl_1', dto, USER);

      expect(created.version).toBe(1);
      expect(created.status).toBe(TemplateStatus.DRAFT);
    });

    it('allocates the next number above the highest existing version', async () => {
      // Above the highest, not the count: version 2 may have been deleted, and
      // reusing its number would collide with the audit trail.
      const { service } = build({
        versions: [
          { id: 'a', version: 1, status: TemplateStatus.ARCHIVED },
          { id: 'b', version: 7, status: TemplateStatus.PUBLISHED },
        ],
      });

      expect((await service.createDraft('tpl_1', dto, USER)).version).toBe(8);
    });

    it('advances the template high-water mark', async () => {
      const { service, db } = build();

      await service.createDraft('tpl_1', dto, USER);

      expect(db.templates[0].version).toBe(1);
    });

    it('refuses a schema it cannot parse, before writing anything', async () => {
      const { service, db } = build();

      await expect(
        service.createDraft('tpl_1', { ...dto, variableSchema: { version: 2 } }, USER),
      ).rejects.toThrow();
      expect(db.versions).toHaveLength(0);
    });

    it('refuses a template belonging to another company', async () => {
      const { service } = build({ companyId: 'co_2' });

      await expect(service.createDraft('tpl_1', dto, USER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    describe('losing the allocation race', () => {
      it('retries a serialization failure', async () => {
        const { service, db } = build();
        db.failNextTransactionWith = serializationFailure();

        const created = await service.createDraft('tpl_1', dto, USER);

        expect(created.version).toBe(1);
        expect(db.transactions).toBe(2);
      });

      it('retries a collision on the version sequence', async () => {
        const { service, db } = build();
        db.failNextTransactionWith = uniqueViolation(['templateId', 'version']);

        await service.createDraft('tpl_1', dto, USER);

        expect(db.transactions).toBe(2);
      });

      it('does not retry a unique violation on some other column', async () => {
        // It would collide identically on the next attempt; retrying just
        // spends the budget and delays the error.
        const { service, db } = build();
        db.failNextTransactionWith = uniqueViolation(['slug']);

        await expect(service.createDraft('tpl_1', dto, USER)).rejects.toThrow();
        expect(db.transactions).toBe(1);
      });

      it('gives up as unavailable rather than looping', async () => {
        const { service } = build();
        const db = (service as unknown as { prisma: FakePrisma }).prisma;
        // Every attempt loses.
        db.client.$transaction = (async () => {
          throw serializationFailure();
        }) as never;

        await expect(service.createDraft('tpl_1', dto, USER)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // rollback
  // -------------------------------------------------------------------------

  describe('rollback', () => {
    it('copies an archived version forward instead of un-archiving it', async () => {
      // History stays append-only: the record should show that version 3 is a
      // copy of version 1, not that version 1 mysteriously became current.
      const { service, db } = build({
        versions: [
          { id: 'tv_1', version: 1, status: TemplateStatus.ARCHIVED, changeNote: 'first' },
          { id: 'tv_2', version: 2, status: TemplateStatus.PUBLISHED },
        ],
      });

      await service.rollback('tpl_1', { versionId: 'tv_1' } as never, USER);

      expect(db.versions.find((v) => v.id === 'tv_1')!.status).toBe(
        TemplateStatus.ARCHIVED,
      );
      expect(db.versions.some((v) => v.version === 3)).toBe(true);
    });

    it('carries the old body onto the new version', async () => {
      const OLD = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Eski: {{party_name}}' }] },
        ],
      };
      const { service, db } = build({
        versions: [
          { id: 'tv_1', version: 1, status: TemplateStatus.ARCHIVED, content: OLD },
          { id: 'tv_2', version: 2, status: TemplateStatus.PUBLISHED },
        ],
      });

      await service.rollback('tpl_1', { versionId: 'tv_1' } as never, USER);

      expect(db.versions.find((v) => v.version === 3)!.content).toEqual(OLD);
    });

    it('refuses a version from another template', async () => {
      const { service } = build({ versions: [draft({ id: 'tv_1' })] });

      await expect(
        service.rollback('tpl_1', { versionId: 'tv_absent' } as never, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  describe('reads', () => {
    it('reports the published version', async () => {
      const { service } = build({
        versions: [
          { id: 'tv_1', version: 1, status: TemplateStatus.ARCHIVED },
          { id: 'tv_2', version: 2, status: TemplateStatus.PUBLISHED },
        ],
      });

      expect((await service.getPublishedVersion('tpl_1', 'co_1')).id).toBe('tv_2');
    });

    it('refuses to read across companies', async () => {
      const { service } = build({ companyId: 'co_2', versions: [draft({ id: 'tv_1' })] });

      await expect(service.listVersions('tpl_1', 'co_1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

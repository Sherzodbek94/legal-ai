import { LegalActStatus, LegalActType } from '@legaltech/database';
import { CorpusIngestionService } from './corpus-ingestion.service';
import type { LegalCorpusSource, SourceAct } from '../sources/legal-source';

const ACT: SourceAct = {
  externalId: '-111181',
  title: "O'zbekiston Respublikasi Fuqarolik kodeksi",
  type: LegalActType.CODE,
  language: 'uz-Latn',
  status: LegalActStatus.IN_FORCE,
  revision: 'rev-1',
  content: '346-modda. Bajarish\n\nMatn.\n\n347-modda. Hisobga olish\n\nMatn.',
};

/**
 * A Prisma stand-in covering only what the service touches.
 *
 * Hand-written rather than mocked wholesale so the assertions can be about
 * behaviour — what was written, what was deleted, in what order — instead of
 * about which methods were called.
 */
function fakePrisma(existing: { id: string; revision: string | null } | null = null) {
  const state = {
    acts: [] as Record<string, unknown>[],
    chunks: [] as Record<string, unknown>[],
    deletedFor: [] as string[],
    vectorWrites: [] as unknown[][],
  };

  const tx = {
    legalAct: {
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        state.acts.push(create);
        return { id: 'act_1' };
      }),
    },
    legalActChunk: {
      deleteMany: jest.fn(async ({ where }: { where: { actId: string } }) => {
        state.deletedFor.push(where.actId);
        return { count: 0 };
      }),
      createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        state.chunks.push(...data);
        return { count: data.length };
      }),
    },
  };

  const client = {
    legalAct: {
      findUnique: jest.fn(async () => existing),
      count: jest.fn(async () => state.acts.length),
      groupBy: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    legalActChunk: {
      findMany: jest.fn(async () =>
        state.chunks.map((chunk, index) => ({
          id: `chunk_${index}`,
          content: chunk.content as string,
          tokenCount: chunk.tokenCount as number,
        })),
      ),
      count: jest.fn(async () => state.chunks.length),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    $executeRawUnsafe: jest.fn(async (...args: unknown[]) => {
      state.vectorWrites.push(args);
      return 1;
    }),
    $queryRaw: jest.fn(async () => [{ count: BigInt(0) }]),
  };

  return { state, tx, prisma: { client } };
}

function fakeSource(acts: SourceAct[] = [ACT]): LegalCorpusSource {
  return {
    name: 'files',
    isConfigured: () => true,
    // eslint-disable-next-line @typescript-eslint/require-await
    acts: async function* () {
      for (const act of acts) yield act;
    },
  };
}

function fakeEmbeddings(configured = true) {
  return {
    isConfigured: () => configured,
    embed: jest.fn(
      async (
        inputs: { content: string }[],
        context?: { companyId?: string; operation?: string },
      ) => {
        void context;
        return inputs.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] }));
      },
    ),
  };
}

function build(options: {
  source?: LegalCorpusSource;
  existing?: { id: string; revision: string | null } | null;
  embeddingsConfigured?: boolean;
} = {}) {
  const prisma = fakePrisma(options.existing ?? null);
  const embeddings = fakeEmbeddings(options.embeddingsConfigured ?? true);
  const source = options.source ?? fakeSource();

  return {
    ...prisma,
    embeddings,
    source,
    service: new CorpusIngestionService(
      prisma.prisma as never,
      embeddings as never,
      source,
    ),
  };
}

describe('CorpusIngestionService', () => {
  describe('ingest', () => {
    it('writes the act and one chunk per article', async () => {
      const built = build();

      const report = await built.service.ingest();

      expect(report.ingested).toBe(1);
      expect(built.state.chunks).toHaveLength(2);
      expect(built.state.chunks.map((chunk) => chunk.articleLabel)).toEqual([
        '346',
        '347',
      ]);
    });

    it('embeds every chunk', async () => {
      const built = build();

      const report = await built.service.ingest();

      expect(report.embedded).toBe(2);
      expect(built.state.vectorWrites).toHaveLength(2);
    });

    it('does not attribute the embedding cost to any tenant', async () => {
      // The corpus belongs to nobody. Billing it to whoever triggered the run
      // would make one customer's AI bill jump for everyone's benefit.
      const built = build();

      await built.service.ingest();

      const [, context] = built.embeddings.embed.mock.calls[0];
      expect(context).not.toHaveProperty('companyId');
      expect(context).toMatchObject({ operation: 'legal_corpus_indexing' });
    });

    it('replaces an act wholesale rather than merging chunks', async () => {
      // Article boundaries shift when the splitter changes, so chunkIndex 3 in
      // the new set is unrelated to chunkIndex 3 in the old one. A merge would
      // strand stale passages that are still citable.
      const built = build({ existing: { id: 'act_1', revision: 'rev-0' } });

      await built.service.ingest();

      expect(built.state.deletedFor).toEqual(['act_1']);
    });
  });

  describe('repeat runs', () => {
    it('skips an act whose revision is unchanged', async () => {
      // Re-embedding an unchanged code is the most expensive no-op available.
      const built = build({ existing: { id: 'act_1', revision: 'rev-1' } });

      const report = await built.service.ingest();

      expect(report.unchanged).toBe(1);
      expect(report.ingested).toBe(0);
      expect(built.embeddings.embed).not.toHaveBeenCalled();
    });

    it('re-ingests when the revision moved', async () => {
      const built = build({ existing: { id: 'act_1', revision: 'rev-0' } });

      const report = await built.service.ingest();

      expect(report.ingested).toBe(1);
    });

    it('re-ingests unchanged acts when forced', async () => {
      // Needed after a change to the splitter or the embedding model: the
      // source text is identical, what should be stored for it is not.
      const built = build({ existing: { id: 'act_1', revision: 'rev-1' } });

      const report = await built.service.ingest({ force: true });

      expect(report.ingested).toBe(1);
      expect(report.unchanged).toBe(0);
    });
  });

  describe('without an embedding provider', () => {
    it('still builds a lexically searchable corpus', async () => {
      const built = build({ embeddingsConfigured: false });

      const report = await built.service.ingest();

      expect(report.ingested).toBe(1);
      expect(built.state.chunks).toHaveLength(2);
      expect(report.embedded).toBe(0);
      expect(report.lexicalOnly).toBe(true);
    });
  });

  describe('resilience', () => {
    it('keeps an act whose embeddings failed, rather than failing the act', async () => {
      // The chunks are already committed and lexically searchable — which for
      // statute text is the half that finds "347-modda". Reporting the act as
      // failed would send the next run to redo work that was done.
      const built = build();
      built.embeddings.embed.mockRejectedValueOnce(new Error('rate limited'));

      const report = await built.service.ingest();

      expect(report.failed).toBe(0);
      expect(report.ingested).toBe(1);
      expect(report.embedded).toBe(0);
      expect(built.state.chunks).toHaveLength(2);
    });

    it('continues past an act that fails', async () => {
      // One malformed act must not abandon the statute book.
      const built = build({
        source: fakeSource([{ ...ACT, content: '   ' }, { ...ACT, externalId: '-2' }]),
      });

      const report = await built.service.ingest();

      expect(report.failed).toBe(1);
      expect(report.ingested).toBe(1);
      expect(report.seen).toBe(2);
    });
  });

  describe('when no source is configured', () => {
    it('reports nothing rather than throwing', async () => {
      const built = build({
        source: { ...fakeSource(), isConfigured: () => false },
      });

      const report = await built.service.ingest();

      expect(report).toMatchObject({ seen: 0, ingested: 0 });
    });
  });
});

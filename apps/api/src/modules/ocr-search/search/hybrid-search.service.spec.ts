/**
 * Hybrid search orchestration.
 *
 * The two halves are already covered on their own — `query-normalizer.spec.ts`
 * for how a query becomes a tsquery, `rank-fusion.spec.ts` for how two ranked
 * lists become one. What is not covered is the service that decides which
 * retrievers run, what happens when the strict query finds nothing, and how
 * chunks become document-level hits.
 *
 * Those decisions fail quietly. A semantic retriever that runs without an API
 * key throws mid-request; one that is skipped when it should not be returns
 * fewer results rather than an error. A strict AND that is never relaxed
 * reports "no matches" for a document that contains every term but one spelled
 * differently — the single most common way a search feature is judged broken.
 *
 * Prisma's raw API is faked by reading the SQL: the two retrievers are told
 * apart by what they select, which is also how a test notices if one of them
 * silently stops running.
 */
import type { PrismaService } from '../../../prisma/prisma.service';
import type { OpenAiEmbeddingService } from '../embedding/openai-embedding.service';
import { HybridSearchService } from './hybrid-search.service';
import type { SearchQueryDto } from '../dto/search.dto';

type Row = {
  id: string;
  scannedDocumentId: string;
  chunkIndex: number;
  content: string;
  page: number | null;
  score?: number;
  distance?: number;
};

function chunk(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    scannedDocumentId: 'doc_1',
    chunkIndex: 0,
    content: `Content of ${id}`,
    page: 1,
    score: 0.5,
    ...overrides,
  };
}

/**
 * @param lexical rows returned by the strict lexical query, then by the relaxed
 *                one if a second call is made
 */
function build({
  // One hit by default, so the common case does not silently exercise the
  // relaxation path — the tests that want it ask for it.
  lexical = [[chunk('c1')]],
  semantic = [] as Row[],
  documents = [{ id: 'doc_1', originalName: 'contract.pdf' }],
  embeddingsConfigured = true,
}: {
  lexical?: Row[][];
  semantic?: Row[];
  documents?: { id: string; originalName: string }[];
  embeddingsConfigured?: boolean;
} = {}) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let lexicalCall = 0;

  const $queryRaw = jest.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      queries.push({ sql, values });

      if (sql.includes('ts_rank_cd')) {
        return lexical[lexicalCall++] ?? [];
      }
      // The semantic half selects a distance; the service converts it.
      return semantic.map((row) => ({
        ...row,
        distance: row.distance ?? 1 - (row.score ?? 0.5),
      }));
    },
  );

  const embedQuery = jest.fn(async () => Array(1536).fill(0.01));

  const service = new HybridSearchService(
    {
      client: {
        $queryRaw,
        scannedDocument: { findMany: async () => documents },
      },
    } as unknown as PrismaService,
    {
      isConfigured: () => embeddingsConfigured,
      embedQuery,
    } as unknown as OpenAiEmbeddingService,
  );

  const lexicalQueries = () => queries.filter((q) => q.sql.includes('ts_rank_cd'));
  const semanticQueries = () => queries.filter((q) => q.sql.includes('<=>'));

  return { service, queries, lexicalQueries, semanticQueries, embedQuery };
}

const dto = (overrides: Partial<SearchQueryDto> = {}): SearchQueryDto =>
  ({ q: 'termination notice', ...overrides }) as SearchQueryDto;

describe('HybridSearchService', () => {
  describe('an empty query', () => {
    it.each(['', '   ', '&|!()'])('runs no retriever for %p', async (q) => {
      // Operator-only input normalises to nothing. Running the retrievers on it
      // would scan the whole table to return zero rows.
      const { service, queries } = build();

      const result = await service.search(dto({ q }), 'co_1');

      expect(result.hits).toEqual([]);
      expect(result.retrievers).toEqual({ lexical: false, semantic: false });
      expect(queries).toHaveLength(0);
    });

    it('still reports the query it was given', async () => {
      const { service } = build();
      expect((await service.search(dto({ q: '' }), 'co_1')).query).toBe('');
    });
  });

  describe('which retrievers run', () => {
    it('runs both by default', async () => {
      const { service, lexicalQueries, semanticQueries } = build();

      const result = await service.search(dto(), 'co_1');

      expect(lexicalQueries()).toHaveLength(1);
      expect(semanticQueries()).toHaveLength(1);
      expect(result.retrievers).toEqual({ lexical: true, semantic: true });
    });

    it('skips the semantic half when no embedding key is configured', async () => {
      // Not an error: search still works lexically. Attempting it would throw
      // mid-request instead.
      const { service, semanticQueries, embedQuery } = build({
        embeddingsConfigured: false,
      });

      const result = await service.search(dto(), 'co_1');

      expect(semanticQueries()).toHaveLength(0);
      expect(embedQuery).not.toHaveBeenCalled();
      expect(result.retrievers.semantic).toBe(false);
    });

    it('runs only the lexical half in lexical mode', async () => {
      const { service, lexicalQueries, semanticQueries } = build();

      await service.search(dto({ mode: 'lexical' }), 'co_1');

      expect(lexicalQueries()).toHaveLength(1);
      expect(semanticQueries()).toHaveLength(0);
    });

    it('runs only the semantic half in semantic mode', async () => {
      const { service, lexicalQueries, semanticQueries } = build();

      await service.search(dto({ mode: 'semantic' }), 'co_1');

      expect(lexicalQueries()).toHaveLength(0);
      expect(semanticQueries()).toHaveLength(1);
    });
  });

  describe('query binding', () => {
    it('scopes every retriever to the caller’s company', async () => {
      // The one filter that must never be omitted: chunks carry other tenants'
      // document text.
      const { service, queries } = build({ semantic: [chunk('c1')] });

      await service.search(dto(), 'co_1');

      for (const query of queries) {
        expect(query.values).toContain('co_1');
      }
    });

    it('binds the tsquery rather than interpolating it', async () => {
      const { service, lexicalQueries } = build();

      await service.search(dto({ q: 'termination notice' }), 'co_1');

      // Terms are AND-ed and prefix-matched, so "notice" also finds "notices".
      // Bound as a parameter — the SQL text itself must not carry the terms.
      expect(lexicalQueries()[0].values).toContain('termination:* & notice:*');
      expect(lexicalQueries()[0].sql).not.toContain('termination');
    });

    it('asks each retriever for more candidates than a page holds', async () => {
      // Fusion can only reorder what it is given: a result ranked 40th by one
      // retriever and 45th by the other — exactly the agreement hybrid search
      // exists to surface — is invisible if each list is cut at the page size.
      const { service, queries } = build({ semantic: [chunk('c1')] });

      await service.search(dto({ limit: 10 }), 'co_1');

      for (const query of queries) {
        expect(query.values).toContain(50);
      }
    });

    it('passes a document filter through when one is given', async () => {
      const { service, lexicalQueries } = build();

      await service.search(dto({ documentId: 'doc_9' }), 'co_1');

      expect(lexicalQueries()[0].values).toContain('doc_9');
    });
  });

  describe('relaxation', () => {
    it('retries with OR when the strict query finds nothing', async () => {
      // Otherwise one term spelled differently reports "no matches" for a
      // document that contains everything else.
      const { service, lexicalQueries } = build({
        lexical: [[], [chunk('c1')]],
      });

      const result = await service.search(dto(), 'co_1');

      expect(lexicalQueries()).toHaveLength(2);
      expect(lexicalQueries()[1].values).toContain('termination:* | notice:*');
      expect(result.relaxed).toBe(true);
      expect(result.hits).toHaveLength(1);
    });

    it('does not relax when the strict query found something', async () => {
      const { service, lexicalQueries } = build({ lexical: [[chunk('c1')]] });

      const result = await service.search(dto(), 'co_1');

      expect(lexicalQueries()).toHaveLength(1);
      expect(result.relaxed).toBe(false);
    });

    it('reports relaxed=false when the looser query also finds nothing', async () => {
      // `relaxed` tells the UI to explain why the results look approximate.
      // Saying so when there are no results at all is just noise.
      const { service } = build({ lexical: [[], []] });

      const result = await service.search(dto(), 'co_1');

      expect(result.relaxed).toBe(false);
      expect(result.hits).toEqual([]);
    });

    it('does not relax in semantic mode, where there is no lexical query', async () => {
      const { service, lexicalQueries } = build({ semantic: [chunk('c1')] });

      const result = await service.search(dto({ mode: 'semantic' }), 'co_1');

      expect(lexicalQueries()).toHaveLength(0);
      expect(result.relaxed).toBe(false);
    });
  });

  describe('hits', () => {
    it('attaches the document name', async () => {
      const { service } = build({ lexical: [[chunk('c1')]] });

      const [hit] = (await service.search(dto(), 'co_1')).hits;

      expect(hit).toMatchObject({ documentId: 'doc_1', originalName: 'contract.pdf' });
    });

    it('names a document it could not resolve rather than rendering blank', async () => {
      const { service } = build({ lexical: [[chunk('c1')]], documents: [] });

      const [hit] = (await service.search(dto(), 'co_1')).hits;

      expect(hit.originalName).toBe('Unknown document');
    });

    it('collapses several chunks of one document into a single hit', async () => {
      // Three passages from the same contract are one result with context, not
      // three results that push everything else off the page.
      const { service } = build({
        lexical: [
          [
            chunk('c1', { chunkIndex: 0, score: 0.9 }),
            chunk('c2', { chunkIndex: 4, score: 0.7 }),
            chunk('c3', { chunkIndex: 9, score: 0.6 }),
          ],
        ],
      });

      const { hits } = await service.search(dto(), 'co_1');

      expect(hits).toHaveLength(1);
      expect(hits[0].alsoMatched).toHaveLength(2);
    });

    it('keeps documents separate', async () => {
      const { service } = build({
        lexical: [[chunk('c1'), chunk('c2', { scannedDocumentId: 'doc_2' })]],
        documents: [
          { id: 'doc_1', originalName: 'a.pdf' },
          { id: 'doc_2', originalName: 'b.pdf' },
        ],
      });

      expect((await service.search(dto(), 'co_1')).hits).toHaveLength(2);
    });

    it('marks a chunk both retrievers found', async () => {
      // The strongest relevance signal available, and the reason for running
      // two retrievers at all.
      const { service } = build({
        lexical: [[chunk('c1')]],
        semantic: [chunk('c1')],
      });

      const [hit] = (await service.search(dto(), 'co_1')).hits;

      expect(hit.matchedBoth).toBe(true);
      expect(hit.lexicalRank).not.toBeNull();
      expect(hit.semanticRank).not.toBeNull();
    });

    it('reports a similarity only for chunks the semantic half returned', async () => {
      const { service } = build({ lexical: [[chunk('c1')]] });

      const [hit] = (await service.search(dto({ mode: 'lexical' }), 'co_1')).hits;

      expect(hit.semanticSimilarity).toBeNull();
      expect(hit.semanticRank).toBeNull();
    });

    it('converts distance to similarity, so scores read one direction', async () => {
      // Distance is better when smaller; every other score here is better when
      // larger, and mixing the two silently inverts the ranking.
      const { service } = build({
        semantic: [chunk('c1', { distance: 0.2 })],
      });

      const [hit] = (await service.search(dto({ mode: 'semantic' }), 'co_1')).hits;

      expect(hit.semanticSimilarity).toBeGreaterThan(0.5);
    });

    it('honours the requested limit', async () => {
      const { service } = build({
        lexical: [
          Array.from({ length: 8 }, (_, index) =>
            chunk(`c${index}`, { scannedDocumentId: `doc_${index}` }),
          ),
        ],
        documents: Array.from({ length: 8 }, (_, index) => ({
          id: `doc_${index}`,
          originalName: `${index}.pdf`,
        })),
      });

      expect((await service.search(dto({ limit: 3 }), 'co_1')).hits).toHaveLength(3);
    });

    it('reports how long it took', async () => {
      const { service } = build({ lexical: [[chunk('c1')]] });

      expect((await service.search(dto(), 'co_1')).tookMs).toEqual(expect.any(Number));
    });
  });
});

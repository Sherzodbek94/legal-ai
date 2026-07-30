import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { OpenAiEmbeddingService } from '../embedding/openai-embedding.service';
import {
  normalizeQuery,
  relaxQuery,
  toVectorLiteral,
} from './query-normalizer';
import {
  distanceToSimilarity,
  fuseRankings,
  groupByDocument,
  type FusedResult,
  type RankedResult,
} from './rank-fusion';
import type { SearchQueryDto } from '../dto/search.dto';

interface ChunkRow {
  id: string;
  scannedDocumentId: string;
  chunkIndex: number;
  content: string;
  page: number | null;
  score: number;
}

export interface SearchHit {
  documentId: string;
  originalName: string;
  chunkId: string;
  chunkIndex: number;
  page: number | null;
  snippet: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  /** True when both retrievers found it — the strongest relevance signal. */
  matchedBoth: boolean;
  semanticSimilarity: number | null;
  /** Additional matching passages from the same document. */
  alsoMatched: { chunkId: string; chunkIndex: number; snippet: string }[];
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  /** Which retrievers actually ran; semantic is skipped without an API key. */
  retrievers: { lexical: boolean; semantic: boolean };
  /** True when the strict AND query returned nothing and terms were OR'd. */
  relaxed: boolean;
  tookMs: number;
}

@Injectable()
export class HybridSearchService {
  private readonly logger = new Logger(HybridSearchService.name);

  /**
   * How deep each retriever goes before fusion.
   *
   * Larger than the page size on purpose: fusion can only reorder what it is
   * given, so a result that lexical ranks 40th and semantic ranks 45th — exactly
   * the kind of agreement hybrid search exists to surface — is invisible if each
   * list is cut at 10.
   */
  private static readonly CANDIDATE_DEPTH = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: OpenAiEmbeddingService,
  ) {}

  async search(
    dto: SearchQueryDto,
    companyId: string,
  ): Promise<SearchResponse> {
    const startedAt = Date.now();
    const normalized = normalizeQuery(dto.q);

    if (normalized.empty) {
      return {
        query: dto.q,
        hits: [],
        retrievers: { lexical: false, semantic: false },
        relaxed: false,
        tookMs: Date.now() - startedAt,
      };
    }

    const wantSemantic = dto.mode !== 'lexical' && this.embeddings.isConfigured();
    const wantLexical = dto.mode !== 'semantic' && normalized.tsquery.length > 0;

    // Both retrievers run concurrently. They are independent queries against
    // different indexes, and serialising them would double the latency of the
    // slowest path for no benefit.
    const [lexicalRows, semanticRows] = await Promise.all([
      wantLexical
        ? this.lexicalSearch(normalized.tsquery, companyId, dto.documentId)
        : Promise.resolve([]),
      wantSemantic
        ? this.semanticSearch(normalized.semantic, companyId, dto.documentId)
        : Promise.resolve([]),
    ]);

    let lexical = lexicalRows;
    let relaxed = false;

    // Strict AND found nothing but semantic did, or nothing did: loosen to OR
    // rather than reporting no results because one term was spelled differently.
    if (wantLexical && lexical.length === 0) {
      const relaxedQuery = relaxQuery(normalized);
      if (relaxedQuery) {
        lexical = await this.lexicalSearch(relaxedQuery, companyId, dto.documentId);
        relaxed = lexical.length > 0;
      }
    }

    const fused = fuseRankings(
      lexical.map(toRanked),
      semanticRows.map(toRanked),
      { lexical: dto.lexicalWeight, semantic: dto.semanticWeight },
    );

    const rowsById = new Map<string, ChunkRow>();
    for (const row of [...lexicalRows, ...lexical, ...semanticRows]) {
      rowsById.set(row.id, row);
    }

    const grouped = groupByDocument(
      fused.filter((result) => rowsById.has(result.id)),
      (result) => rowsById.get(result.id)!.scannedDocumentId,
    ).slice(0, dto.limit ?? 20);

    const hits = await this.hydrate(grouped, rowsById, semanticRows, companyId);

    return {
      query: dto.q,
      hits,
      retrievers: { lexical: wantLexical, semantic: wantSemantic },
      relaxed,
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * Lexical half: GIN index over the generated tsvector.
   *
   * `ts_rank_cd` rather than `ts_rank` — cover density rewards documents where
   * the query terms appear near each other, which for a clause search is exactly
   * the signal wanted: "termination notice period" matching one sentence beats
   * the same three words scattered across forty pages.
   */
  private async lexicalSearch(
    tsquery: string,
    companyId: string,
    documentId?: string,
  ): Promise<ChunkRow[]> {
    // `tsquery` is assembled from operator-stripped tokens in normalizeQuery, and
    // is bound as a parameter and cast rather than interpolated.
    return this.prisma.client.$queryRaw<ChunkRow[]>`
      SELECT c."id",
             c."scannedDocumentId",
             c."chunkIndex",
             c."content",
             c."page",
             ts_rank_cd(c."searchVector", to_tsquery('simple', ${tsquery})) AS score
        FROM "document_chunks" c
        JOIN "scanned_documents" d ON d."id" = c."scannedDocumentId"
       WHERE c."companyId" = ${companyId}
         AND d."deletedAt" IS NULL
         AND (${documentId ?? null}::text IS NULL OR c."scannedDocumentId" = ${documentId ?? null}::text)
         AND c."searchVector" @@ to_tsquery('simple', ${tsquery})
       ORDER BY score DESC
       LIMIT ${HybridSearchService.CANDIDATE_DEPTH}
    `;
  }

  /**
   * Semantic half: HNSW index over the embedding, cosine distance via `<=>`.
   *
   * The ORDER BY has to be `embedding <=> literal` verbatim for the planner to
   * use the HNSW index — wrapping it in an expression, or ordering by a computed
   * similarity column, silently degrades this to a sequential scan over every
   * chunk in the table. Which still returns correct results, just slowly enough
   * that nobody notices until the corpus is large.
   */
  private async semanticSearch(
    query: string,
    companyId: string,
    documentId?: string,
  ): Promise<ChunkRow[]> {
    const embedding = await this.embeddings.embedQuery(query, companyId);
    // Validated numeric-only inside toVectorLiteral; a vector literal cannot be
    // passed as a bound parameter through Prisma's raw API.
    const literal = toVectorLiteral(embedding);

    const rows = await this.prisma.client.$queryRaw<
      (Omit<ChunkRow, 'score'> & { distance: number })[]
    >`
      SELECT c."id",
             c."scannedDocumentId",
             c."chunkIndex",
             c."content",
             c."page",
             c."embedding" <=> ${Prisma.raw(`'${literal}'::vector`)} AS distance
        FROM "document_chunks" c
        JOIN "scanned_documents" d ON d."id" = c."scannedDocumentId"
       WHERE c."companyId" = ${companyId}
         AND d."deletedAt" IS NULL
         AND c."embedding" IS NOT NULL
         AND (${documentId ?? null}::text IS NULL OR c."scannedDocumentId" = ${documentId ?? null}::text)
       ORDER BY c."embedding" <=> ${Prisma.raw(`'${literal}'::vector`)}
       LIMIT ${HybridSearchService.CANDIDATE_DEPTH}
    `;

    return rows.map((row) => ({
      id: row.id,
      scannedDocumentId: row.scannedDocumentId,
      chunkIndex: row.chunkIndex,
      content: row.content,
      page: row.page,
      // Converted to similarity so the score reads the same direction as the
      // lexical one everywhere downstream.
      score: distanceToSimilarity(Number(row.distance)),
    }));
  }

  /** Attaches document metadata and builds snippets. */
  private async hydrate(
    // Typed against FusedResult rather than `ReturnType<typeof groupByDocument>`:
    // that helper is generic, and the bare ReturnType resolves its default
    // instantiation, which drops the rank fields this needs.
    grouped: {
      documentId: string;
      best: FusedResult;
      chunks: FusedResult[];
      score: number;
    }[],
    rowsById: Map<string, ChunkRow>,
    semanticRows: ChunkRow[],
    companyId: string,
  ): Promise<SearchHit[]> {
    if (grouped.length === 0) return [];

    const documents = await this.prisma.client.scannedDocument.findMany({
      where: {
        id: { in: grouped.map((group) => group.documentId) },
        companyId,
      },
      select: { id: true, originalName: true },
    });
    const nameById = new Map(documents.map((doc) => [doc.id, doc.originalName]));

    const semanticScoreById = new Map(
      semanticRows.map((row) => [row.id, row.score]),
    );

    return grouped.map((group) => {
      const best = rowsById.get(group.best.id)!;

      return {
        documentId: group.documentId,
        originalName: nameById.get(group.documentId) ?? 'Unknown document',
        chunkId: best.id,
        chunkIndex: best.chunkIndex,
        page: best.page,
        snippet: snippet(best.content),
        score: group.best.rrfScore,
        lexicalRank: group.best.lexicalRank,
        semanticRank: group.best.semanticRank,
        matchedBoth: group.best.matchedBoth,
        semanticSimilarity: semanticScoreById.get(best.id) ?? null,
        alsoMatched: group.chunks
          .slice(1)
          .map((chunk) => {
            const row = rowsById.get(chunk.id)!;
            return {
              chunkId: row.id,
              chunkIndex: row.chunkIndex,
              snippet: snippet(row.content),
            };
          }),
      };
    });
  }
}

function toRanked(row: ChunkRow): RankedResult {
  return { id: row.id, score: Number(row.score) };
}

/**
 * Trims a passage for display.
 *
 * Cut at a word boundary rather than mid-word — a snippet ending "…the obliga"
 * looks like corrupted data, which undermines confidence in the extraction
 * itself.
 */
function snippet(content: string, maxLength = 320): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;

  const cut = collapsed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > maxLength * 0.6 ? lastSpace : maxLength)}…`;
}

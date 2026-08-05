import { Injectable, Logger } from '@nestjs/common';
import { LegalActStatus, type LegalActType } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { OpenAiEmbeddingService } from '../../ocr-search/embedding/openai-embedding.service';
import {
  normalizeQuery,
  relaxQuery,
  toVectorLiteral,
} from '../../ocr-search/search/query-normalizer';
import {
  distanceToSimilarity,
  fuseRankings,
  type RankedResult,
} from '../../ocr-search/search/rank-fusion';
import { formatCitation } from '../ingestion/article-splitter';
import type { CorpusSearchDto } from '../dto/corpus-search.dto';

interface CorpusRow {
  id: string;
  actId: string;
  chunkIndex: number;
  articleLabel: string | null;
  articlePart: number | null;
  content: string;
  title: string;
  number: string | null;
  type: LegalActType;
  status: LegalActStatus;
  language: string;
  url: string | null;
  score: number;
}

export interface CorpusHit {
  chunkId: string;
  actId: string;
  /** Rendered the same way everywhere a source is shown. */
  citation: string;
  title: string;
  number: string | null;
  type: LegalActType;
  status: LegalActStatus;
  language: string;
  articleLabel: string | null;
  articlePart: number | null;
  url: string | null;
  snippet: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  matchedBoth: boolean;
  semanticSimilarity: number | null;
  /**
   * True when the act is not recorded as in force.
   *
   * Surfaced rather than filtered: a repealed provision is often exactly what
   * someone researching a historic contract needs, and hiding it would make the
   * corpus look incomplete. Citing it unknowingly is the failure to prevent, so
   * the caller is told rather than the row removed.
   */
  superseded: boolean;
}

export interface CorpusSearchResponse {
  query: string;
  hits: CorpusHit[];
  retrievers: { lexical: boolean; semantic: boolean };
  relaxed: boolean;
  tookMs: number;
}

/**
 * Search over the legislation corpus.
 *
 * Deliberately a separate service from `HybridSearchService`, which searches a
 * tenant's own uploaded scans. The two corpora differ in every way that matters
 * to a query: this one is global rather than tenant-scoped, is cited by article
 * rather than by page, and carries a force status that changes whether a hit
 * should be relied on at all. Sharing one service would mean a `companyId` that
 * is meaningless half the time and a result shape where half the fields are
 * always null.
 *
 * What they do share is the retrieval machinery — normalisation, reciprocal
 * rank fusion, the distance-to-similarity conversion — because that part is
 * genuinely the same problem, and two copies of ranking logic is two copies
 * that drift.
 */
@Injectable()
export class CorpusSearchService {
  private readonly logger = new Logger(CorpusSearchService.name);

  /** See HybridSearchService: fusion can only reorder what it is given. */
  private static readonly CANDIDATE_DEPTH = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: OpenAiEmbeddingService,
  ) {}

  async search(dto: CorpusSearchDto): Promise<CorpusSearchResponse> {
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

    // The semantic half is allowed to fail. An expired key, a rate limit, or a
    // provider outage should cost the query its vector recall and nothing more
    // — the lexical half is answering from a local index, and on statute text
    // it is the half that finds "347-modda" at all. Rejecting the whole search
    // would turn a degraded dependency into an outage.
    //
    // Reported honestly through `retrievers.semantic`, so a caller can tell the
    // difference between "no semantic matches" and "semantic did not run".
    const [lexicalRows, semanticResult] = await Promise.all([
      wantLexical ? this.lexical(normalized.tsquery, dto) : Promise.resolve([]),
      wantSemantic
        ? this.semantic(normalized.semantic, dto).then(
            (rows) => ({ ok: true as const, rows }),
            (error: unknown) => {
              this.logger.warn(
                `Semantic retrieval unavailable, answering lexically: ${(error as Error)?.message ?? 'unknown error'}`,
              );
              return { ok: false as const, rows: [] as CorpusRow[] };
            },
          )
        : Promise.resolve({ ok: false as const, rows: [] as CorpusRow[] }),
    ]);

    const semanticRows = semanticResult.rows;
    const semanticRan = semanticResult.ok;

    let lexical = lexicalRows;
    let relaxed = false;

    if (wantLexical && lexical.length === 0) {
      const relaxedQuery = relaxQuery(normalized);
      if (relaxedQuery) {
        lexical = await this.lexical(relaxedQuery, dto);
        relaxed = lexical.length > 0;
      }
    }

    const fused = fuseRankings(
      lexical.map(toRanked),
      semanticRows.map(toRanked),
      { lexical: dto.lexicalWeight, semantic: dto.semanticWeight },
    );

    const rowsById = new Map<string, CorpusRow>();
    for (const row of [...lexicalRows, ...lexical, ...semanticRows]) {
      rowsById.set(row.id, row);
    }

    const similarityById = new Map(
      semanticRows.map((row) => [row.id, distanceToSimilarity(row.score)]),
    );

    // An article named in the query is a lookup, not a ranking guess.
    //
    // Without this, searching `347-modda` ranked article 348 first — because
    // 348 opens "ushbu Kodeksning 347-moddasida nazarda tutilgan...", so it
    // carries the query terms *and* its own heading, which cover density
    // rewards. The article that references 347 outranking article 347 is
    // exactly wrong for the one query where the user has told us precisely
    // what they want.
    const requested = requestedArticles(dto.q);
    const ordered =
      requested.length === 0
        ? fused.filter((result) => rowsById.has(result.id))
        : [
            ...fused.filter(
              (result) =>
                rowsById.has(result.id) &&
                isRequested(rowsById.get(result.id)!, requested),
            ),
            ...fused.filter(
              (result) =>
                rowsById.has(result.id) &&
                !isRequested(rowsById.get(result.id)!, requested),
            ),
          ];

    // Not grouped by act, unlike the scan search. Two articles of the same code
    // are two distinct provisions and both belong in the answer; collapsing
    // them would hide the second one behind "also matched".
    const hits = ordered
      .slice(0, dto.limit ?? 20)
      .map((result) => {
        const row = rowsById.get(result.id)!;

        return {
          chunkId: row.id,
          actId: row.actId,
          citation: formatCitation(row, row),
          title: row.title,
          number: row.number,
          type: row.type,
          status: row.status,
          language: row.language,
          articleLabel: row.articleLabel,
          articlePart: row.articlePart,
          url: row.url,
          snippet: row.content,
          score: result.rrfScore,
          lexicalRank: result.lexicalRank,
          semanticRank: result.semanticRank,
          matchedBoth: result.matchedBoth,
          semanticSimilarity: similarityById.get(row.id) ?? null,
          superseded: row.status !== LegalActStatus.IN_FORCE,
        } satisfies CorpusHit;
      });

    return {
      query: dto.q,
      hits,
      retrievers: { lexical: wantLexical, semantic: semanticRan },
      relaxed,
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * Lexical half.
   *
   * `ts_rank_cd` for cover density, same as the scan search — but it earns more
   * here. Statute text is where exact-token matching is at its best: somebody
   * searching `347-modda` wants that article, and no amount of semantic
   * similarity finds a number as reliably as an index on the token does.
   */
  private lexical(tsquery: string, dto: CorpusSearchDto): Promise<CorpusRow[]> {
    return this.prisma.client.$queryRaw<CorpusRow[]>`
      SELECT c."id",
             c."actId",
             c."chunkIndex",
             c."articleLabel",
             c."articlePart",
             c."content",
             a."title",
             a."number",
             a."type",
             a."status",
             a."language",
             a."url",
             ts_rank_cd(c."searchVector", to_tsquery('simple', ${tsquery})) AS score
        FROM "legal_act_chunks" c
        JOIN "legal_acts" a ON a."id" = c."actId"
       WHERE a."retiredAt" IS NULL
         AND (${dto.language ?? null}::text IS NULL OR a."language" = ${dto.language ?? null}::text)
         AND (${dto.inForceOnly ?? false}::boolean IS FALSE OR a."status" = 'IN_FORCE')
         AND c."searchVector" @@ to_tsquery('simple', ${tsquery})
       ORDER BY score DESC
       LIMIT ${CorpusSearchService.CANDIDATE_DEPTH}
    `;
  }

  /** Semantic half: HNSW over cosine distance. Lower score is nearer. */
  private async semantic(query: string, dto: CorpusSearchDto): Promise<CorpusRow[]> {
    const embedding = await this.embeddings.embedQuery(query);
    const literal = toVectorLiteral(embedding);

    return this.prisma.client.$queryRaw<CorpusRow[]>`
      SELECT c."id",
             c."actId",
             c."chunkIndex",
             c."articleLabel",
             c."articlePart",
             c."content",
             a."title",
             a."number",
             a."type",
             a."status",
             a."language",
             a."url",
             (c."embedding" <=> ${literal}::vector) AS score
        FROM "legal_act_chunks" c
        JOIN "legal_acts" a ON a."id" = c."actId"
       WHERE a."retiredAt" IS NULL
         AND c."embedding" IS NOT NULL
         AND (${dto.language ?? null}::text IS NULL OR a."language" = ${dto.language ?? null}::text)
         AND (${dto.inForceOnly ?? false}::boolean IS FALSE OR a."status" = 'IN_FORCE')
       ORDER BY c."embedding" <=> ${literal}::vector
       LIMIT ${CorpusSearchService.CANDIDATE_DEPTH}
    `;
  }
}

function toRanked(row: CorpusRow): RankedResult {
  return { id: row.id, score: row.score };
}

/**
 * Article numbers the query explicitly asks for.
 *
 * Matches the citation forms a lawyer types — `347-modda`, `347-модда`,
 * `статья 347`, `347-moddasi` with any case suffix — and deliberately not a
 * bare `347`. A bare number is far more often a sum of money, a year, or a
 * contract number than an article reference, and treating it as one would
 * reorder ordinary searches around a coincidence.
 */
export function requestedArticles(query: string): string[] {
  const found = new Set<string>();

  const pattern =
    /(\d+(?:-\d+)?)[-–—]\s*(?:modda|модда)\w*|(?:статья|моддас[иы]|article)\s+(\d+(?:-\d+)?)/gi;

  for (const match of query.matchAll(pattern)) {
    const label = match[1] ?? match[2];
    if (label) found.add(label);
  }

  return [...found];
}

function isRequested(
  row: { articleLabel: string | null },
  requested: string[],
): boolean {
  return row.articleLabel !== null && requested.includes(row.articleLabel);
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OpenAiEmbeddingService } from '../../ocr-search/embedding/openai-embedding.service';
import { toVectorLiteral } from '../../ocr-search/search/query-normalizer';
import { splitIntoArticles } from './article-splitter';
import { LEGAL_CORPUS_SOURCE, type LegalCorpusSource, type SourceAct } from '../sources/legal-source';

export interface IngestionReport {
  source: string;
  /** Acts the source offered. */
  seen: number;
  /** Acts written or rewritten. */
  ingested: number;
  /** Acts skipped because their revision was unchanged. */
  unchanged: number;
  /** Acts that failed; the run continues past each. */
  failed: number;
  chunks: number;
  embedded: number;
  /** True when nothing could be embedded, so retrieval is lexical only. */
  lexicalOnly: boolean;
  tookMs: number;
}

/**
 * Builds the legislation corpus.
 *
 * The retrieval half of "answers grounded in Uzbek law". Everything downstream
 * — corpus search, cited AI answers, a template that has to name the article it
 * relies on — reads what this writes.
 *
 * Two properties the implementation is organised around:
 *
 *   * **Resumable.** Acts are committed one at a time, not in one transaction
 *     over the statute book. A run interrupted halfway leaves a corpus that is
 *     smaller than intended and completely correct, and the next run continues
 *     from there.
 *   * **Cheap to repeat.** An act whose `revision` is unchanged is skipped
 *     before anything is chunked or embedded. Legislation changes rarely;
 *     re-embedding an unchanged code is the most expensive no-op available.
 */
@Injectable()
export class CorpusIngestionService {
  private readonly logger = new Logger(CorpusIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: OpenAiEmbeddingService,
    @Inject(LEGAL_CORPUS_SOURCE)
    private readonly source: LegalCorpusSource,
  ) {}

  isConfigured(): boolean {
    return this.source.isConfigured();
  }

  /**
   * What the corpus currently holds.
   *
   * `embeddedChunks` is the number worth watching: a corpus ingested while the
   * embedding provider was unavailable is searchable lexically and invisible to
   * semantic retrieval, and nothing else would report that.
   */
  async status() {
    const [acts, chunks, embeddedChunks, byType, newest] = await Promise.all([
      this.prisma.client.legalAct.count({ where: { retiredAt: null } }),
      this.prisma.client.legalActChunk.count(),
      this.prisma.client.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
          FROM "legal_act_chunks"
         WHERE "embedding" IS NOT NULL
      `,
      this.prisma.client.legalAct.groupBy({
        by: ['type'],
        where: { retiredAt: null },
        _count: { _all: true },
      }),
      this.prisma.client.legalAct.findFirst({
        where: { retiredAt: null },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
    ]);

    const embedded = Number(embeddedChunks[0]?.count ?? 0);

    return {
      source: this.source.name,
      configured: this.isConfigured(),
      acts,
      chunks,
      embeddedChunks: embedded,
      // A corpus with chunks but no vectors answers exact-token queries and
      // nothing else. Named rather than left to be inferred from two numbers.
      lexicalOnly: chunks > 0 && embedded === 0,
      byType: Object.fromEntries(
        byType.map((row) => [row.type, row._count._all]),
      ),
      lastIngestedAt: newest?.updatedAt ?? null,
    };
  }

  async ingest(options: { force?: boolean } = {}): Promise<IngestionReport> {
    const startedAt = Date.now();
    const report: IngestionReport = {
      source: this.source.name,
      seen: 0,
      ingested: 0,
      unchanged: 0,
      failed: 0,
      chunks: 0,
      embedded: 0,
      lexicalOnly: !this.embeddings.isConfigured(),
      tookMs: 0,
    };

    if (!this.isConfigured()) {
      this.logger.warn('No legal corpus source is configured; nothing to ingest');
      report.tookMs = Date.now() - startedAt;
      return report;
    }

    if (report.lexicalOnly) {
      // Worth stating once at the top rather than per act. The corpus is still
      // useful — exact-token search over statute text is the half that finds
      // "347-modda" — but semantic retrieval will be absent until a key exists.
      this.logger.warn(
        'OPENAI_API_KEY is not configured: the corpus will be searchable lexically but not semantically',
      );
    }

    for await (const act of this.source.acts()) {
      report.seen += 1;

      try {
        const result = await this.ingestAct(act, options.force === true);

        if (result === 'unchanged') {
          report.unchanged += 1;
          continue;
        }

        report.ingested += 1;
        report.chunks += result.chunks;
        report.embedded += result.embedded;
      } catch (error) {
        report.failed += 1;
        // One malformed act must not abandon the statute book.
        this.logger.error(
          `Failed to ingest ${act.externalId} (${act.language}): ${(error as Error)?.message ?? 'unknown error'}`,
        );
      }
    }

    // Recomputed from the outcome, not from configuration at the start. A key
    // that is present but rejected — an expired one, or the `sk-...` left in
    // `.env.example` — configures as available and embeds nothing, and a report
    // claiming semantic retrieval works would be believed.
    report.lexicalOnly = report.chunks > 0 && report.embedded === 0;
    report.tookMs = Date.now() - startedAt;

    this.logger.log(
      `Corpus ingest from ${report.source}: ${report.ingested} ingested, ` +
        `${report.unchanged} unchanged, ${report.failed} failed, ` +
        `${report.chunks} chunks, ${report.embedded} embedded (${report.tookMs}ms)`,
    );

    return report;
  }

  private async ingestAct(
    act: SourceAct,
    force: boolean,
  ): Promise<'unchanged' | { chunks: number; embedded: number }> {
    const key = {
      source_externalId_language: {
        source: this.source.name,
        externalId: act.externalId,
        language: act.language,
      },
    };

    const existing = await this.prisma.client.legalAct.findUnique({
      where: key,
      select: { id: true, revision: true },
    });

    if (
      !force &&
      existing &&
      act.revision &&
      existing.revision === act.revision
    ) {
      return 'unchanged';
    }

    const chunks = splitIntoArticles(act.content);
    if (chunks.length === 0) {
      throw new Error('produced no chunks');
    }

    const record = {
      source: this.source.name,
      externalId: act.externalId,
      url: act.url ?? null,
      type: act.type,
      number: act.number ?? null,
      title: act.title,
      language: act.language,
      adoptedAt: act.adoptedAt ?? null,
      effectiveFrom: act.effectiveFrom ?? null,
      status: act.status,
      revision: act.revision ?? null,
      content: act.content,
      retiredAt: null,
    };

    // Replaced wholesale rather than diffed. Article boundaries shift when the
    // text or the splitter changes, so `chunkIndex` 3 in the new set has no
    // relationship to `chunkIndex` 3 in the old one and a merge would leave
    // stale passages behind — passages that would still be cited.
    const actId = await this.prisma.client.$transaction(async (tx) => {
      const saved = await tx.legalAct.upsert({
        where: key,
        create: record,
        update: record,
        select: { id: true },
      });

      await tx.legalActChunk.deleteMany({ where: { actId: saved.id } });

      await tx.legalActChunk.createMany({
        data: chunks.map((chunk, index) => ({
          actId: saved.id,
          chunkIndex: index,
          articleLabel: chunk.articleLabel,
          articlePart: chunk.articlePart,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
        })),
      });

      return saved.id;
    });

    // Embedding failure is not act failure. The chunks are committed above and
    // are already lexically searchable — which for statute text is the half
    // that finds "347-modda" — so a provider outage, a rate limit, or a stale
    // key should cost this act its vectors and nothing else. Throwing here
    // would report an act as failed while its text sits in the database, and
    // send the next run to redo work that was done.
    let embedded = 0;

    try {
      embedded = await this.embedAct(actId);
    } catch (error) {
      this.logger.warn(
        `Embedded no chunks for ${act.externalId} (${act.language}); it is searchable lexically only: ` +
          `${(error as Error)?.message ?? 'unknown error'}`,
      );
    }

    return { chunks: chunks.length, embedded };
  }

  /**
   * Embeds an act's chunks and writes the vectors.
   *
   * Raw SQL for the write because `vector` is an `Unsupported` column type that
   * the generated client cannot set. `toVectorLiteral` rejects anything that is
   * not a finite number before it reaches the statement.
   */
  private async embedAct(actId: string): Promise<number> {
    if (!this.embeddings.isConfigured()) return 0;

    const chunks = await this.prisma.client.legalActChunk.findMany({
      where: { actId },
      orderBy: { chunkIndex: 'asc' },
      select: { id: true, content: true, tokenCount: true },
    });

    if (chunks.length === 0) return 0;

    // `embed` batches internally against the provider's per-request count and
    // token limits — a code runs to thousands of articles, and one request
    // carrying all of them would be rejected outright.
    //
    // No `companyId`: the corpus belongs to no tenant, so this cost is the
    // platform's rather than any customer's, and attributing it to whoever
    // happened to trigger the run would make one tenant's AI bill jump for
    // work done on everyone's behalf.
    const results = await this.embeddings.embed(
      chunks.map((chunk) => ({
        content: chunk.content,
        tokenCount: chunk.tokenCount,
      })),
      { operation: 'legal_corpus_indexing' },
    );

    let embedded = 0;

    for (const result of results) {
      // Results carry the index of their input, not an id — empty passages are
      // filtered out before the request, so the arrays are not parallel.
      const chunk = chunks[result.index];
      if (!chunk) continue;

      await this.prisma.client.$executeRawUnsafe(
        `UPDATE "legal_act_chunks" SET "embedding" = $1::vector WHERE "id" = $2`,
        toVectorLiteral(result.embedding),
        chunk.id,
      );
      embedded += 1;
    }

    return embedded;
  }
}

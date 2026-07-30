import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OpenAiEmbeddingService } from './openai-embedding.service';
import { chunkText } from './chunking';
import { toVectorLiteral } from '../search/query-normalizer';

export interface IndexResult {
  documentId: string;
  chunks: number;
  embedded: number;
  /** True when only the lexical half was built, because embedding is unavailable. */
  lexicalOnly: boolean;
}

/**
 * Builds the search index for a document.
 *
 * Chunks are written before their embeddings. That ordering is deliberate: the
 * lexical half of hybrid search needs only the text — the `tsvector` is a
 * generated column and exists the moment the row does — so a document becomes
 * findable immediately, and stays findable if the embedding provider is down.
 * Half a search index beats none.
 */
@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: OpenAiEmbeddingService,
  ) {}

  async indexDocument(documentId: string): Promise<IndexResult> {
    const document = await this.prisma.client.scannedDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        companyId: true,
        extractedText: true,
        uploadedById: true,
      },
    });

    if (!document) throw new NotFoundException('Document not found');
    if (!document.extractedText?.trim()) {
      return { documentId, chunks: 0, embedded: 0, lexicalOnly: true };
    }

    const chunks = chunkText(document.extractedText);
    if (chunks.length === 0) {
      return { documentId, chunks: 0, embedded: 0, lexicalOnly: true };
    }

    // Re-indexing replaces wholesale rather than diffing. Chunk boundaries shift
    // when the text or the chunking strategy changes, so `chunkIndex` 3 in the
    // new set has no relationship to `chunkIndex` 3 in the old one and a merge
    // would leave stale passages behind.
    await this.prisma.client.$transaction(async (tx) => {
      await tx.documentChunk.deleteMany({ where: { scannedDocumentId: documentId } });

      await tx.documentChunk.createMany({
        data: chunks.map((chunk) => ({
          companyId: document.companyId,
          scannedDocumentId: documentId,
          chunkIndex: chunk.index,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
        })),
      });
    });

    if (!this.embeddings.isConfigured()) {
      this.logger.warn(
        `Indexed ${chunks.length} chunk(s) for ${documentId} without embeddings: OPENAI_API_KEY is not configured`,
      );
      return {
        documentId,
        chunks: chunks.length,
        embedded: 0,
        lexicalOnly: true,
      };
    }

    const embedded = await this.embedChunks(documentId, document.companyId, document.uploadedById);

    this.logger.log(
      `Indexed ${chunks.length} chunk(s) for ${documentId}, ${embedded} embedded`,
    );

    return {
      documentId,
      chunks: chunks.length,
      embedded,
      lexicalOnly: embedded === 0,
    };
  }

  /**
   * Embeds a document's chunks and writes the vectors.
   *
   * The write is raw SQL because `vector` is an `Unsupported` column type — the
   * generated Prisma client cannot set it. Rows are matched by id, and the vector
   * literal is built by `toVectorLiteral`, which rejects anything that is not a
   * finite number before it reaches the statement.
   */
  private async embedChunks(
    documentId: string,
    companyId: string,
    userId?: string | null,
  ): Promise<number> {
    const chunks = await this.prisma.client.documentChunk.findMany({
      where: { scannedDocumentId: documentId },
      orderBy: { chunkIndex: 'asc' },
      select: { id: true, content: true, tokenCount: true },
    });

    if (chunks.length === 0) return 0;

    const results = await this.embeddings.embed(
      chunks.map((chunk) => ({
        content: chunk.content,
        tokenCount: chunk.tokenCount,
      })),
      {
        companyId,
        userId: userId ?? undefined,
        operation: 'document_indexing',
      },
    );

    let written = 0;

    for (const result of results) {
      const chunk = chunks[result.index];
      if (!chunk) continue;

      const literal = toVectorLiteral(result.embedding);

      await this.prisma.client.$executeRawUnsafe(
        `UPDATE "document_chunks"
            SET "embedding" = $1::vector,
                "updatedAt" = NOW()
          WHERE "id" = $2`,
        literal,
        chunk.id,
      );
      written++;
    }

    return written;
  }

  /**
   * Re-indexes documents whose chunks were never embedded.
   *
   * The gap this fills: a document indexed while the embedding provider was down
   * is searchable lexically but invisible to semantic search, and nothing would
   * otherwise notice. Run after restoring an API key, or on a schedule.
   */
  async backfillMissingEmbeddings(companyId?: string, limit = 20): Promise<IndexResult[]> {
    if (!this.embeddings.isConfigured()) {
      throw new NotFoundException('Embedding provider is not configured');
    }

    const rows = await this.prisma.client.$queryRaw<{ scannedDocumentId: string }[]>`
      SELECT DISTINCT c."scannedDocumentId"
        FROM "document_chunks" c
       WHERE c."embedding" IS NULL
         AND (${companyId ?? null}::text IS NULL OR c."companyId" = ${companyId ?? null}::text)
       LIMIT ${limit}
    `;

    const results: IndexResult[] = [];

    for (const row of rows) {
      try {
        results.push(await this.indexDocument(row.scannedDocumentId));
      } catch (error) {
        this.logger.error(
          `Backfill failed for ${row.scannedDocumentId}: ${
            (error as Error)?.message ?? 'unknown error'
          }`,
        );
      }
    }

    return results;
  }
}

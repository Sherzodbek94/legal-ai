import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AiCostService } from '../../admin/analytics/ai-cost.service';
import { batchChunks, estimateTokens } from './chunking';

/** Dimensions of `text-embedding-3-small`, and of the database columns. */
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_MODEL = 'text-embedding-3-small';

export interface EmbeddingInput {
  content: string;
  tokenCount: number;
}

export interface EmbeddingResult {
  /** Index into the input array. Batching must not reorder results. */
  index: number;
  embedding: number[];
}

@Injectable()
export class OpenAiEmbeddingService {
  private readonly logger = new Logger(OpenAiEmbeddingService.name);
  private client?: OpenAI;

  constructor(
    private readonly config: ConfigService,
    private readonly aiCosts: AiCostService,
  ) {}

  private get model(): string {
    return this.config.get<string>('OPENAI_EMBEDDING_MODEL', EMBEDDING_MODEL);
  }

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('OPENAI_API_KEY'));
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
        maxRetries: 0, // Retries are handled here, with our own backoff.
      });
    }
    return this.client;
  }

  /**
   * Embeds a query.
   *
   * Same model and same normalisation as the indexed passages — a query embedded
   * by a different model, or with different preprocessing, lands somewhere
   * unrelated in the vector space and every result is noise.
   */
  async embedQuery(query: string, companyId?: string): Promise<number[]> {
    const [result] = await this.embed(
      [{ content: query, tokenCount: estimateTokens(query) }],
      { companyId, operation: 'search_query' },
    );

    if (!result) {
      throw new ServiceUnavailableException('Could not embed the search query');
    }
    return result.embedding;
  }

  /**
   * Embeds passages, batching by count and token budget.
   *
   * Results are keyed by input index rather than returned positionally across
   * batches: a silent off-by-one here attaches every passage's vector to the
   * wrong passage, which produces a search index that is confidently and
   * undetectably wrong.
   */
  async embed(
    inputs: EmbeddingInput[],
    context: { companyId?: string; userId?: string; operation?: string } = {},
  ): Promise<EmbeddingResult[]> {
    if (inputs.length === 0) return [];

    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY is not configured; semantic indexing is unavailable',
      );
    }

    // Empty strings are rejected by the API and would fail the whole batch.
    const indexed = inputs
      .map((input, index) => ({ ...input, index }))
      .filter((input) => input.content.trim().length > 0);

    const batches = batchChunks(indexed);
    const results: EmbeddingResult[] = [];

    for (const batch of batches) {
      const embeddings = await this.embedBatchWithRetry(
        batch.map((item) => item.content),
      );

      if (embeddings.length !== batch.length) {
        throw new ServiceUnavailableException(
          `Embedding provider returned ${embeddings.length} vectors for ${batch.length} inputs`,
        );
      }

      batch.forEach((item, position) => {
        const embedding = embeddings[position];

        if (embedding.length !== EMBEDDING_DIMENSIONS) {
          // The column width is fixed; a mismatch means the configured model is
          // not the one the schema was built for and every insert would fail.
          throw new ServiceUnavailableException(
            `Model ${this.model} returned ${embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
          );
        }

        results.push({ index: item.index, embedding });
      });

      await this.aiCosts.record({
        provider: 'openai',
        model: this.model,
        operation: context.operation ?? 'embedding',
        // Embeddings bill on input only; there are no output tokens.
        inputTokens: batch.reduce((sum, item) => sum + item.tokenCount, 0),
        outputTokens: 0,
        companyId: context.companyId,
        userId: context.userId,
      });
    }

    return results.sort((a, b) => a.index - b.index);
  }

  /**
   * One batch, with bounded exponential backoff.
   *
   * Only rate limits and server errors are retried. A 400 means the request is
   * malformed — usually an input over the token limit — and re-sending it
   * unchanged burns quota to reach the same answer.
   */
  private async embedBatchWithRetry(
    inputs: string[],
    maxAttempts = 3,
  ): Promise<number[][]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.getClient().embeddings.create({
          model: this.model,
          input: inputs,
          encoding_format: 'float',
        });

        // The API documents that `data` may come back out of order; sorting by
        // its own index is the only safe way to align it with the input array.
        return [...response.data]
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding as number[]);
      } catch (error) {
        lastError = error;

        const status = (error as { status?: number })?.status;
        const retryable = status === undefined || status === 429 || status >= 500;

        if (!retryable || attempt === maxAttempts) break;

        // 500ms, 1s, 2s. Jittered so a batch of parallel documents does not
        // retry in lockstep and re-trip the same rate limit.
        const backoff = 500 * 2 ** (attempt - 1) * (0.5 + Math.random());
        this.logger.warn(
          `Embedding attempt ${attempt}/${maxAttempts} failed (status ${status ?? 'unknown'}); retrying in ${Math.round(backoff)}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    const message = (lastError as Error)?.message ?? 'unknown error';
    this.logger.error(`Embedding failed after ${maxAttempts} attempts: ${message}`);
    throw new ServiceUnavailableException(`Embedding provider failed: ${message}`);
  }
}

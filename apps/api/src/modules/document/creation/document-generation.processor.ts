import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { GeneratedDocumentStatus, Prisma } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { AiEngineService } from '../../ai-engine/ai-engine.service';
import type { LegalLocale } from '../../ai-engine/providers/llm-provider.interface';
import { UsageService } from '../../billing/limits/usage.service';
import { NotificationGateway } from '../../notification/gateway/notification.gateway';
import {
  QUEUE_NAMES,
  WORKER_LIMITS,
  type DocumentGenerationJob,
} from '../../notification/queues/queue.constants';
import { draftToContent, draftToSummary } from './draft-to-content';

/**
 * Drafts a document with AI, after the row already exists.
 *
 * The ordering is what makes this safe. `DocumentCreationService` writes the
 * document first, with the interpolated template as its body, and only then
 * enqueues. So this worker is never the difference between a document and no
 * document — it is the difference between the template text and a drafted
 * version of it. A provider outage, an exhausted retry budget, a worker that
 * dies mid-job: all of them leave the customer holding the same usable document
 * they had a second after they pressed the button.
 *
 * That is also why there is no `FAILED` transition here. A status the UI offers
 * no way out of is a dead row in somebody's document list, and the fallback
 * that avoids it is already sitting in the `content` column.
 */
@Injectable()
@Processor(QUEUE_NAMES.DOCUMENT_GENERATION, {
  concurrency: WORKER_LIMITS[QUEUE_NAMES.DOCUMENT_GENERATION].concurrency,
})
export class DocumentGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentGenerationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiEngine: AiEngineService,
    private readonly usage: UsageService,
    private readonly gateway: NotificationGateway,
  ) {
    super();
  }

  async process(job: Job<DocumentGenerationJob>): Promise<void> {
    const { documentId, companyId, userId } = job.data;

    try {
      const { document } = await this.aiEngine.generateLegalDocument({
        locale: job.data.locale as LegalLocale,
        documentType: job.data.documentType,
        variables: job.data.variables,
        instructions: job.data.instructions,
        companyId,
        userId,
      });

      await this.prisma.client.generatedDocument.update({
        where: { id: documentId },
        data: {
          content: draftToContent(document) as unknown as Prisma.InputJsonValue,
          aiSummary: draftToSummary(document),
          status: GeneratedDocumentStatus.GENERATED,
          generatedAt: new Date(),
        },
      });

      this.push(userId, documentId, GeneratedDocumentStatus.GENERATED, {
        drafted: true,
        unresolvedVariables: document.missingFields,
      });
    } catch (error) {
      const message = (error as Error)?.message ?? 'unknown error';

      // `attemptsMade` counts this attempt, so the comparison is inclusive.
      // Releasing on every attempt would hand the same allowance back several
      // times over for one job.
      const lastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
      if (!lastAttempt) {
        this.logger.warn(
          `AI draft for document ${documentId} failed (attempt ${job.attemptsMade}); will retry: ${message}`,
        );
        // Rethrown so BullMQ schedules the retry rather than marking it done.
        throw error;
      }

      await this.settleAsTemplate(job.data, message);
    }
  }

  /**
   * Gives up on the draft and leaves the document as its template text.
   *
   * The customer is not charged for a draft they did not get, and the document
   * they already had stays exactly as it was — only its status moves out of
   * `GENERATING`, so nothing is left waiting on a worker that is finished.
   */
  private async settleAsTemplate(
    data: DocumentGenerationJob,
    reason: string,
  ): Promise<void> {
    this.logger.error(
      `AI draft for document ${data.documentId} gave up after the final attempt; ` +
        `leaving the interpolated template in place: ${reason}`,
    );

    if (data.reservation) {
      await this.usage.release({
        ...data.reservation,
        periodStart: new Date(data.reservation.periodStart),
      } as never);
    }

    await this.prisma.client.generatedDocument
      .update({
        where: { id: data.documentId },
        data: { status: GeneratedDocumentStatus.GENERATED },
      })
      .catch((error: Error) => {
        // The document is readable either way; a row stuck reporting
        // GENERATING is a cosmetic lie, not a lost document.
        this.logger.error(
          `Could not clear GENERATING on document ${data.documentId}: ${error.message}`,
        );
      });

    this.push(data.userId, data.documentId, GeneratedDocumentStatus.GENERATED, {
      drafted: false,
      reason: 'AI drafting was unavailable; the template text was kept.',
    });
  }

  private push(
    userId: string,
    documentId: string,
    status: GeneratedDocumentStatus,
    detail: Record<string, unknown>,
  ): void {
    // Best effort: whether a socket happened to be open is not part of whether
    // the document was drafted. The page polls as well.
    try {
      this.gateway.pushToUser(userId, 'document.generation_finished', {
        documentId,
        status,
        ...detail,
      });
    } catch (error) {
      this.logger.warn(
        `Could not push generation result for ${documentId}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
    }
  }
}

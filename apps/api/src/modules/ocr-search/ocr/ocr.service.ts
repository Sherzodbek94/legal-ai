import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { OcrStatus, Prisma } from '@legaltech/database';
import { findPii, type PiiMatch } from '../../../common/pii/pii-patterns';
import { maskValue, summarizePii } from '../../../common/pii/pii-redactor';

/**
 * Columns returned when a document is ingested.
 *
 * Excludes `extractedText` — which is the full text of the document and can run
 * to megabytes — and `storageKey`, which is a private bucket path a client has no
 * use for. Declared once so the create and duplicate-detection paths cannot
 * return different shapes.
 */
const INGEST_SUMMARY = {
  id: true,
  companyId: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  checksum: true,
  status: true,
  languages: true,
  pageCount: true,
  confidence: true,
  extractionMethod: true,
  failureReason: true,
  attempts: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.ScannedDocumentSelect;

export type IngestedDocument = Prisma.ScannedDocumentGetPayload<{
  select: typeof INGEST_SUMMARY;
}>;
import { PrismaService } from '../../../prisma/prisma.service';
import { S3StorageService } from '../../../storage/s3-storage.service';
import { TesseractWorker } from './tesseract.worker';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfRasterizer } from './pdf-rasterizer';
import {
  CONFIDENCE_FLOOR,
  isConfidenceAcceptable,
  type TesseractLanguage,
} from './ocr-language';
import { IndexingService } from '../embedding/indexing.service';
import { detectMimeType } from '../../../storage/file-signature';
import type { UploadedFileLike } from '../../company/services/company-asset.service';

/**
 * Text extraction pipeline.
 *
 * Ingest returns immediately with a PENDING row; extraction happens on a poller.
 * OCR takes seconds to minutes per document — a WASM Tesseract pass over a
 * multi-page scan is not something to hold an HTTP connection open for, and a
 * client that times out mid-recognition would leave the work orphaned.
 */
@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
    private readonly tesseract: TesseractWorker,
    private readonly pdf: PdfTextExtractor,
    private readonly rasterizer: PdfRasterizer,
    private readonly indexing: IndexingService,
    private readonly config: ConfigService,
  ) {}

  private get maxAttempts(): number {
    return this.config.get<number>('OCR_MAX_ATTEMPTS', 3);
  }

  private get batchSize(): number {
    return this.config.get<number>('OCR_BATCH_SIZE', 3);
  }

  private get maxPdfPages(): number {
    // Pages are rasterised and recognised one at a time, sequentially — a
    // 500-page scan would tie up the OCR queue for a document that is very
    // likely an entire case file rather than a single contract. Failing with
    // an actionable message is better than a job that "processes" for an hour.
    return this.config.get<number>('OCR_MAX_PDF_PAGES', 40);
  }

  // ---------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------

  /**
   * Stores a document and queues it for extraction.
   *
   * The checksum is checked first. Re-uploading a file that has already been
   * processed is common — someone forwards the same scan twice — and recognising
   * it returns the existing result instead of paying for OCR and embeddings
   * again.
   */
  async ingest(
    file: UploadedFileLike,
    companyId: string,
    userId?: string,
  ): Promise<IngestedDocument> {
    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    // Projected: the whole point of this lookup is the id and status, and the
    // row it matches carries `extractedText` — the complete text of a document
    // that may run to hundreds of pages. Returning it unprojected sent all of
    // that back through the upload response for every duplicate upload.
    const existing = await this.prisma.client.scannedDocument.findFirst({
      where: { companyId, checksum, deletedAt: null },
      select: INGEST_SUMMARY,
    });
    if (existing) {
      this.logger.log(
        `Document ${file.originalname} already ingested as ${existing.id}; reusing`,
      );
      return existing;
    }

    // Trust the bytes, not the declared Content-Type — the same rule as company
    // asset uploads. A file claiming to be a PDF decides which extraction path
    // runs, and the path is chosen from the magic bytes instead.
    const detected = detectMimeType(file.buffer);
    const contentType = detected ?? file.mimetype;

    const key = this.storage.buildKey(companyId, 'scans', extensionFor(contentType));
    const stored = await this.storage.putObject(key, file.buffer, contentType);

    return this.prisma.client.scannedDocument.create({
      data: {
        companyId,
        uploadedById: userId,
        storageKey: stored.storageKey,
        originalName: file.originalname.slice(0, 255),
        contentType,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
        status: OcrStatus.PENDING,
        languages: [],
      },
      // Same projection as the duplicate path, so both branches return the same
      // shape. It also keeps `storageKey` out of the response — a client has no
      // use for the bucket key, and it is only ever served through a presigned
      // URL.
      select: INGEST_SUMMARY,
    });
  }

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------

  /**
   * Polls for pending documents.
   *
   * `draining` guards against overlap: recognition can take longer than the poll
   * interval, and a second pass starting while the first is still running would
   * multiply the concurrent WASM workers rather than the throughput.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'ocr:drain' })
  async drainQueue(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;

    try {
      const pending = await this.prisma.client.scannedDocument.findMany({
        where: {
          status: OcrStatus.PENDING,
          deletedAt: null,
          attempts: { lt: this.maxAttempts },
        },
        orderBy: { createdAt: 'asc' },
        take: this.batchSize,
        select: { id: true },
      });

      let processed = 0;
      for (const document of pending) {
        // Sequential rather than parallel: TesseractWorker already caps
        // concurrency and would reject the surplus, so fanning out here would
        // just convert documents into "at capacity" retries.
        if (await this.process(document.id)) processed++;
      }

      return processed;
    } finally {
      this.draining = false;
    }
  }

  /**
   * Extracts one document.
   *
   * The status claim is a conditional `updateMany` on PENDING, so two workers
   * racing for the same document produce one winner and one no-op rather than two
   * OCR passes and two sets of chunks.
   */
  async process(documentId: string): Promise<boolean> {
    const claimed = await this.prisma.client.scannedDocument.updateMany({
      where: { id: documentId, status: OcrStatus.PENDING },
      data: { status: OcrStatus.PROCESSING, attempts: { increment: 1 } },
    });

    if (claimed.count === 0) return false;

    // Only what extraction needs. The unprojected read also pulled
    // `extractedText`, which on a re-run is the entire previous extraction —
    // megabytes fetched purely to be overwritten moments later.
    const document = await this.prisma.client.scannedDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        storageKey: true,
        contentType: true,
        originalName: true,
      },
    });
    if (!document) return false;

    const startedAt = Date.now();

    try {
      const bytes = await this.storage.getObjectBytes(document.storageKey);
      const extraction = await this.extract(bytes, document.contentType);

      if (!extraction.text.trim()) {
        await this.fail(
          documentId,
          'No text could be extracted from the document',
        );
        return false;
      }

      const acceptable = isConfidenceAcceptable(extraction.confidence);

      await this.prisma.client.scannedDocument.update({
        where: { id: documentId },
        data: {
          // LOW_CONFIDENCE is not a failure: the text is stored and searchable,
          // flagged so a reviewer knows to treat it with suspicion.
          status: acceptable ? OcrStatus.COMPLETED : OcrStatus.LOW_CONFIDENCE,
          extractedText: extraction.text,
          extractionMethod: extraction.method,
          confidence: extraction.confidence,
          languages: extraction.languages,
          pageCount: extraction.pageCount,
          processingMs: Date.now() - startedAt,
          completedAt: new Date(),
          failureReason: acceptable
            ? null
            : `Mean OCR confidence ${extraction.confidence?.toFixed(1)} is below the ${CONFIDENCE_FLOOR} threshold`,
        },
      });

      // Indexing failure must not undo a successful extraction — the expensive
      // part is done, and the chunks can be rebuilt from `extractedText`.
      await this.indexing.indexDocument(documentId).catch((error) => {
        this.logger.error(
          `Indexing failed for document ${documentId}: ${
            (error as Error)?.message ?? 'unknown error'
          }`,
        );
      });

      this.logger.log(
        `Extracted ${extraction.text.length} chars from ${document.originalName} ` +
          `via ${extraction.method} in ${Date.now() - startedAt}ms`,
      );

      return true;
    } catch (error) {
      await this.fail(
        documentId,
        (error as Error)?.message ?? 'Extraction failed',
      );
      return false;
    }
  }

  /**
   * Chooses an extraction path.
   *
   * PDFs are tried as text first. When that yields a real text layer the OCR pass
   * is skipped entirely: the embedded text is exact, where recognition of the
   * same page is an estimate that is strictly worse.
   */
  private async extract(
    bytes: Buffer,
    contentType: string,
  ): Promise<{
    text: string;
    method: string;
    confidence: number | null;
    languages: string[];
    pageCount: number | null;
  }> {
    if (contentType === 'application/pdf') {
      const pdfResult = await this.pdf.extract(bytes);

      if (pdfResult.hasTextLayer) {
        return {
          text: pdfResult.text,
          method: 'pdf_text_layer',
          // Nothing was guessed, so there is no confidence to report. Null here
          // is meaningfully different from a high score.
          confidence: null,
          languages: [],
          pageCount: pdfResult.pageCount,
        };
      }

      // A scanned PDF: no text layer, so each page is rasterised to an image
      // and recognised individually.
      return this.extractScannedPdf(bytes, pdfResult.pageCount);
    }

    // Images go straight to Tesseract. The hint is empty — there is no text layer
    // to sample — so the full language set is loaded.
    const ocr = await this.tesseract.recognize(bytes, '');

    return {
      text: ocr.text,
      method: 'tesseract',
      confidence: ocr.confidence,
      languages: ocr.languages,
      pageCount: 1,
    };
  }

  /**
   * OCRs an image-only PDF, one rasterised page at a time.
   *
   * Sequential rather than `Promise.all`: `TesseractWorker` already caps
   * concurrent recognitions and rejects the surplus outright (it sheds load
   * rather than queuing it — see its own comment), so fanning out pages in
   * parallel would just turn most of them into "at capacity" failures instead
   * of the whole document processing correctly, just not instantly. This
   * matches how `drainQueue` already processes documents one at a time.
   */
  private async extractScannedPdf(
    bytes: Buffer,
    pageCount: number,
  ): Promise<{
    text: string;
    method: string;
    confidence: number | null;
    languages: string[];
    pageCount: number | null;
  }> {
    if (pageCount === 0) {
      throw new Error(
        'Could not determine the page count of this PDF; it may be corrupt or encrypted.',
      );
    }

    if (pageCount > this.maxPdfPages) {
      throw new Error(
        `PDF has ${pageCount} pages, more than the ${this.maxPdfPages}-page OCR limit. ` +
          'Split it into smaller files, or raise OCR_MAX_PDF_PAGES.',
      );
    }

    const pageTexts: string[] = [];
    const confidences: number[] = [];
    const languages = new Set<TesseractLanguage>();
    // Once a page's recognition establishes the script, later pages reuse its
    // text as their hint — most scanned contracts are consistent throughout,
    // and this avoids re-detecting the language from scratch on every page.
    let hint = '';

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const image = await this.rasterizer.rasterizePage(bytes, pageNumber);
      const recognised = await this.tesseract.recognize(image, hint);

      pageTexts.push(recognised.text);
      confidences.push(recognised.confidence);
      recognised.languages.forEach((language) => languages.add(language));
      if (!hint && recognised.text.trim()) hint = recognised.text;
    }

    return {
      // Same convention as the text-layer path: a blank line between pages,
      // which the chunker treats as a strong boundary.
      text: pageTexts.join('\n\n').trim(),
      method: 'tesseract_pdf',
      confidence: average(confidences),
      languages: [...languages],
      pageCount,
    };
  }

  private async fail(documentId: string, reason: string): Promise<void> {
    const document = await this.prisma.client.scannedDocument.findUnique({
      where: { id: documentId },
      select: { attempts: true },
    });

    const exhausted = (document?.attempts ?? 0) >= this.maxAttempts;

    await this.prisma.client.scannedDocument.update({
      where: { id: documentId },
      data: {
        // Returned to PENDING while retries remain; FAILED once exhausted, so
        // the poller stops picking it up forever.
        status: exhausted ? OcrStatus.FAILED : OcrStatus.PENDING,
        failureReason: reason.slice(0, 1000),
      },
    });

    this.logger.warn(
      `Extraction failed for ${documentId}${exhausted ? ' (final)' : ' (will retry)'}: ${reason}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findOne(documentId: string, companyId: string) {
    const document = await this.prisma.client.scannedDocument.findFirst({
      where: { id: documentId, companyId, deletedAt: null },
      select: {
        id: true,
        originalName: true,
        contentType: true,
        sizeBytes: true,
        status: true,
        languages: true,
        pageCount: true,
        confidence: true,
        extractionMethod: true,
        failureReason: true,
        processingMs: true,
        attempts: true,
        createdAt: true,
        completedAt: true,
        _count: { select: { chunks: true } },
      },
    });

    if (!document) throw new NotFoundException('Document not found');
    return document;
  }

  async list(companyId: string, status?: OcrStatus, take = 50) {
    return this.prisma.client.scannedDocument.findMany({
      where: { companyId, deletedAt: null, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 100),
      select: {
        id: true,
        originalName: true,
        status: true,
        confidence: true,
        extractionMethod: true,
        pageCount: true,
        languages: true,
        createdAt: true,
        completedAt: true,
        _count: { select: { chunks: true } },
      },
    });
  }

  /** Full extracted text, for review of a low-confidence result. */
  async getText(documentId: string, companyId: string) {
    const document = await this.prisma.client.scannedDocument.findFirst({
      where: { id: documentId, companyId, deletedAt: null },
      select: {
        id: true,
        originalName: true,
        status: true,
        confidence: true,
        extractedText: true,
        extractionMethod: true,
      },
    });

    if (!document) throw new NotFoundException('Document not found');
    return document;
  }

  /**
   * What personal and financial identifiers a scanned document is carrying.
   *
   * The review step before a document is exported or sent on. A scan of a
   * counterparty's charter routinely arrives holding a director's passport
   * number and a settlement account, and nothing until now made that visible —
   * the text was extracted, indexed, and forgotten about.
   *
   * Returns masked values only. The raw identifiers stay in `extractedText`,
   * which is already tenant-scoped; putting them in a second response would
   * put them in a second log.
   */
  async scanForPii(documentId: string, companyId: string) {
    const document = await this.prisma.client.scannedDocument.findFirst({
      where: { id: documentId, companyId, deletedAt: null },
      select: { id: true, originalName: true, extractedText: true },
    });

    if (!document) throw new NotFoundException('Document not found');

    const matches = findPii(document.extractedText ?? '');

    return {
      documentId: document.id,
      originalName: document.originalName,
      clean: matches.length === 0,
      summary: summarizePii(matches),
      // Distinct identifiers, each masked. Offsets are included so the UI can
      // highlight them against the text the reviewer is already looking at.
      findings: dedupeMasked(matches),
    };
  }

  /** Re-queues a failed document, resetting its retry budget. */
  async retry(documentId: string, companyId: string): Promise<void> {
    const { count } = await this.prisma.client.scannedDocument.updateMany({
      where: {
        id: documentId,
        companyId,
        deletedAt: null,
        status: { in: [OcrStatus.FAILED, OcrStatus.LOW_CONFIDENCE] },
      },
      data: { status: OcrStatus.PENDING, attempts: 0, failureReason: null },
    });

    if (count === 0) {
      throw new NotFoundException(
        'Document not found, or not in a state that can be retried',
      );
    }
  }
}

/** Mean confidence across a multi-page recognition. */
function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Extension for the storage key; the key never uses the uploaded filename. */
function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'application/pdf':
      return 'pdf';
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

/**
 * One entry per distinct identifier, masked, with every place it appears.
 *
 * Mentions are grouped rather than listed flat: a reviewer needs to know the
 * document holds three phone numbers, not that it holds eleven occurrences.
 * The offsets are kept so the UI can still highlight all of them.
 */
function dedupeMasked(matches: PiiMatch[]) {
  const byValue = new Map<
    string,
    { kind: string; masked: string; occurrences: { start: number; end: number }[] }
  >();

  for (const match of matches) {
    const key = `${match.kind}:${match.value.replace(/[^A-Za-zА-Яа-я0-9]/g, '').toLowerCase()}`;
    const existing = byValue.get(key);

    if (existing) {
      existing.occurrences.push({ start: match.start, end: match.end });
      continue;
    }

    byValue.set(key, {
      kind: match.kind,
      masked: maskValue(match.kind, match.value),
      occurrences: [{ start: match.start, end: match.end }],
    });
  }

  return [...byValue.values()];
}

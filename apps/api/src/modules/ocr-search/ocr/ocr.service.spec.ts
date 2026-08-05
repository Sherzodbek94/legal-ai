import { OcrStatus } from '@legaltech/database';
import { OcrService } from './ocr.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { S3StorageService } from '../../../storage/s3-storage.service';
import type { TesseractWorker } from './tesseract.worker';
import type { PdfTextExtractor } from './pdf-text-extractor';
import type { PdfRasterizer } from './pdf-rasterizer';
import type { IndexingService } from '../embedding/indexing.service';
import type { ConfigService } from '@nestjs/config';

/**
 * `extractScannedPdf` — OCR for image-only PDFs.
 *
 * Regression coverage for a real gap: `OcrService.extract` used to throw for
 * every scanned PDF ("requires rasterisation before OCR... this build does
 * not ship poppler") even though the Dockerfile has installed poppler-utils
 * for exactly this since before that comment was written. This exercises the
 * path that now actually rasterises pages via `PdfRasterizer` and recognises
 * them via `TesseractWorker`, page by page.
 */
describe('OcrService — scanned PDF extraction', () => {
  function makeService(configOverrides: Record<string, unknown> = {}) {
    const scannedDocument = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'doc_1',
        storageKey: 'companies/co_1/scans/contract.pdf',
        contentType: 'application/pdf',
        originalName: 'contract.pdf',
      }),
      update: jest.fn().mockResolvedValue({}),
    };

    const prisma = {
      client: { scannedDocument },
    } as unknown as PrismaService;

    const storage = {
      getObjectBytes: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')),
    } as unknown as S3StorageService;

    const pdfPages = configOverrides.pageCount as number | undefined;
    const pdf = {
      extract: jest.fn().mockResolvedValue({
        text: '',
        pageCount: pdfPages ?? 2,
        hasTextLayer: false,
      }),
    } as unknown as PdfTextExtractor;

    const rasterizer = {
      rasterizePage: jest.fn((_pdf: Buffer, page: number) =>
        Promise.resolve(Buffer.from(`page-${page}-image`)),
      ),
    } as unknown as PdfRasterizer;

    let call = 0;
    const tesseract = {
      recognize: jest.fn((_image: Buffer, hint: string) => {
        call++;
        return Promise.resolve({
          text: `Recognised page ${call}`,
          confidence: 90 - call, // 89, 88, ... — distinguishable per page
          languages: ['uzb'],
          durationMs: 10,
          // Exposed on the mock's return value only so the test can assert
          // what hint each call actually received.
          receivedHint: hint,
        });
      }),
    } as unknown as TesseractWorker;

    const indexing = {
      indexDocument: jest.fn().mockResolvedValue(undefined),
    } as unknown as IndexingService;

    const config = {
      get: jest.fn((key: string, fallback?: unknown) => configOverrides[key] ?? fallback),
    } as unknown as ConfigService;

    const service = new OcrService(
      prisma,
      storage,
      tesseract,
      pdf,
      rasterizer,
      indexing,
      config,
    );

    return { service, scannedDocument, rasterizer, tesseract, pdf };
  }

  it('rasterises and recognises every page, joined with a blank line', async () => {
    const { service, scannedDocument } = makeService();

    const ok = await service.process('doc_1');

    expect(ok).toBe(true);
    const [update] = scannedDocument.update.mock.calls.at(-1) as [
      { data: Record<string, unknown> },
    ];
    expect(update.data.status).toBe(OcrStatus.COMPLETED);
    expect(update.data.extractedText).toBe('Recognised page 1\n\nRecognised page 2');
    expect(update.data.extractionMethod).toBe('tesseract_pdf');
    expect(update.data.pageCount).toBe(2);
  });

  it('rasterises pages one at a time, not in parallel', async () => {
    const { service, rasterizer } = makeService();

    await service.process('doc_1');

    expect(rasterizer.rasterizePage).toHaveBeenCalledTimes(2);
    expect(rasterizer.rasterizePage).toHaveBeenNthCalledWith(1, expect.any(Buffer), 1);
    expect(rasterizer.rasterizePage).toHaveBeenNthCalledWith(2, expect.any(Buffer), 2);
  });

  it('passes the first page’s recognised text as the hint for the next page', async () => {
    const { service, tesseract } = makeService();

    await service.process('doc_1');

    const calls = (tesseract.recognize as jest.Mock).mock.calls;
    expect(calls[0][1]).toBe(''); // no hint yet on the first page
    expect(calls[1][1]).toBe('Recognised page 1'); // first page's own output
  });

  it('averages confidence across pages', async () => {
    const { service, scannedDocument } = makeService();

    await service.process('doc_1');

    const [update] = scannedDocument.update.mock.calls.at(-1) as [
      { data: Record<string, unknown> },
    ];
    expect(update.data.confidence).toBe(88.5); // (89 + 88) / 2, from the mock
  });

  it('refuses a PDF over the configured page limit rather than OCRing for hours', async () => {
    const { service, scannedDocument, rasterizer } = makeService({
      pageCount: 100,
      OCR_MAX_PDF_PAGES: 40,
    });

    const ok = await service.process('doc_1');

    expect(ok).toBe(false);
    expect(rasterizer.rasterizePage).not.toHaveBeenCalled();

    const [update] = scannedDocument.update.mock.calls.at(-1) as [
      { data: Record<string, unknown> },
    ];
    expect(update.data.failureReason).toMatch(/100 pages.*40-page/);
  });
});

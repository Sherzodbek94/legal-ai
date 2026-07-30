import { Injectable, Logger } from '@nestjs/common';

export interface PdfExtraction {
  text: string;
  pageCount: number;
  /**
   * True when the PDF carried a usable text layer.
   *
   * False means the pages are images and OCR is required — which for this corpus
   * is the common case, since most documents arrive as scans of paper.
   */
  hasTextLayer: boolean;
}

/**
 * Reads the text layer out of a PDF, when there is one.
 *
 * This runs before OCR and often replaces it. A large share of "scanned"
 * documents in circulation have already been through OCR by someone else — a
 * government portal, a previous system — and carry the result as a text layer.
 * Extracting that text is exact, instant, and free, where re-recognising the same
 * page is slow, costs money downstream in embeddings, and produces a worse
 * result than the text already sitting in the file.
 *
 * `pdfjs-dist` is imported lazily. It is several megabytes and pulls in its own
 * worker setup; loading it at module scope would slow every API boot including
 * the ones that never touch a PDF.
 */
@Injectable()
export class PdfTextExtractor {
  private readonly logger = new Logger(PdfTextExtractor.name);

  /**
   * Characters per page below which the text layer is treated as absent.
   *
   * Scanned PDFs frequently carry a *sliver* of text — a page number stamped by
   * the scanner, a header added by a portal — which is enough to look like a text
   * layer and nothing like the document's content. Requiring a plausible density
   * is what stops a 40-page contract being indexed as "Page 1 of 40".
   */
  private static readonly MIN_CHARS_PER_PAGE = 120;

  async extract(pdf: Buffer): Promise<PdfExtraction> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

      // The loading task is held rather than discarded: `destroy()` lives on the
      // task, not the document proxy, and without it the worker and its buffers
      // stay resident for the life of the process.
      const task = pdfjs.getDocument({
        data: new Uint8Array(pdf),
        // No network fetches for fonts or external resources: the input is
        // untrusted and the extractor must not reach out.
        disableFontFace: true,
      });

      const document = await task.promise;

      const pages: string[] = [];

      const pageCount = document.numPages;

      try {
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent();

          const pageText = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          pages.push(pageText);
          page.cleanup();
        }
      } finally {
        // Released even if a single page fails to parse; a leaked worker per
        // malformed upload would accumulate silently.
        await task.destroy();
      }

      // Page breaks are preserved as double newlines: the chunker treats them as
      // strong boundaries, and a page break usually is one.
      const text = pages.join('\n\n').trim();
      const density = text.length / Math.max(1, pageCount);

      return {
        text,
        pageCount,
        hasTextLayer: density >= PdfTextExtractor.MIN_CHARS_PER_PAGE,
      };
    } catch (error) {
      // A malformed or encrypted PDF is not an error worth failing the job on —
      // OCR may still succeed on the rasterised pages.
      this.logger.warn(
        `PDF text extraction failed: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
      return { text: '', pageCount: 0, hasTextLayer: false };
    }
  }
}

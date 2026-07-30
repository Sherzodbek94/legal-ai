import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import type { Page, PDFOptions } from 'puppeteer';
import { BrowserService } from './browser.service';
import { buildDocumentHtml, buildFooterHtml } from './html-document';
import type { DocumentRenderModel } from './render-model';

@Injectable()
export class PdfRenderer {
  private readonly logger = new Logger(PdfRenderer.name);

  constructor(
    private readonly browsers: BrowserService,
    private readonly config: ConfigService,
  ) {}

  private get timeoutMs(): number {
    return this.config.get<number>('PDF_RENDER_TIMEOUT_MS', 30_000);
  }

  private pdfOptions(model: DocumentRenderModel): PDFOptions {
    return {
      format: 'A4',
      // Margins live in the page's @page rule; Chromium needs them here too,
      // and the header/footer templates are laid out inside them.
      margin: {
        top: '22mm',
        bottom: '24mm',
        left: '24mm',
        right: '18mm',
      },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: buildFooterHtml(model),
      timeout: this.timeoutMs,
      // Deterministic output: no scaling heuristics, no preferring page CSS
      // size over the format we asked for.
      preferCSSPageSize: false,
      scale: 1,
    };
  }

  /**
   * Renders to a stream rather than a Buffer.
   *
   * A signed contract with exhibits runs to tens of megabytes; buffering it
   * means holding the whole document in memory per concurrent export, on top of
   * Chromium's own copy. Streaming hands bytes to the HTTP response as Chromium
   * produces them and keeps peak memory flat regardless of document size.
   *
   * The page must outlive this call — it is the source of the stream — so it is
   * closed when the stream ends, errors, or is destroyed by a client that
   * disconnected mid-download.
   */
  async renderToStream(model: DocumentRenderModel): Promise<Readable> {
    const page = await this.browsers.acquirePage();

    try {
      await this.loadContent(page, model);

      const webStream = await page.createPDFStream(this.pdfOptions(model));
      const stream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);

      this.closePageWhenDone(page, stream, model.documentId);

      return stream;
    } catch (error) {
      await this.browsers.releasePage(page);
      this.logger.error(
        `PDF render failed for document ${model.documentId}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
      throw error;
    }
  }

  /**
   * Buffered variant, for callers that need the bytes themselves — storing a
   * finalised PDF in S3, or hashing it for the audit trail.
   */
  async renderToBuffer(model: DocumentRenderModel): Promise<Buffer> {
    const page = await this.browsers.acquirePage();

    try {
      await this.loadContent(page, model);
      const bytes = await page.pdf(this.pdfOptions(model));
      return Buffer.from(bytes);
    } finally {
      await this.browsers.releasePage(page);
    }
  }

  private async loadContent(page: Page, model: DocumentRenderModel) {
    const html = buildDocumentHtml(model);

    // `domcontentloaded`, not `networkidle0`: every asset is a data URI, so
    // there is no network to go idle and waiting for it only burns the timeout.
    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: this.timeoutMs,
    });

    // `screen` would apply the on-screen stylesheet; the document CSS is
    // written for print, including the fixed watermark overlay.
    await page.emulateMediaType('print');
  }

  private closePageWhenDone(page: Page, stream: Readable, documentId: string) {
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      void this.browsers.releasePage(page);
    };

    stream.once('end', release);
    stream.once('close', release);
    stream.once('error', (error: Error) => {
      this.logger.warn(
        `PDF stream for document ${documentId} failed: ${error?.message ?? 'unknown error'}`,
      );
      release();
    });
  }
}

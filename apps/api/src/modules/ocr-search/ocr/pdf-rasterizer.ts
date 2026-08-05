import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Rasterises PDF pages to PNG via poppler's `pdftoppm`.
 *
 * Shelled out rather than done in a library: Tesseract.js recognises images,
 * not PDFs, and there is no pure-JS PDF rasteriser in this dependency tree
 * that would not also mean carrying a second PDF parser alongside
 * `pdfjs-dist`. `pdftoppm` is exactly the tool the API image already installs
 * poppler-utils for — see the Dockerfile's system dependencies section.
 *
 * Each call round-trips through a temp directory. `pdftoppm` takes a file
 * path, not a stream, and writing one page at a time (`-f`/`-l` bound to the
 * same page) keeps peak disk and memory use flat regardless of document size,
 * where rasterising an entire multi-hundred-page scan up front would not.
 */
@Injectable()
export class PdfRasterizer {
  private readonly logger = new Logger(PdfRasterizer.name);

  constructor(private readonly config: ConfigService) {}

  private get dpi(): number {
    // 200 balances Tesseract's accuracy sweet spot (roughly 200–300 DPI)
    // against memory: a 300 DPI A4 page is already tens of megabytes
    // uncompressed, multiplied by however many pages a document has.
    return this.config.get<number>('OCR_PDF_RASTER_DPI', 200);
  }

  async rasterizePage(pdf: Buffer, pageNumber: number): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'legaltech-ocr-'));
    const pdfPath = join(dir, 'input.pdf');
    const outputPrefix = join(dir, 'page');

    try {
      await writeFile(pdfPath, pdf);

      await execFileAsync(
        'pdftoppm',
        [
          '-png',
          '-r',
          String(this.dpi),
          '-f',
          String(pageNumber),
          '-l',
          String(pageNumber),
          // Suppresses the page-number suffix pdftoppm otherwise appends —
          // with `-f`/`-l` pinned to one page there is only ever one output
          // file, and this makes its name predictable without listing the
          // directory.
          '-singlefile',
          pdfPath,
          outputPrefix,
        ],
        // A hung rasterisation must not hold the OCR queue open indefinitely;
        // this is generous for a single page at 200 DPI.
        { timeout: 30_000 },
      );

      return await readFile(`${outputPrefix}.png`);
    } catch (error) {
      throw new Error(
        `pdftoppm failed to rasterise page ${pageNumber}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
    } finally {
      // Best-effort: a leaked temp directory is a disk-space problem, not a
      // correctness one, and must not fail the OCR pass on top of whatever
      // already happened above.
      await rm(dir, { recursive: true, force: true }).catch((error) => {
        this.logger.warn(
          `Could not remove OCR temp directory ${dir}: ${
            (error as Error)?.message ?? 'unknown error'
          }`,
        );
      });
    }
  }
}

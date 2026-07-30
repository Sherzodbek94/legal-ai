import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWorker, type Worker } from 'tesseract.js';
import {
  analyzeScript,
  languagesForScript,
  normalizeUzbekApostrophes,
  toTesseractParam,
  type TesseractLanguage,
} from './ocr-language';

export interface OcrResult {
  text: string;
  /** Mean confidence across recognised words, 0–100. */
  confidence: number;
  languages: TesseractLanguage[];
  durationMs: number;
}

/**
 * Tesseract recognition.
 *
 * Uses `tesseract.js` (WASM) rather than shelling out to a system binary. The
 * native binary is faster and lighter, but it has to be installed with the right
 * language packs on every machine that runs the API — which in a monorepo people
 * develop on across three operating systems means it works for some of the team
 * and not others. The WASM build is slower and uses more memory; both are
 * acceptable because recognition never happens on a request path.
 *
 * Workers are pooled per language combination. Initialising one downloads and
 * loads traineddata (tens of megabytes for four languages) and takes seconds, so
 * doing it per document would dominate the cost of OCR entirely.
 */
@Injectable()
export class TesseractWorker implements OnModuleDestroy {
  private readonly logger = new Logger(TesseractWorker.name);

  /** Keyed by the `+`-joined language parameter. */
  private readonly workers = new Map<string, Promise<Worker>>();
  /** In-flight recognitions, to bound concurrent WASM memory. */
  private active = 0;

  constructor(private readonly config: ConfigService) {}

  private get maxConcurrent(): number {
    return this.config.get<number>('OCR_MAX_CONCURRENT', 2);
  }

  /**
   * Recognises text in an image.
   *
   * @param hintText text already known about the document — a PDF text layer,
   *   a filename, a previous page — used to pick the language set. Recognition
   *   with the wrong Uzbek script returns confident nonsense rather than failing,
   *   so this hint materially changes the output quality.
   */
  async recognize(image: Buffer, hintText = ''): Promise<OcrResult> {
    if (this.active >= this.maxConcurrent) {
      // Shed rather than queue. Each WASM worker holds hundreds of megabytes and
      // an unbounded queue turns a burst of uploads into an OOM kill.
      throw new Error('OCR is at capacity; retry shortly');
    }

    const languages = languagesForScript(analyzeScript(hintText));
    const param = toTesseractParam(languages);

    const startedAt = Date.now();
    this.active++;

    try {
      const worker = await this.getWorker(param);
      const { data } = await worker.recognize(image);

      return {
        // Normalised here so the apostrophe form in the index matches the form
        // queries are normalised to.
        text: normalizeUzbekApostrophes(data.text ?? '').trim(),
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        languages,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      this.active--;
    }
  }

  /**
   * Gets or creates a worker for a language set.
   *
   * The promise is cached, not the resolved worker, so concurrent callers during
   * initialisation share one load instead of each starting their own.
   */
  private getWorker(param: string): Promise<Worker> {
    const existing = this.workers.get(param);
    if (existing) return existing;

    this.logger.log(`Initialising Tesseract worker for languages: ${param}`);

    const created = createWorker(param, undefined, {
      // Routed through the Nest logger rather than stdout; tesseract.js is
      // extremely chatty during traineddata download.
      logger: (message) => {
        if (message.status === 'recognizing text') return;
        this.logger.debug(`tesseract[${param}]: ${message.status}`);
      },
      errorHandler: (error) => {
        this.logger.error(`tesseract[${param}] error: ${String(error)}`);
      },
      cachePath: this.config.get<string>('OCR_CACHE_PATH') || undefined,
    }).catch((error) => {
      // A failed initialisation must not poison the cache — otherwise every
      // later request awaits the same rejected promise forever.
      this.workers.delete(param);
      throw error;
    });

    this.workers.set(param, created);
    return created;
  }

  async onModuleDestroy(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();

    await Promise.all(
      workers.map(async (pending) => {
        try {
          const worker = await pending;
          await worker.terminate();
        } catch (error) {
          this.logger.warn(
            `Failed to terminate Tesseract worker: ${
              (error as Error)?.message ?? 'unknown error'
            }`,
          );
        }
      }),
    );
  }
}

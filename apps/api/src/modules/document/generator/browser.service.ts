import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { type Browser, type Page } from 'puppeteer';

/**
 * Owns the headless Chromium instance.
 *
 * One browser per process, many pages. Launching Chromium costs a few hundred
 * milliseconds and ~50MB; doing it per request turns a PDF export into the
 * slowest endpoint in the API and lets a burst of exports exhaust memory.
 *
 * Pages are still created and destroyed per render — a page is where untrusted
 * document content is loaded, so it never outlives the request that needed it.
 */
@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);

  private browser?: Browser;
  /** Serialises concurrent launches so a burst of first requests opens one browser. */
  private launching?: Promise<Browser>;
  private activePages = 0;

  constructor(private readonly config: ConfigService) {}

  private get maxConcurrentPages(): number {
    return this.config.get<number>('PDF_MAX_CONCURRENT_PAGES', 4);
  }

  private get launchArgs(): string[] {
    const args = [
      // The renderer never navigates to a remote origin, and /dev/shm is small
      // in most container images — Chromium crashes without this there.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // No extensions, no background networking: nothing should reach out.
      '--disable-extensions',
      '--disable-background-networking',
    ];

    // Opt-in only. Disabling the sandbox is what most container guides
    // recommend and it is exactly what you do not want when the page content
    // is attacker-influenced; run as a non-root user with SYS_ADMIN instead
    // where you can.
    if (this.config.get<string>('PUPPETEER_NO_SANDBOX') === 'true') {
      this.logger.warn(
        'Chromium sandbox disabled via PUPPETEER_NO_SANDBOX; untrusted document content will render unsandboxed',
      );
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    return args;
  }

  async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.launching) return this.launching;

    this.launching = puppeteer
      .launch({
        headless: true,
        args: this.launchArgs,
        executablePath:
          this.config.get<string>('PUPPETEER_EXECUTABLE_PATH') || undefined,
        timeout: this.config.get<number>('PDF_LAUNCH_TIMEOUT_MS', 30_000),
      })
      .then((browser) => {
        this.browser = browser;
        // A crashed browser must not leave a dead handle cached, or every
        // subsequent export fails until the process restarts.
        browser.once('disconnected', () => {
          this.logger.warn('Chromium disconnected; it will be relaunched on demand');
          this.browser = undefined;
        });
        this.logger.log('Chromium launched for document rendering');
        return browser;
      })
      .finally(() => {
        this.launching = undefined;
      });

    return this.launching;
  }

  /**
   * Opens a page hardened for rendering untrusted content.
   *
   * JavaScript is off and every network request is blocked. The document HTML
   * is fully self-contained, so neither is needed — and both are how a
   * malicious clause would reach outside the renderer.
   */
  async acquirePage(): Promise<Page> {
    if (this.activePages >= this.maxConcurrentPages) {
      // Shedding load is better than queueing it: Chromium under memory
      // pressure takes the whole process down, not just this request.
      throw new ServiceUnavailableException(
        'Document rendering is at capacity; please retry shortly',
      );
    }

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    this.activePages++;

    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        // `setContent` delivers the document itself as the top-level document
        // request; everything else is an attempt to reach the network.
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          void request.continue();
          return;
        }
        void request.abort();
      });
      return page;
    } catch (error) {
      await this.releasePage(page);
      throw error;
    }
  }

  async releasePage(page: Page): Promise<void> {
    this.activePages = Math.max(0, this.activePages - 1);
    try {
      if (!page.isClosed()) await page.close();
    } catch (error) {
      this.logger.warn(
        `Failed to close render page: ${(error as Error)?.message ?? 'unknown error'}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch (error) {
      this.logger.warn(
        `Failed to close Chromium on shutdown: ${(error as Error)?.message ?? 'unknown error'}`,
      );
    } finally {
      this.browser = undefined;
    }
  }
}

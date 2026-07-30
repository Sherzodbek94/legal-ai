/**
 * Exercises the renderer against a stubbed browser.
 *
 * Driving real Chromium here would test Chromium, not this code, at ~2s per
 * case. What is actually worth asserting is the wiring the renderer owns:
 * that the page is hardened before untrusted HTML reaches it, that streaming
 * options are what Chromium needs to paginate correctly, and — the part that
 * leaks a browser process when wrong — that the page is released on every exit
 * path, including a client that disconnects mid-download.
 */
import { Readable } from 'node:stream';
import type { Page } from 'puppeteer';
import { PdfRenderer } from './pdf.renderer';
import type { BrowserService } from './browser.service';
import { buildWatermark, type DocumentRenderModel } from './render-model';

// puppeteer ships as ESM ("type": "module"). Node resolves it fine under
// `require`, but jest-runtime cannot, and importing PdfRenderer pulls in
// BrowserService which imports it. Nothing here launches a browser, so the
// module is replaced outright rather than transformed.
jest.mock('puppeteer', () => ({
  __esModule: true,
  default: { launch: jest.fn() },
}));

interface FakePage {
  setContent: jest.Mock;
  emulateMediaType: jest.Mock;
  createPDFStream: jest.Mock;
  pdf: jest.Mock;
  isClosed: jest.Mock;
  close: jest.Mock;
}

function webStreamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function makePage(overrides: Partial<FakePage> = {}): FakePage {
  return {
    setContent: jest.fn().mockResolvedValue(undefined),
    emulateMediaType: jest.fn().mockResolvedValue(undefined),
    createPDFStream: jest.fn().mockResolvedValue(webStreamOf(['%PDF-1.7', 'body'])),
    pdf: jest.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    isClosed: jest.fn().mockReturnValue(false),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRenderer(page: FakePage) {
  const releasePage = jest.fn().mockResolvedValue(undefined);
  const browsers = {
    acquirePage: jest.fn().mockResolvedValue(page as unknown as Page),
    releasePage,
  } as unknown as BrowserService;

  const config = {
    get: <T>(_key: string, fallback: T) => fallback,
  } as never;

  return { renderer: new PdfRenderer(browsers, config), browsers, releasePage };
}

const model = (
  overrides: Partial<DocumentRenderModel> = {},
): DocumentRenderModel => ({
  documentId: 'doc_1',
  title: 'Supply Agreement',
  companyName: 'Acme Legal LLC',
  content: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Clause one.' }] },
    ],
  },
  generatedAt: new Date('2026-07-29T10:00:00Z'),
  referenceNumber: 'A1B2C3D4',
  signatures: [],
  ...overrides,
});

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('PdfRenderer', () => {
  describe('page setup', () => {
    it('loads the built document HTML into the page', async () => {
      const page = makePage();
      const { renderer } = makeRenderer(page);

      await drain(await renderer.renderToStream(model()));

      const [html] = page.setContent.mock.calls[0];
      expect(html).toContain('<h1>Supply Agreement</h1>');
      expect(html).toContain('Clause one.');
    });

    it('does not wait for network idle, since every asset is inlined', async () => {
      const page = makePage();
      const { renderer } = makeRenderer(page);

      await drain(await renderer.renderToStream(model()));

      const [, options] = page.setContent.mock.calls[0];
      expect(options.waitUntil).toBe('domcontentloaded');
    });

    it('emulates print media so the watermark overlay applies', async () => {
      const page = makePage();
      const { renderer } = makeRenderer(page);

      await drain(await renderer.renderToStream(model()));

      expect(page.emulateMediaType).toHaveBeenCalledWith('print');
    });

    it('passes the watermark through to the rendered HTML', async () => {
      const page = makePage();
      const { renderer } = makeRenderer(page);

      await drain(
        await renderer.renderToStream(
          model({ watermark: buildWatermark('DRAFT — NOT APPROVED') }),
        ),
      );

      expect(page.setContent.mock.calls[0][0]).toContain('class="watermark"');
    });
  });

  describe('pdf options', () => {
    it('prints A4 with backgrounds, which the watermark depends on', async () => {
      const page = makePage();
      const { renderer } = makeRenderer(page);

      await drain(await renderer.renderToStream(model()));

      const [options] = page.createPDFStream.mock.calls[0];
      expect(options.format).toBe('A4');
      // Without printBackground the watermark layer is simply not drawn.
      expect(options.printBackground).toBe(true);
    });

    it('renders a footer carrying page numbers', async () => {
      const page = makePage();
      const { renderer } = makeRenderer(page);

      await drain(await renderer.renderToStream(model()));

      const [options] = page.createPDFStream.mock.calls[0];
      expect(options.displayHeaderFooter).toBe(true);
      expect(options.footerTemplate).toContain('class="pageNumber"');
      expect(options.footerTemplate).toContain('A1B2C3D4');
    });

    it('keeps output deterministic by fixing scale and ignoring CSS page size', async () => {
      const page = makePage();
      const { renderer } = makeRenderer(page);

      await drain(await renderer.renderToStream(model()));

      const [options] = page.createPDFStream.mock.calls[0];
      expect(options.scale).toBe(1);
      expect(options.preferCSSPageSize).toBe(false);
    });
  });

  describe('streaming', () => {
    it('returns a Node stream carrying the PDF bytes', async () => {
      const page = makePage();
      const { renderer } = makeRenderer(page);

      const stream = await renderer.renderToStream(model());
      expect(stream).toBeInstanceOf(Readable);
      expect(await drain(stream)).toBe('%PDF-1.7body');
    });

    it('keeps the page open until the stream is consumed', async () => {
      const page = makePage();
      const { renderer, releasePage } = makeRenderer(page);

      const stream = await renderer.renderToStream(model());
      // The page is the source of the stream; closing it early truncates the
      // download.
      expect(releasePage).not.toHaveBeenCalled();

      await drain(stream);
      expect(releasePage).toHaveBeenCalledTimes(1);
    });

    it('releases the page when a client disconnects mid-download', async () => {
      const page = makePage();
      const { renderer, releasePage } = makeRenderer(page);

      const stream = await renderer.renderToStream(model());
      stream.destroy();

      await new Promise((resolve) => stream.once('close', resolve));
      expect(releasePage).toHaveBeenCalledTimes(1);
    });

    it('releases the page exactly once, however many events fire', async () => {
      const page = makePage();
      const { renderer, releasePage } = makeRenderer(page);

      const stream = await renderer.renderToStream(model());
      await drain(stream);
      stream.destroy();

      await new Promise((resolve) => setImmediate(resolve));
      expect(releasePage).toHaveBeenCalledTimes(1);
    });
  });

  describe('failures', () => {
    it('releases the page when loading the content throws', async () => {
      const page = makePage({
        setContent: jest.fn().mockRejectedValue(new Error('navigation timeout')),
      });
      const { renderer, releasePage } = makeRenderer(page);

      await expect(renderer.renderToStream(model())).rejects.toThrow(
        'navigation timeout',
      );
      expect(releasePage).toHaveBeenCalledTimes(1);
    });

    it('releases the page when Chromium refuses to produce a stream', async () => {
      const page = makePage({
        createPDFStream: jest.fn().mockRejectedValue(new Error('target closed')),
      });
      const { renderer, releasePage } = makeRenderer(page);

      await expect(renderer.renderToStream(model())).rejects.toThrow(
        'target closed',
      );
      expect(releasePage).toHaveBeenCalledTimes(1);
    });

    it('propagates capacity rejection without opening a page', async () => {
      const browsers = {
        acquirePage: jest.fn().mockRejectedValue(new Error('at capacity')),
        releasePage: jest.fn(),
      } as unknown as BrowserService;

      const renderer = new PdfRenderer(browsers, {
        get: <T>(_key: string, fallback: T) => fallback,
      } as never);

      await expect(renderer.renderToStream(model())).rejects.toThrow(
        'at capacity',
      );
      expect(browsers.releasePage).not.toHaveBeenCalled();
    });
  });

  describe('buffered rendering', () => {
    it('returns the bytes and always releases the page', async () => {
      const page = makePage();
      const { renderer, releasePage } = makeRenderer(page);

      const buffer = await renderer.renderToBuffer(model());

      expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
      expect(releasePage).toHaveBeenCalledTimes(1);
    });

    it('releases the page when rendering throws', async () => {
      const page = makePage({
        pdf: jest.fn().mockRejectedValue(new Error('render failed')),
      });
      const { renderer, releasePage } = makeRenderer(page);

      await expect(renderer.renderToBuffer(model())).rejects.toThrow(
        'render failed',
      );
      expect(releasePage).toHaveBeenCalledTimes(1);
    });
  });
});

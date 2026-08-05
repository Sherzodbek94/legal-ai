/**
 * Stands in for `puppeteer` throughout the e2e suite.
 *
 * `createTestApp` boots the real `AppModule`, which reaches puppeteer through
 * DocumentModule -> DocumentExportService -> PdfRenderer -> BrowserService.
 * puppeteer ships as ESM (`"type": "module"`), and Jest does not transform
 * `node_modules`, so merely importing it fails the whole suite before a single
 * test runs:
 *
 *     SyntaxError: Unexpected token 'export'
 *
 * Mapped rather than transformed. Transforming puppeteer would work but is slow
 * and pointless here: this suite exists to exercise migrations, cross-tenant
 * isolation, and auth against a real database — none of which should launch a
 * headless Chromium. PDF rendering has its own unit spec
 * (`pdf.renderer.spec.ts`, which mocks puppeteer the same way per-file).
 *
 * `launch` rejects rather than returning a fake browser. A test that
 * unknowingly depends on real rendering should fail loudly and say why, not
 * silently receive an empty document.
 */
const STUB_MESSAGE =
  'puppeteer is stubbed in the e2e suite (see test/puppeteer-stub.ts). ' +
  'PDF rendering is covered by pdf.renderer.spec.ts.';

export function launch(): Promise<never> {
  return Promise.reject(new Error(STUB_MESSAGE));
}

export default { launch };

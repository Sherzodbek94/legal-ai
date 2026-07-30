import { buildDocumentHtml, buildFooterHtml } from './html-document';
import { buildWatermark, type DocumentRenderModel } from './render-model';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  signatures: [],
  ...overrides,
});

describe('buildDocumentHtml', () => {
  describe('page structure', () => {
    it('emits a self-contained document with no external references', () => {
      const html = buildDocumentHtml(model());

      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      // Anything fetched over the network would render differently depending on
      // whether the fetch succeeded.
      expect(html).not.toMatch(/<link[^>]+href="http/);
      expect(html).not.toMatch(/<script/);
    });

    it('prints the company, title, and date in the header', () => {
      const html = buildDocumentHtml(model());
      expect(html).toContain('Acme Legal LLC');
      expect(html).toContain('<h1>Supply Agreement</h1>');
      expect(html).toContain('2026-07-29');
    });

    it('renders the body through the TipTap converter', () => {
      expect(buildDocumentHtml(model())).toContain('<p>Clause one.</p>');
    });

    it('escapes a title carrying markup', () => {
      const html = buildDocumentHtml(
        model({ title: 'Deal <script>alert(1)</script>' }),
      );
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('sets A4 with legal-filing margins', () => {
      const html = buildDocumentHtml(model());
      expect(html).toContain('size: A4');
      expect(html).toContain('margin: 22mm 18mm 24mm 24mm');
    });
  });

  describe('watermark overlay', () => {
    it('omits the overlay entirely when no watermark is asked for', () => {
      const html = buildDocumentHtml(model());
      expect(html).not.toContain('class="watermark"');
      expect(html).not.toContain('.watermark {');
    });

    it('adds a fixed overlay so the mark repeats on every printed page', () => {
      const html = buildDocumentHtml(
        model({ watermark: buildWatermark('DRAFT') }),
      );
      expect(html).toContain('<div class="watermark"></div>');
      expect(html).toContain('position: fixed');
      expect(html).toContain('pointer-events: none');
    });

    it('bakes the rotation into an inline SVG rather than a CSS transform', () => {
      const html = buildDocumentHtml(
        model({ watermark: buildWatermark('DRAFT', { angle: -45 }) }),
      );

      const match = html.match(/base64,([A-Za-z0-9+/=]+)"\)/);
      expect(match).not.toBeNull();

      const svg = Buffer.from(match![1], 'base64').toString('utf8');
      expect(svg).toContain('rotate(-45');
      expect(svg).toContain('>DRAFT<');
    });

    it('honours the requested opacity', () => {
      const html = buildDocumentHtml(
        model({ watermark: buildWatermark('DRAFT', { opacity: 0.3 }) }),
      );
      const svg = Buffer.from(
        html.match(/base64,([A-Za-z0-9+/=]+)"\)/)![1],
        'base64',
      ).toString('utf8');
      expect(svg).toContain('fill-opacity="0.3"');
    });

    it('clamps an out-of-range opacity instead of emitting it', () => {
      const html = buildDocumentHtml(
        model({ watermark: buildWatermark('DRAFT', { opacity: 5 }) }),
      );
      const svg = Buffer.from(
        html.match(/base64,([A-Za-z0-9+/=]+)"\)/)![1],
        'base64',
      ).toString('utf8');
      expect(svg).toContain('fill-opacity="1"');
    });

    it('escapes watermark text before it reaches the SVG', () => {
      const html = buildDocumentHtml(
        model({ watermark: buildWatermark('</text><script>x</script>') }),
      );
      const svg = Buffer.from(
        html.match(/base64,([A-Za-z0-9+/=]+)"\)/)![1],
        'base64',
      ).toString('utf8');
      expect(svg).not.toContain('<script>');
      expect(svg).toContain('&lt;/text&gt;');
    });

    it('tiles the mark when repeat is set, and centres it otherwise', () => {
      expect(
        buildDocumentHtml(model({ watermark: buildWatermark('D', { repeat: true }) })),
      ).toContain('background-repeat: repeat');
      expect(
        buildDocumentHtml(model({ watermark: buildWatermark('D', { repeat: false }) })),
      ).toContain('background-repeat: no-repeat');
    });
  });

  describe('signature blocks', () => {
    it('omits the section when there are no blocks', () => {
      expect(buildDocumentHtml(model())).not.toContain('class="signatures"');
    });

    it('renders a signing line and role for each party', () => {
      const html = buildDocumentHtml(
        model({
          signatures: [
            {
              role: 'For the company',
              partyName: 'Acme Legal LLC',
              signatoryName: 'Aziz Karimov',
              signatoryPosition: 'General Director',
            },
          ],
        }),
      );

      expect(html).toContain('For the company');
      expect(html).toContain('Acme Legal LLC');
      expect(html).toContain('General Director');
      expect(html).toContain('class="signature-area"');
    });

    it('leaves a blank date for hand-dating when unsigned', () => {
      const html = buildDocumentHtml(
        model({ signatures: [{ role: 'Counterparty', partyName: 'Beta LLC' }] }),
      );
      expect(html).toContain('20&#95;&#95;');
    });

    it('prints the date when the block is already signed', () => {
      const html = buildDocumentHtml(
        model({
          signatures: [
            {
              role: 'Counterparty',
              partyName: 'Beta LLC',
              signedAt: new Date('2026-07-29T00:00:00Z'),
            },
          ],
        }),
      );
      expect(html).toContain('2026-07-29');
    });

    it('shows an M.P. marker when a seal is required but not supplied', () => {
      const html = buildDocumentHtml(
        model({
          signatures: [
            { role: 'For the company', partyName: 'Acme', requiresSeal: true },
          ],
        }),
      );
      // Matched as an element, not a substring: the class name also appears in
      // the stylesheet, which would make a bare `toContain` always pass.
      expect(html).toContain('<div class="seal-marker">M.P.</div>');
    });

    it('embeds a supplied signature and seal as data URIs', () => {
      const html = buildDocumentHtml(
        model({
          signatures: [
            {
              role: 'For the company',
              partyName: 'Acme',
              signatureImage: PNG,
              sealImage: PNG,
            },
          ],
        }),
      );
      const expected = `data:image/png;base64,${PNG.toString('base64')}`;
      expect(html).toContain(`class="signature" src="${expected}"`);
      expect(html).toContain(`class="seal" src="${expected}"`);
      expect(html).not.toContain('<div class="seal-marker">');
    });

    it('keeps blocks from splitting across a page break', () => {
      const html = buildDocumentHtml(
        model({ signatures: [{ role: 'A', partyName: 'B' }] }),
      );
      expect(html).toContain('page-break-inside: avoid');
    });

    it('escapes a party name carrying markup', () => {
      const html = buildDocumentHtml(
        model({
          signatures: [{ role: 'X', partyName: '<img src=x onerror=alert(1)>' }],
        }),
      );
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img');
    });
  });

  describe('verification mark', () => {
    it('omits the block when the document carries no verification', () => {
      expect(buildDocumentHtml(model())).not.toContain('class="verification"');
    });

    it('embeds the QR image and the token text', () => {
      const html = buildDocumentHtml(
        model({
          verification: {
            url: 'https://legal.test/verify/abc.def',
            token: 'abc.def',
            qrPng: PNG,
          },
        }),
      );

      expect(html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`);
      // The token is printed as text too, so a code that will not scan can
      // still be checked by hand.
      expect(html).toContain('abc.def');
      expect(html).toContain('Verify this document');
    });
  });
});

describe('buildFooterHtml', () => {
  it('uses Chromium page-number placeholders', () => {
    const footer = buildFooterHtml(model());
    expect(footer).toContain('class="pageNumber"');
    expect(footer).toContain('class="totalPages"');
  });

  it('includes the reference number when the document has one', () => {
    expect(buildFooterHtml(model({ referenceNumber: 'A1B2C3D4' }))).toContain(
      'A1B2C3D4',
    );
  });

  it('escapes the title', () => {
    expect(buildFooterHtml(model({ title: '<b>x</b>' }))).toContain('&lt;b&gt;');
  });
});

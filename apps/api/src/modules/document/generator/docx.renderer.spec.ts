/**
 * Renders real .docx files and inspects the Word XML inside them.
 *
 * Asserting on the packed output rather than on the object tree is deliberate:
 * a DOCX that Word cannot open is the failure that matters, and only packing it
 * exercises the numbering definitions, image parts, and relationships that the
 * object tree leaves implicit.
 */
import JSZip from 'jszip';
import { DocxRenderer } from './docx.renderer';
import { buildWatermark, type DocumentRenderModel } from './render-model';

/** Smallest valid PNG — a 1x1 transparent pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const renderer = new DocxRenderer();

const model = (
  overrides: Partial<DocumentRenderModel> = {},
): DocumentRenderModel => ({
  documentId: 'doc_1',
  title: 'Supply Agreement',
  companyName: 'Acme Legal LLC',
  content: {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Subject of the Agreement' }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'The Supplier shall deliver the Goods.' }],
      },
    ],
  },
  generatedAt: new Date('2026-07-29T10:00:00Z'),
  referenceNumber: 'A1B2C3D4',
  signatures: [],
  ...overrides,
});

async function unpack(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (path: string) => {
    const file = zip.file(path);
    return file ? file.async('string') : null;
  };

  return {
    zip,
    document: (await read('word/document.xml')) ?? '',
    numbering: await read('word/numbering.xml'),
    header: await read('word/header1.xml'),
    footer: await read('word/footer1.xml'),
    paths: Object.keys(zip.files),
  };
}

describe('DocxRenderer', () => {
  describe('package validity', () => {
    it('produces a zip Word can open', async () => {
      const buffer = await renderer.toBuffer(model());

      // Local file header magic. A .docx is an OPC zip; without this Word
      // reports the file as corrupt before reading a single part.
      expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
      expect(buffer.length).toBeGreaterThan(1000);
    });

    it('contains the parts an OPC package requires', async () => {
      const { paths } = await unpack(await renderer.toBuffer(model()));

      expect(paths).toContain('[Content_Types].xml');
      expect(paths).toContain('word/document.xml');
      expect(paths).toContain('word/_rels/document.xml.rels');
    });

    it('streams the same package it buffers', async () => {
      const stream = await renderer.toStream(model());

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const streamed = Buffer.concat(chunks);

      expect(streamed.subarray(0, 2).toString('latin1')).toBe('PK');

      const { document } = await unpack(streamed);
      expect(document).toContain('Supply Agreement');
    });
  });

  describe('document body', () => {
    it('writes the body text into the Word document part', async () => {
      const { document } = await unpack(await renderer.toBuffer(model()));
      expect(document).toContain('The Supplier shall deliver the Goods.');
    });

    it('maps headings to Word heading styles rather than bold text', async () => {
      const { document } = await unpack(await renderer.toBuffer(model()));
      // A real heading style is what makes Word's navigation pane and
      // table-of-contents fields work on the output.
      expect(document).toContain('Heading1');
      expect(document).toContain('Subject of the Agreement');
    });

    it('prints the company and reference in the document header block', async () => {
      const { document } = await unpack(await renderer.toBuffer(model()));
      expect(document).toContain('ACME LEGAL LLC');
      expect(document).toContain('A1B2C3D4');
    });

    it('registers numbering so ordered lists actually number', async () => {
      const { numbering, document } = await unpack(
        await renderer.toBuffer(
          model({
            content: {
              type: 'doc',
              content: [
                {
                  type: 'orderedList',
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          content: [{ type: 'text', text: 'First obligation' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        ),
      );

      expect(numbering).not.toBeNull();
      expect(document).toContain('First obligation');
      // Without a numId reference on the paragraph, Word renders a plain
      // paragraph with no number at all.
      expect(document).toContain('numId');
    });

    it('renders bullet lists as Word lists', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({
            content: {
              type: 'doc',
              content: [
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          content: [{ type: 'text', text: 'A bulleted term' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        ),
      );
      expect(document).toContain('A bulleted term');
    });

    it('renders tables as real Word tables', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({
            content: {
              type: 'doc',
              content: [
                {
                  type: 'table',
                  content: [
                    {
                      type: 'tableRow',
                      content: [
                        {
                          type: 'tableHeader',
                          content: [
                            {
                              type: 'paragraph',
                              content: [{ type: 'text', text: 'Item' }],
                            },
                          ],
                        },
                        {
                          type: 'tableCell',
                          content: [
                            {
                              type: 'paragraph',
                              content: [{ type: 'text', text: 'Cement' }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        ),
      );

      expect(document).toContain('<w:tbl>');
      expect(document).toContain('Item');
      expect(document).toContain('Cement');
    });

    it('carries text marks through as run properties', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({
            content: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'bold term', marks: [{ type: 'bold' }] },
                  ],
                },
              ],
            },
          }),
        ),
      );
      expect(document).toContain('<w:b/>');
      expect(document).toContain('bold term');
    });

    it('escapes XML-significant characters in document text', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({
            content: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Goods & Services <clause>' }],
                },
              ],
            },
          }),
        ),
      );

      // Unescaped, this would make document.xml unparseable and Word would
      // refuse the file.
      expect(document).toContain('&amp;');
      expect(document).not.toContain('<clause>');
    });
  });

  describe('watermark', () => {
    it('writes no header part when the document is not watermarked', async () => {
      const { header } = await unpack(await renderer.toBuffer(model()));
      expect(header).toBeNull();
    });

    it('places the watermark in the header, so it repeats on every page', async () => {
      const { header } = await unpack(
        await renderer.toBuffer(
          model({ watermark: buildWatermark('DRAFT — NOT APPROVED') }),
        ),
      );

      expect(header).not.toBeNull();
      expect(header).toContain('DRAFT');
    });

    it('uppercases and truncates the watermark text', async () => {
      const { header } = await unpack(
        await renderer.toBuffer(
          model({ watermark: buildWatermark('a'.repeat(60)) }),
        ),
      );
      expect(header).toContain('A'.repeat(40));
      expect(header).not.toContain('A'.repeat(41));
    });
  });

  describe('signature blocks', () => {
    it('renders a block per party', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({
            signatures: [
              {
                role: 'For the company',
                partyName: 'Acme Legal LLC',
                signatoryName: 'Aziz Karimov',
                signatoryPosition: 'General Director',
                requiresSeal: true,
              },
              { role: 'Counterparty', partyName: 'Beta LLC' },
            ],
          }),
        ),
      );

      expect(document).toContain('FOR THE COMPANY');
      expect(document).toContain('Aziz Karimov');
      expect(document).toContain('General Director');
      expect(document).toContain('COUNTERPARTY');
      expect(document).toContain('Beta LLC');
    });

    it('marks a seal position when no seal image is supplied', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({
            signatures: [
              { role: 'X', partyName: 'Acme', requiresSeal: true },
            ],
          }),
        ),
      );
      expect(document).toContain('M.P.');
    });

    it('embeds signature and seal images as media parts', async () => {
      const { paths, zip } = await unpack(
        await renderer.toBuffer(
          model({
            signatures: [
              {
                role: 'X',
                partyName: 'Acme',
                signatureImage: PNG,
                sealImage: PNG,
              },
            ],
          }),
        ),
      );

      const media = paths.filter((path) => path.startsWith('word/media/'));
      expect(media.length).toBeGreaterThanOrEqual(2);

      const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
      expect(rels).toContain('media/');
    });

    it('leaves a blank date line when the block is unsigned', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({ signatures: [{ role: 'X', partyName: 'Acme' }] }),
        ),
      );
      expect(document).toContain('20__');
    });

    it('prints the signing date when the block is signed', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({
            signatures: [
              {
                role: 'X',
                partyName: 'Acme',
                signedAt: new Date('2026-07-29T00:00:00Z'),
              },
            ],
          }),
        ),
      );
      expect(document).toContain('2026-07-29');
    });

    it('keeps a signature row from splitting across pages', async () => {
      const { document } = await unpack(
        await renderer.toBuffer(
          model({ signatures: [{ role: 'X', partyName: 'Acme' }] }),
        ),
      );
      expect(document).toContain('cantSplit');
    });
  });

  describe('verification mark', () => {
    it('omits the block when the document carries no verification', async () => {
      const { document } = await unpack(await renderer.toBuffer(model()));
      expect(document).not.toContain('Verify this document');
    });

    it('embeds the QR image and prints the token', async () => {
      const { document, paths } = await unpack(
        await renderer.toBuffer(
          model({
            verification: {
              url: 'https://legal.test/verify/abc.def',
              token: 'abc.def',
              qrPng: PNG,
            },
          }),
        ),
      );

      expect(document).toContain('Verify this document');
      expect(document).toContain('abc.def');
      expect(paths.some((path) => path.startsWith('word/media/'))).toBe(true);
    });
  });

  describe('footer', () => {
    it('writes page-number fields rather than static text', async () => {
      const { footer } = await unpack(await renderer.toBuffer(model()));
      expect(footer).not.toBeNull();
      expect(footer).toContain('PAGE');
      expect(footer).toContain('NUMPAGES');
    });
  });
});

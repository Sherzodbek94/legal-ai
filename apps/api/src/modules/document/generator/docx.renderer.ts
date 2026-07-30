import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  NumberFormat,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  ORDERED_NUMBERING_CONFIG,
  tiptapToDocxBlocks,
  type DocxBlock,
} from './tiptap-to-docx';
import type { DocumentRenderModel, SignatureBlock } from './render-model';

/** Twips per millimetre — Word measures page geometry in twentieths of a point. */
const TWIPS_PER_MM = 56.7;
const mm = (value: number) => Math.round(value * TWIPS_PER_MM);

@Injectable()
export class DocxRenderer {
  /**
   * Produces the document as a stream, for a common interface with the PDF
   * renderer at the export endpoint.
   *
   * Unlike the PDF path, this is **not** incremental. `docx` builds the whole
   * OPC zip in memory before yielding anything — its own `Packer.toStream`
   * calls `generateAsync({ type: 'nodebuffer' })` and then emits the finished
   * buffer as a single `data` event on a bare `Stream` that is neither a proper
   * Readable nor async-iterable. Wrapping `toBuffer` instead is the same amount
   * of memory with none of that surprise, and it gives callers a real Readable
   * with working backpressure and destroy semantics.
   *
   * The practical consequence: DOCX peak memory scales with document size, so
   * PDF_MAX_CONCURRENT_PAGES is not a bound on this path. Large exports should
   * go out as PDF.
   */
  async toStream(model: DocumentRenderModel): Promise<Readable> {
    // `[buffer]`, not `buffer` — Readable.from iterates a Buffer byte by byte,
    // which would emit one chunk per byte.
    return Readable.from([await this.toBuffer(model)]);
  }

  /** The packed .docx bytes. */
  async toBuffer(model: DocumentRenderModel): Promise<Buffer> {
    return Packer.toBuffer(this.buildDocument(model));
  }

  buildDocument(model: DocumentRenderModel): Document {
    const body: DocxBlock[] = [
      ...this.headerBlocks(model),
      ...tiptapToDocxBlocks(model.content),
      ...this.signatureBlocks(model),
      ...this.verificationBlocks(model),
    ];

    return new Document({
      title: model.title,
      description: `Generated ${model.generatedAt.toISOString()}`,
      creator: model.companyName,
      numbering: { config: [ORDERED_NUMBERING_CONFIG] },
      styles: {
        default: {
          document: {
            run: { font: 'Times New Roman', size: 23 },
            paragraph: { spacing: { line: 300 } },
          },
        },
      },
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: mm(22),
                bottom: mm(24),
                left: mm(24),
                right: mm(18),
              },
            },
          },
          headers: model.watermark
            ? { default: this.watermarkHeader(model) }
            : undefined,
          footers: { default: this.footer(model) },
          children: body,
        },
      ],
    });
  }

  /**
   * Watermark, approximated.
   *
   * A true Word watermark is a VML shape anchored in the header, which this
   * library does not model. What it does support is header content, and a
   * header paragraph repeats on every page — so the mark is rendered as large,
   * pale, centred text there.
   *
   * The difference matters and is worth stating plainly: this sits above the
   * top margin rather than diagonally behind the body text, and a recipient can
   * delete it by editing the header. It marks a draft; it does not secure one.
   * The PDF export is the copy to send when the watermark must be tamper-proof.
   */
  private watermarkHeader(model: DocumentRenderModel): Header {
    return new Header({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: model.watermark!.text.slice(0, 40).toUpperCase(),
              bold: true,
              size: 56,
              color: 'E0A0A0',
            }),
          ],
        }),
      ],
    });
  }

  private footer(model: DocumentRenderModel): Footer {
    const reference = model.referenceNumber ? `${model.referenceNumber} · ` : '';

    return new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: `${reference}${model.title} — `,
              size: 16,
              color: '777777',
            }),
            new TextRun({
              children: [PageNumber.CURRENT],
              size: 16,
              color: '777777',
            }),
            new TextRun({ text: ' / ', size: 16, color: '777777' }),
            new TextRun({
              children: [PageNumber.TOTAL_PAGES],
              size: 16,
              color: '777777',
            }),
          ],
        }),
      ],
    });
  }

  private headerBlocks(model: DocumentRenderModel): DocxBlock[] {
    return [
      new Paragraph({
        children: [
          new TextRun({
            text: model.companyName.toUpperCase(),
            size: 18,
            color: '444444',
          }),
        ],
      }),
      new Paragraph({
        children: [new TextRun({ text: model.title, bold: true, size: 32 })],
        spacing: { before: 60, after: 60 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: [
              model.referenceNumber ? `No. ${model.referenceNumber}` : null,
              model.generatedAt.toISOString().slice(0, 10),
            ]
              .filter(Boolean)
              .join(' · '),
            size: 18,
            color: '555555',
          }),
        ],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 6 },
        },
        spacing: { after: 240 },
      }),
    ];
  }

  /**
   * Signature blocks, laid out as a borderless two-column table.
   *
   * A table rather than paragraphs because Word keeps table rows together on a
   * page: a signature line that lands on its own page, separated from the
   * clauses it attests to, is a document people refuse to sign.
   */
  private signatureBlocks(model: DocumentRenderModel): DocxBlock[] {
    if (!model.signatures.length) return [];

    const rows: TableRow[] = [];

    for (let index = 0; index < model.signatures.length; index += 2) {
      const pair = model.signatures.slice(index, index + 2);

      rows.push(
        new TableRow({
          cantSplit: true,
          children: pair.map(
            (block) =>
              new TableCell({
                children: this.signatureCell(block),
                width: { size: 50, type: WidthType.PERCENTAGE },
                margins: { top: 120, bottom: 120, left: 120, right: 120 },
              }),
          ),
        }),
      );
    }

    return [
      new Paragraph({ children: [new TextRun('')], spacing: { before: 480 } }),
      new Table({
        rows,
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        },
      }),
    ];
  }

  private signatureCell(block: SignatureBlock): Paragraph[] {
    const paragraphs: Paragraph[] = [
      new Paragraph({
        children: [
          new TextRun({ text: block.role.toUpperCase(), size: 18, color: '444444' }),
        ],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: '333333', space: 4 },
        },
        spacing: { after: 120 },
      }),
      new Paragraph({
        children: [new TextRun({ text: block.partyName, bold: true })],
      }),
    ];

    if (block.signatoryPosition) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: block.signatoryPosition, size: 20 })],
        }),
      );
    }

    if (block.signatureImage) {
      paragraphs.push(
        new Paragraph({
          spacing: { before: 180 },
          children: [
            new ImageRun({
              type: 'png',
              data: block.signatureImage,
              transformation: { width: 150, height: 60 },
            }),
          ],
        }),
      );
    } else {
      // The signing line itself: an empty bottom-bordered paragraph.
      paragraphs.push(
        new Paragraph({
          children: [new TextRun('')],
          spacing: { before: 480 },
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: '333333', space: 2 },
          },
        }),
      );
    }

    if (block.sealImage) {
      paragraphs.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: 'png',
              data: block.sealImage,
              transformation: { width: 90, height: 90 },
            }),
          ],
        }),
      );
    } else if (block.requiresSeal) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: 'M.P.', size: 18, color: '999999' })],
          alignment: AlignmentType.RIGHT,
        }),
      );
    }

    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: block.signatoryName ?? '',
            size: 17,
            color: '666666',
          }),
          new TextRun({
            text: block.signedAt
              ? `\t${block.signedAt.toISOString().slice(0, 10)}`
              : '\t____ / ____ / 20__',
            size: 17,
            color: '666666',
          }),
        ],
        spacing: { before: 60 },
      }),
    );

    return paragraphs;
  }

  private verificationBlocks(model: DocumentRenderModel): DocxBlock[] {
    const { verification } = model;
    if (!verification) return [];

    return [
      new Paragraph({
        children: [new TextRun('')],
        spacing: { before: 360 },
        border: {
          top: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 6 },
        },
      }),
      new Paragraph({
        children: [
          new ImageRun({
            type: 'png',
            data: verification.qrPng,
            transformation: { width: 96, height: 96 },
          }),
        ],
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Verify this document: ', bold: true, size: 17 }),
          new TextRun({ text: verification.url.split('?')[0], size: 17 }),
        ],
        spacing: { before: 60 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: verification.token,
            font: 'Courier New',
            size: 16,
            color: '333333',
          }),
        ],
      }),
    ];
  }
}

/** Word's page-number field format, re-exported for callers building sections. */
export { NumberFormat };

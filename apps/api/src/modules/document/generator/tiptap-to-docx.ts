/**
 * Renders a TipTap document to Word content.
 *
 * A native DOCX rather than a PDF wrapped in a .docx extension: counterparties
 * redline contracts, and a document they cannot edit gets retyped by hand,
 * which is where clauses quietly change. Every node maps to real Word
 * structure — headings to heading styles, tables to tables — so Word's own
 * numbering, navigation, and track-changes all work on the output.
 */
import {
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  LevelFormat,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ISectionOptions,
} from 'docx';
import {
  headingLevel,
  isTipTapNode,
  type TipTapNode,
} from './tiptap-node';

/** Content Word can place at the top level of a section. */
export type DocxBlock = Paragraph | Table;

export const ORDERED_LIST_REFERENCE = 'legal-ordered-list';

/**
 * Numbering definition for ordered lists.
 *
 * Word resolves list numbering from the document's numbering part, not from the
 * paragraph — without this registered on the Document, an ordered list renders
 * as unnumbered paragraphs. Three levels: decimal, lower-letter, lower-roman,
 * which is the convention legal drafting already uses for sub-clauses.
 */
export const ORDERED_NUMBERING_CONFIG = {
  reference: ORDERED_LIST_REFERENCE,
  levels: [
    {
      level: 0,
      format: LevelFormat.DECIMAL,
      text: '%1.',
      alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } },
    },
    {
      level: 1,
      format: LevelFormat.LOWER_LETTER,
      text: '%2)',
      alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
    },
    {
      level: 2,
      format: LevelFormat.LOWER_ROMAN,
      text: '%3.',
      alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 2160, hanging: 360 } } },
    },
  ],
};

const HEADING_BY_LEVEL: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

const ALIGNMENT: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

/** Word's list nesting stops being readable past this; deeper levels flatten. */
const MAX_LIST_LEVEL = 2;

function alignmentOf(node: TipTapNode) {
  const align = node.attrs?.textAlign;
  return typeof align === 'string' ? ALIGNMENT[align] : undefined;
}

/** Inline content of a block node, flattened to Word runs. */
function inlineRuns(node: TipTapNode, inherited: Partial<TextRunStyle> = {}): TextRun[] {
  const runs: TextRun[] = [];

  for (const child of node.content ?? []) {
    if (!isTipTapNode(child)) continue;

    if (child.type === 'hardBreak') {
      runs.push(new TextRun({ break: 1 }));
      continue;
    }

    if (child.type === 'text') {
      const text = child.text ?? '';
      if (!text) continue;

      const isCode = child.marks?.some((mark) => mark.type === 'code');

      runs.push(
        new TextRun({
          text,
          bold: inherited.bold || child.marks?.some((mark) => mark.type === 'bold'),
          italics:
            inherited.italics || child.marks?.some((mark) => mark.type === 'italic'),
          underline: child.marks?.some((mark) => mark.type === 'underline')
            ? {}
            : undefined,
          strike: child.marks?.some((mark) => mark.type === 'strike'),
          ...(isCode ? { font: 'Courier New' } : {}),
        }),
      );
      continue;
    }

    // A nested inline wrapper from an unrecognised extension: keep its words.
    runs.push(...inlineRuns(child, inherited));
  }

  return runs;
}

interface TextRunStyle {
  bold: boolean;
  italics: boolean;
}

function paragraphFrom(
  node: TipTapNode,
  options: IParagraphOptions = {},
): Paragraph {
  const children = inlineRuns(node);

  return new Paragraph({
    // An empty paragraph is a deliberate blank line, so it is kept rather than
    // collapsed — spacing in a contract is often load-bearing.
    children: children.length ? children : [new TextRun('')],
    alignment: alignmentOf(node),
    spacing: { after: 120 },
    ...options,
  });
}

function listBlocks(
  node: TipTapNode,
  ordered: boolean,
  level: number,
): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const effectiveLevel = Math.min(level, MAX_LIST_LEVEL);

  for (const item of node.content ?? []) {
    if (!isTipTapNode(item) || item.type !== 'listItem') continue;

    let first = true;

    for (const child of item.content ?? []) {
      if (!isTipTapNode(child)) continue;

      if (child.type === 'bulletList' || child.type === 'orderedList') {
        blocks.push(
          ...listBlocks(child, child.type === 'orderedList', level + 1),
        );
        continue;
      }

      // Only the first paragraph of an item carries the marker; continuation
      // paragraphs are indented to match but not re-numbered.
      const marker = first
        ? ordered
          ? { numbering: { reference: ORDERED_LIST_REFERENCE, level: effectiveLevel } }
          : { bullet: { level: effectiveLevel } }
        : { indent: { left: 720 * (effectiveLevel + 1) } };

      blocks.push(paragraphFrom(child, marker));
      first = false;
    }
  }

  return blocks;
}

function tableFrom(node: TipTapNode): Table {
  const rows: TableRow[] = [];

  for (const rowNode of node.content ?? []) {
    if (!isTipTapNode(rowNode) || rowNode.type !== 'tableRow') continue;

    const cells: TableCell[] = [];

    for (const cellNode of rowNode.content ?? []) {
      if (!isTipTapNode(cellNode)) continue;
      if (cellNode.type !== 'tableCell' && cellNode.type !== 'tableHeader') {
        continue;
      }

      const isHeader = cellNode.type === 'tableHeader';
      const content = (cellNode.content ?? [])
        .filter(isTipTapNode)
        .flatMap((child) => blocksFrom(child, 0));

      cells.push(
        new TableCell({
          children: content.length
            ? content
            : [new Paragraph({ children: [new TextRun('')] })],
          columnSpan: numericAttr(cellNode, 'colspan'),
          rowSpan: numericAttr(cellNode, 'rowspan'),
          shading: isHeader ? { fill: 'F0F0F0' } : undefined,
        }),
      );
    }

    if (cells.length) rows.push(new TableRow({ children: cells }));
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function numericAttr(node: TipTapNode, key: string): number | undefined {
  const raw = Number(node.attrs?.[key] ?? 1);
  if (!Number.isFinite(raw) || raw <= 1) return undefined;
  return Math.trunc(raw);
}

function blocksFrom(node: TipTapNode, level: number): DocxBlock[] {
  switch (node.type) {
    case 'paragraph':
      return [paragraphFrom(node)];

    case 'heading':
      return [
        paragraphFrom(node, {
          heading: HEADING_BY_LEVEL[headingLevel(node)],
          spacing: { before: 240, after: 120 },
        }),
      ];

    case 'bulletList':
      return listBlocks(node, false, level);

    case 'orderedList':
      return listBlocks(node, true, level);

    case 'blockquote':
      return (node.content ?? [])
        .filter(isTipTapNode)
        .map((child) =>
          paragraphFrom(child, {
            indent: { left: 720 },
            border: {
              left: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 8 },
            },
          }),
        );

    case 'codeBlock':
      return [
        new Paragraph({
          children: [
            new TextRun({ text: plainText(node), font: 'Courier New', size: 19 }),
          ],
          spacing: { after: 120 },
        }),
      ];

    case 'horizontalRule':
      return [
        new Paragraph({
          children: [new TextRun('')],
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 },
          },
          spacing: { before: 120, after: 120 },
        }),
      ];

    case 'table':
      return [tableFrom(node)];

    case 'doc':
      return (node.content ?? [])
        .filter(isTipTapNode)
        .flatMap((child) => blocksFrom(child, level));

    default:
      // Unknown block from a newer editor: render its text rather than drop it.
      if (node.content?.length) {
        return (node.content ?? [])
          .filter(isTipTapNode)
          .flatMap((child) => blocksFrom(child, level));
      }
      if (node.text) {
        return [new Paragraph({ children: [new TextRun(node.text)] })];
      }
      return [];
  }
}

function plainText(node: TipTapNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(plainText).join('');
}

/** Converts a document body into section children. */
export function tiptapToDocxBlocks(doc: unknown): DocxBlock[] {
  if (!isTipTapNode(doc)) return [];
  return blocksFrom(doc, 0);
}

export type DocxSectionChildren = ISectionOptions['children'];

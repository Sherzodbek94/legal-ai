/**
 * The editor document shape shared by the HTML and DOCX renderers.
 *
 * Templates and generated documents both store their body as TipTap JSON
 * (`DocumentTemplate.content`, `GeneratedDocument.content`), so both output
 * formats read the same tree. Typed loosely on purpose — the tree arrives from
 * the database and may have been written by an older editor build, so renderers
 * must degrade rather than throw on a node they do not recognise.
 */

export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TipTapNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: TipTapMark[];
  content?: TipTapNode[];
}

/** Node types both renderers understand. Anything else falls back to its text. */
export const SUPPORTED_NODE_TYPES = [
  'doc',
  'paragraph',
  'heading',
  'text',
  'hardBreak',
  'horizontalRule',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
] as const;

export function isTipTapNode(value: unknown): value is TipTapNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Heading levels outside 1–6 are not renderable; clamp rather than drop. */
export function headingLevel(node: TipTapNode): number {
  const raw = Number(node.attrs?.level ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(6, Math.max(1, Math.trunc(raw)));
}

export function hasMark(node: TipTapNode, type: string): boolean {
  return Boolean(node.marks?.some((mark) => mark.type === type));
}

/**
 * Extracts a link target, rejecting anything that is not a plain navigation.
 *
 * `javascript:` and `data:` URIs in a link are script execution in the Chromium
 * page the PDF renderer opens, and this content is AI-generated from
 * user-supplied variables.
 */
export function safeLinkHref(node: TipTapNode): string | undefined {
  const link = node.marks?.find((mark) => mark.type === 'link');
  const href = link?.attrs?.href;
  if (typeof href !== 'string') return undefined;

  const trimmed = href.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(trimmed)) return undefined;
  return trimmed;
}

/** Flattens a subtree to plain text, for alt text and fallbacks. */
export function textContent(node: TipTapNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textContent).join('');
}

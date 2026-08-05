/**
 * Plain text <-> TipTap document conversion.
 *
 * `TemplateVersion.content` is a TipTap node tree, because that is what the
 * editor, the HTML renderer, and the DOCX renderer all read. Authors write
 * plain text with `{{placeholder}}` markers, so this is the bridge.
 *
 * Deliberately a small, lossless-for-this-purpose subset: a line starting with
 * `# ` is a heading, a blank line separates paragraphs, everything else is
 * body text. A full rich-text editor would produce marks and nested nodes that
 * `interpolate-content.ts` would then have to handle mid-placeholder — the
 * exact case it already refuses with a 422 ("dangling open"), because a
 * `{{par` / `ty}}` split across two marks cannot be filled.
 */

export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  text?: string;
}

export function textToTipTap(source: string): TipTapNode {
  const blocks = source
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const content: TipTapNode[] = blocks.map((block) => {
    // `[\s\S]` rather than the `s` flag: the web tsconfig targets ES2017,
    // where `dotAll` is not available.
    const heading = /^(#{1,3})\s+([\s\S]*)$/.exec(block);
    if (heading) {
      return {
        type: 'heading',
        attrs: { level: heading[1].length },
        content: [{ type: 'text', text: heading[2].replace(/\n/g, ' ').trim() }],
      };
    }

    // Single newlines inside a block become hard breaks, so numbered clauses
    // survive instead of being run together.
    const lines = block.split('\n').map((line) => line.trim());
    const inline: TipTapNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) inline.push({ type: 'hardBreak' });
      if (line) inline.push({ type: 'text', text: line });
    });

    return { type: 'paragraph', content: inline };
  });

  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/** Reverses `textToTipTap` closely enough to re-edit a stored version. */
export function tipTapToText(node: unknown): string {
  const doc = node as TipTapNode | undefined;
  if (!doc?.content) return '';

  return doc.content
    .map((block) => {
      const inner = (block.content ?? [])
        .map((child) => (child.type === 'hardBreak' ? '\n' : (child.text ?? '')))
        .join('');

      if (block.type === 'heading') {
        const level = Number(block.attrs?.level ?? 1);
        return `${'#'.repeat(Math.min(3, Math.max(1, level)))} ${inner}`;
      }
      return inner;
    })
    .join('\n\n');
}

/**
 * Placeholder keys used in the body, in first-appearance order.
 *
 * Mirrors `collectPlaceholders` on the API. Duplicated rather than shared
 * because the two run in different runtimes; the format is a single regex and
 * the API rejects a publish whose body references anything the schema does not
 * declare, so a drift here surfaces immediately rather than silently.
 */
export function collectPlaceholders(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    found.add(match[1]);
  }
  return [...found];
}

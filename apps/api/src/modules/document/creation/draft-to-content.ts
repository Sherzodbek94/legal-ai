/**
 * Converts an AI draft into the editor JSON everything downstream expects.
 *
 * The AI engine returns a structured draft (title + ordered sections of prose),
 * while the renderers, the editor, and `GeneratedDocument.content` all speak
 * TipTap. Without this the AI path could produce documents but nothing could
 * display or export them.
 */
import type { TipTapNode } from '../generator/tiptap-node';
import type { LegalDocumentDraft } from '../../ai-engine/schemas/legal-document.schema';

function text(value: string): TipTapNode {
  return { type: 'text', text: value };
}

function heading(level: number, value: string): TipTapNode {
  return { type: 'heading', attrs: { level }, content: [text(value)] };
}

/**
 * Splits a section body into paragraphs.
 *
 * Models emit prose with blank lines between paragraphs and single newlines
 * inside them. Collapsing every newline would run enumerated clauses together;
 * treating every newline as a paragraph break would shred wrapped text. Blank
 * lines are the reliable signal, with single newlines kept as hard breaks so
 * numbered lists survive.
 */
function toParagraphs(body: string): TipTapNode[] {
  return body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim());
      const content: TipTapNode[] = [];

      lines.forEach((line, index) => {
        if (index > 0) content.push({ type: 'hardBreak' });
        content.push(text(line));
      });

      return { type: 'paragraph', content };
    });
}

/**
 * Builds the document body.
 *
 * Sections are sorted by their declared `order` rather than trusted in array
 * order — the field exists precisely because models occasionally emit them out
 * of sequence, and clause order is meaningful in a contract.
 */
export function draftToContent(draft: LegalDocumentDraft): TipTapNode {
  const sections = [...draft.sections].sort((a, b) => a.order - b.order);

  const content: TipTapNode[] = [heading(1, draft.title)];

  for (const section of sections) {
    if (section.heading.trim()) {
      content.push(heading(2, section.heading.trim()));
    }
    content.push(...toParagraphs(section.body));
  }

  return { type: 'doc', content };
}

/**
 * A short human summary stored on `aiSummary`.
 *
 * Deliberately carries the model's own caveats rather than a description of the
 * document: `missingFields` and `reviewNotes` are the parts a reviewing
 * attorney must see, and burying them in a JSON column nobody renders is how a
 * draft with an acknowledged gap gets signed.
 */
export function draftToSummary(draft: LegalDocumentDraft): string | undefined {
  const parts: string[] = [];

  if (draft.missingFields.length > 0) {
    parts.push(`Missing information: ${draft.missingFields.join('; ')}`);
  }
  if (draft.reviewNotes.length > 0) {
    parts.push(`Review notes: ${draft.reviewNotes.join('; ')}`);
  }

  if (parts.length === 0) return undefined;
  // Bounded because the column is rendered inline in document lists.
  return parts.join(' | ').slice(0, 2000);
}

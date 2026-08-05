import type {
  LegalTemplateDraft,
  TemplateVariableDraft,
} from '../schemas/legal-template.schema';

export interface TemplateDraftIssues {
  /** Used in the text, declared nowhere. These would print literally. */
  undeclared: string[];
  /** Declared, used nowhere. Harmless but asks the user for nothing. */
  unused: string[];
  /** Keys the rest of the system cannot accept. */
  invalidKeys: string[];
  /** Sections with a heading and almost no body. */
  thinSections: string[];
}

/** `{{key}}`, matching the collector the publish path already uses. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Keys are addressed by templates, forms, and the exporters; keep them plain. */
const VALID_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * A section shorter than this is a heading with a sentence under it.
 *
 * The exact failure the user reported: templates whose "clauses" were one line
 * each, producing a contract with no substance. Reported rather than rejected —
 * a signature block legitimately is short — but a draft where most sections
 * trip this is not one to publish.
 */
const THIN_SECTION_CHARS = 120;

/**
 * Checks that a drafted template's text and its variable declarations agree.
 *
 * This is the check that matters. A model asked for both halves in one answer
 * will occasionally write `{{delivery_days}}` in the text and declare
 * `delivery_deadline` in the list, and nothing downstream can tell: the
 * publish path rejects the template much later with "unknown variable", or
 * worse, the placeholder survives into a generated contract and gets printed
 * as `{{delivery_days}}` on a page somebody signs.
 *
 * Returns issues rather than throwing. A draft is a proposal for a human to
 * review, and one with a spare declared variable is still worth showing —
 * refusing to return it would lose an otherwise good draft over a detail the
 * reviewer can fix in the builder.
 */
export function validateTemplateDraft(
  draft: LegalTemplateDraft,
): TemplateDraftIssues {
  const declared = new Set(draft.variables.map((variable) => variable.key));
  const used = new Set<string>();

  for (const section of draft.sections) {
    PLACEHOLDER.lastIndex = 0;
    for (const match of `${section.heading}\n${section.body}`.matchAll(
      PLACEHOLDER,
    )) {
      used.add(match[1]);
    }
  }

  return {
    undeclared: [...used].filter((key) => !declared.has(key)).sort(),
    unused: [...declared].filter((key) => !used.has(key)).sort(),
    invalidKeys: draft.variables
      .map((variable) => variable.key)
      .filter((key) => !VALID_KEY.test(key))
      .sort(),
    thinSections: draft.sections
      .filter((section) => section.body.trim().length < THIN_SECTION_CHARS)
      .map((section) => section.heading),
  };
}

/**
 * Turns a drafted template into the editor JSON a template version stores.
 *
 * Headings are numbered from `order` rather than from the model's own
 * numbering: models number inconsistently across a long answer, and a contract
 * whose clauses run 1, 2, 2, 4 is the kind of defect a reader blames on the
 * firm rather than on the software.
 */
export function templateDraftToContent(draft: LegalTemplateDraft) {
  const sections = [...draft.sections].sort((a, b) => a.order - b.order);

  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: draft.title }],
      },
      ...sections.flatMap((section, index) => [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [
            { type: 'text', text: `${index + 1}. ${stripLeadingNumber(section.heading)}` },
          ],
        },
        // One paragraph per line. The model returns a section as a block of
        // text with newlines in it, and a single paragraph carrying embedded
        // newlines renders as one run-on wall in both the editor and the PDF.
        ...section.body
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => ({
            type: 'paragraph',
            content: [{ type: 'text', text: line }],
          })),
      ]),
    ],
  };
}

/** The model often writes "1. Shartnoma predmeti"; the renderer adds its own. */
function stripLeadingNumber(heading: string): string {
  return heading.replace(/^\s*\d+[.)]\s*/, '').trim();
}

/** The variable schema a template version stores, from the drafted list. */
export function templateDraftToSchema(variables: TemplateVariableDraft[]) {
  return {
    version: 1 as const,
    variables: variables.map((variable) => ({
      key: variable.key,
      label: variable.label,
      type: variable.type,
      required: variable.required,
      // Empty strings are what a strict-mode model returns for a field it has
      // nothing to say about; storing them would show blank hint text under
      // every input.
      ...(variable.description ? { description: variable.description } : {}),
      ...(variable.currency ? { currency: variable.currency } : {}),
      ...(variable.options?.length ? { options: variable.options } : {}),
    })),
  };
}

/**
 * Cleans a user-supplied value on its way into a rendered document.
 *
 * Deliberately much lighter than `sanitizePromptValue`. That one strips
 * `{}[]<>` because those characters break out of a delimited prompt block —
 * but in a contract they are ordinary punctuation, and a party named
 * "Alpha [Holding] LLC" must render with its brackets intact. Reusing the
 * prompt sanitiser here would silently corrupt legal text to defend against a
 * threat that does not exist on this path.
 *
 * Injection is not the concern: values land in TipTap text nodes, and both
 * renderers escape on the way out (`escapeHtml` for PDF, the docx builder's own
 * XML escaping for Word).
 *
 * What is left is what actually corrupts output — control characters, which are
 * illegal in the XML a .docx is built from and would make the file unopenable,
 * and invisible/bidirectional characters, which can reorder how a clause
 * visually reads without changing its text.
 */

/** C0 and C1 control characters, except the tab and newline that carry meaning. */
const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]',
  'g',
);

/** Zero-width and bidirectional-override characters. */
const INVISIBLE_CHARS = new RegExp(
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
  'g',
);

export const DEFAULT_MAX_DOCUMENT_VALUE_LENGTH = 2000;

export function sanitizeDocumentValue(
  value: string,
  maxLength: number = DEFAULT_MAX_DOCUMENT_VALUE_LENGTH,
): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .slice(0, maxLength)
    .trim();
}

/**
 * Placeholder syntax shared by templates and document generation.
 *
 * Lives in `common` rather than in either module because both need it and
 * neither owns it: the template module rejects a body whose placeholders are
 * undeclared, and the document module fills them in. Two copies of this regex
 * is how the two sides start disagreeing about what a placeholder is — and the
 * failure mode of that disagreement is a published template that validates but
 * generates blanks.
 */

/**
 * `{{ key }}` with optional inner whitespace.
 *
 * Keys are restricted to the character class the variable schema permits, so a
 * stray `{{` in prose — a code sample, a citation — is left alone rather than
 * being treated as a broken placeholder.
 */
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

/**
 * An opening brace pair with no matching close in the same string.
 *
 * Worth detecting separately: TipTap stores a marked run as its own text node,
 * so bolding half a placeholder splits `{{name}}` across two nodes and neither
 * half matches. Rendering the fragments would print `{{na` into a contract.
 */
export const DANGLING_OPEN_PATTERN = /\{\{(?![^{}]*\}\})/;

/**
 * The minimum an editor node must look like to be walked.
 *
 * Declared here rather than imported from the renderers' `TipTapNode` so this
 * module stays free of module-specific imports — it is walked by both sides.
 */
export interface PlaceholderNode {
  text?: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
}

export function isWalkable(value: unknown): value is PlaceholderNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every placeholder key appearing in an editor body, sorted and deduplicated.
 *
 * Used at publish time to reject a body referencing variables the schema does
 * not declare — those can never be filled, because value validation rejects
 * undeclared keys.
 */
export function collectPlaceholders(content: unknown): string[] {
  const found = new Set<string>();

  const scan = (value: string): void => {
    // matchAll needs a fresh lastIndex each time; the pattern is module-level
    // and global, so it is reset rather than shared mid-iteration.
    PLACEHOLDER_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
      found.add(match[1]);
    }
  };

  const visit = (node: PlaceholderNode): void => {
    if (typeof node.text === 'string') scan(node.text);

    for (const value of Object.values(node.attrs ?? {})) {
      if (typeof value === 'string') scan(value);
    }

    for (const child of node.content ?? []) {
      if (isWalkable(child)) visit(child);
    }
  };

  if (isWalkable(content)) visit(content);
  return [...found].sort();
}

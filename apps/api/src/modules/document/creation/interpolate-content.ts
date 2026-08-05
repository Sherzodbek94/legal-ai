/**
 * Substitutes variable values into a template body.
 *
 * This is the path that makes the product work with no AI provider configured
 * at all: a published template is a complete legal document with `{{key}}`
 * placeholders, and filling those in is a pure, deterministic, free operation.
 * The AI path is an enhancement on top, not a prerequisite.
 */
import { isTipTapNode, type TipTapNode } from '../generator/tiptap-node';
import {
  DANGLING_OPEN_PATTERN,
  PLACEHOLDER_PATTERN,
} from '../../../common/template/placeholders';

// Shared with the template module's publish-time check, so "what counts as a
// placeholder" has one definition. A body that publishes must be a body this
// can fill.
const PLACEHOLDER = PLACEHOLDER_PATTERN;
const DANGLING_OPEN = DANGLING_OPEN_PATTERN;

/**
 * What an unfilled optional placeholder renders as.
 *
 * A ruled blank is the drafting convention for a field completed by hand, and
 * it is visibly incomplete. The alternatives are both worse: leaving `{{key}}`
 * prints machinery into a signed document, and rendering an empty string
 * produces a sentence that reads as finished while missing its subject.
 */
const BLANK = '__________';

export interface InterpolationResult {
  content: TipTapNode;
  /** Declared placeholders that had no value; rendered as a blank. */
  unresolved: string[];
  /**
   * Placeholders that could not be read at all, because their braces are split
   * across text nodes by formatting. These are template authoring faults.
   */
  malformed: boolean;
}

/**
 * Returns a copy of `content` with placeholders replaced.
 *
 * Never mutates the input: the caller's `content` is the stored template body,
 * shared by every document generated from that version.
 */
export function interpolateContent(
  content: unknown,
  values: Record<string, string>,
): InterpolationResult {
  const unresolved = new Set<string>();
  let malformed = false;

  const substitute = (text: string): string => {
    if (DANGLING_OPEN.test(text)) {
      malformed = true;
    }

    return text.replace(PLACEHOLDER, (_match, key: string) => {
      const value = values[key];
      // An empty string counts as absent. A variable explicitly set to "" is
      // indistinguishable here from one never supplied, and a blank is the
      // safer reading of both.
      if (value === undefined || value === '') {
        unresolved.add(key);
        return BLANK;
      }
      return value;
    });
  };

  const walk = (node: TipTapNode): TipTapNode => {
    const next: TipTapNode = { ...node };

    if (typeof node.text === 'string') {
      next.text = substitute(node.text);
    }

    // Placeholders also appear in attributes — a link href built from a
    // variable, a table cell's colspan is not, but the loop cannot know which,
    // so only string attributes are touched.
    if (node.attrs) {
      next.attrs = Object.fromEntries(
        Object.entries(node.attrs).map(([key, value]) => [
          key,
          typeof value === 'string' ? substitute(value) : value,
        ]),
      );
    }

    if (Array.isArray(node.content)) {
      next.content = node.content.map((child) =>
        isTipTapNode(child) ? walk(child) : child,
      );
    }

    return next;
  };

  const root = isTipTapNode(content) ? content : { type: 'doc', content: [] };

  return {
    content: walk(root),
    unresolved: [...unresolved].sort(),
    malformed,
  };
}

export { collectPlaceholders } from '../../../common/template/placeholders';

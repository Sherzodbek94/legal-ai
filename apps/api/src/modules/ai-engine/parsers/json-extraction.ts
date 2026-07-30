/**
 * Recovers a JSON value from raw model output.
 *
 * Even with native constrained decoding, this layer stays: schema enforcement
 * is per-provider and not guaranteed on fallback paths, refusals and truncated
 * responses still arrive as prose, and models intermittently wrap output in
 * markdown fences or a short preamble. Treating output as untrusted text and
 * parsing defensively is cheaper than debugging a 3am `JSON.parse` crash.
 */

export type JsonExtractionFailure =
  | 'empty-input'
  | 'no-json-found'
  | 'malformed-json';

export type JsonExtractionResult<T = unknown> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; error: JsonExtractionFailure; detail: string };

/** Strips ```json … ``` (or bare ``` … ```) fences, if the text is fenced. */
export function stripCodeFences(input: string): string {
  const fence = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;
  const match = fence.exec(input);
  return match ? match[1] : input;
}

/**
 * Finds the first complete JSON object or array in `input`.
 *
 * Scans with a depth counter rather than a regex, and tracks whether the
 * cursor is inside a string literal — a naive brace match breaks the moment a
 * document body legitimately contains `{` or `}`, which legal templates
 * routinely do (placeholder syntax).
 */
export function findFirstJsonValue(input: string): string | null {
  const openIndex = findFirstOpener(input);
  if (openIndex === -1) return null;

  const opener = input[openIndex];
  const closer = opener === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      // Backslashes only escape inside string literals.
      if (inString) escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) return input.slice(openIndex, i + 1);
    }
  }

  // Unbalanced — the response was probably truncated at max_tokens.
  return null;
}

function findFirstOpener(input: string): number {
  const brace = input.indexOf('{');
  const bracket = input.indexOf('[');
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

/**
 * Removes trailing commas before a closing brace/bracket.
 *
 * The single most common malformation in model-produced JSON, and
 * unambiguously safe to repair. Deliberately narrow: anything more aggressive
 * (quote insertion, comment stripping) risks silently changing document text,
 * which for a legal draft is worse than a clean failure.
 */
export function repairTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      out += char;
      if (inString) escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }

    if (!inString && char === ',') {
      // Look ahead past whitespace: a comma directly before } or ] is trailing.
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === '}' || input[j] === ']') {
        continue; // drop the comma
      }
    }

    out += char;
  }

  return out;
}

/** Extracts and parses JSON from raw model output. */
export function extractJson<T = unknown>(
  raw: string | null | undefined,
): JsonExtractionResult<T> {
  if (!raw || !raw.trim()) {
    return { ok: false, error: 'empty-input', detail: 'Model returned no text' };
  }

  const unfenced = stripCodeFences(raw);
  const candidate = findFirstJsonValue(unfenced);

  if (!candidate) {
    return {
      ok: false,
      error: 'no-json-found',
      detail: 'No balanced JSON object or array in model output',
    };
  }

  try {
    return { ok: true, value: JSON.parse(candidate) as T, repaired: false };
  } catch {
    // One narrow repair attempt before giving up.
    const repaired = repairTrailingCommas(candidate);
    try {
      return { ok: true, value: JSON.parse(repaired) as T, repaired: true };
    } catch (error) {
      return {
        ok: false,
        error: 'malformed-json',
        detail: (error as Error).message,
      };
    }
  }
}

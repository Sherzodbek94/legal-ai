export interface ResolvedCitation {
  token: string;
  /** `corpus` for statute law, `document` for the company's own scans. */
  kind: 'corpus' | 'document';
  /** Chunk or document id, so a reader can open the source. */
  refId: string;
  citation: string;
  url: string | null;
  superseded: boolean;
}

export interface CitationCheck {
  /** Sources the answer cited that were actually supplied. */
  cited: ResolvedCitation[];
  /** Tokens the model invented. See `stripInvented`. */
  invented: string[];
  /** Supplied but never referred to — useful for tuning retrieval depth. */
  unused: string[];
}

const TOKEN = /\[(S\d+)\]/g;

/**
 * Checks an answer's citations against what the model was actually given.
 *
 * This is the anti-hallucination mechanism, and the reason sources are numbered
 * rather than named. A model that invents "347-modda" produces something
 * indistinguishable from a real citation; a model that invents `[S9]` when it
 * was handed six sources is caught by counting.
 *
 * Nothing is thrown. An answer with one bad token is still mostly useful, and
 * the caller decides — the service strips the invented tokens from the text and
 * records the rest, so the reader never sees a reference that resolves to
 * nothing.
 */
export function checkCitations(
  answer: string,
  supplied: ResolvedCitation[],
): CitationCheck {
  const byToken = new Map(supplied.map((source) => [source.token, source]));
  const referenced = new Set<string>();

  TOKEN.lastIndex = 0;
  for (const match of answer.matchAll(TOKEN)) {
    referenced.add(match[1]);
  }

  return {
    cited: [...referenced]
      .filter((token) => byToken.has(token))
      // Sorted by the numeric part, so a reader's source list runs 1, 2, 10
      // rather than 1, 10, 2.
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((token) => byToken.get(token)!),
    invented: [...referenced].filter((token) => !byToken.has(token)).sort(),
    unused: supplied
      .map((source) => source.token)
      .filter((token) => !referenced.has(token)),
  };
}

/**
 * Removes references to sources that were never supplied.
 *
 * Left in place, `[S9]` renders as a footnote marker pointing at nothing —
 * which reads to a lawyer as though a source exists and the UI failed to show
 * it. Removing the marker is honest: the sentence stands or falls on its own,
 * and the answer's real citations are still there.
 */
export function stripInvented(answer: string, invented: string[]): string {
  if (invented.length === 0) return answer;

  const pattern = new RegExp(`\\[(?:${invented.join('|')})\\]`, 'g');

  return answer
    .replace(pattern, '')
    // A sentence that cited two sources, one invented, is left with a double
    // space or a stranded comma between the brackets.
    .replace(/\[\s*,\s*/g, '[')
    .replace(/\s*,\s*\]/g, ']')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:])/g, '$1')
    .trim();
}

/**
 * Whether the answer rests on anything.
 *
 * True when nothing was retrieved, or when the model cited nothing it was
 * given. Both mean the same thing to a reader — the answer is the model's own
 * opinion — and that has to be visible rather than inferred from an empty
 * source list.
 */
export function isUngrounded(check: CitationCheck, suppliedCount: number): boolean {
  return suppliedCount === 0 || check.cited.length === 0;
}

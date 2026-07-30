/**
 * Splitting extracted text into passages to embed.
 *
 * Chunk boundaries decide what retrieval can find. A clause split down the
 * middle produces two passages that each answer half a question and neither
 * answers it well, so boundaries are chosen at the strongest available
 * structural break rather than at a fixed character count.
 *
 * Pure functions — chunking strategy is the thing most likely to be tuned, and
 * tuning it should not require a database or an API key.
 */

export interface Chunk {
  content: string;
  /** 0-based position in the document. */
  index: number;
  /** Approximate token count; see `estimateTokens`. */
  tokenCount: number;
  /** Character offset in the source text, for highlighting. */
  offset: number;
}

export interface ChunkOptions {
  /** Target size in tokens. */
  targetTokens?: number;
  /** Hard ceiling; a passage is split even mid-sentence beyond this. */
  maxTokens?: number;
  /**
   * Tokens repeated from the end of the previous chunk.
   *
   * Overlap is what stops a fact that straddles a boundary being lost by both
   * sides — the sentence naming a party at the end of one chunk is still present
   * at the start of the next, so a query about that party matches the chunk that
   * also contains their obligations.
   */
  overlapTokens?: number;
  /** Passages shorter than this are merged into their neighbour. */
  minTokens?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  // 512 sits inside every current embedding model's window with room for the
  // overlap, and is long enough to hold a complete contract clause.
  targetTokens: 512,
  maxTokens: 800,
  overlapTokens: 64,
  minTokens: 32,
};

/**
 * Approximate token count.
 *
 * Deliberately not a real tokeniser. Loading tiktoken to count tokens for
 * chunking would add a heavy dependency to save nothing: the count only has to
 * be good enough to keep batches under an API limit, and the estimate is
 * conservative in the direction that matters.
 *
 * ~3 characters per token for Cyrillic and Uzbek Latin, against the ~4 usually
 * quoted for English. Both languages tokenise worse than English under BPE
 * vocabularies trained mostly on English text — Cyrillic especially, where
 * common words fragment into several tokens. Assuming 4 would understate real
 * usage by roughly a third and overflow the batch limits it exists to respect.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const ratio = cyrillic / Math.max(1, text.length);

  // Interpolate between 4 chars/token (mostly Latin) and 2.5 (mostly Cyrillic).
  const charsPerToken = 4 - ratio * 1.5;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

/**
 * Structural break points, strongest first.
 *
 * Legal documents are heavily numbered, and a numbered clause start is a far
 * better boundary than a blank line — it is where the document itself says one
 * idea ends and the next begins.
 */
const BOUNDARY_PATTERNS: { pattern: RegExp; strength: number }[] = [
  // Numbered clause: "1.", "2.3.", "10.1.4." at the start of a line.
  { pattern: /\n(?=\s*\d+(\.\d+)*\.?\s)/g, strength: 4 },
  // Article / section headings in either language.
  {
    pattern: /\n(?=\s*(?:Статья|Модда|Article|СТАТЬЯ|MODDA|Bo['ʻ]lim|Раздел)\b)/gi,
    strength: 4,
  },
  // Blank line — a paragraph break.
  { pattern: /\n\s*\n/g, strength: 3 },
  // Single newline.
  { pattern: /\n/g, strength: 2 },
  // Sentence end. Requires a following space so "12.5%" is not a boundary.
  { pattern: /(?<=[.!?])\s+(?=[A-ZА-ЯЎҚҒҲ])/g, strength: 1 },
];

interface Boundary {
  offset: number;
  strength: number;
}

function findBoundaries(text: string): Boundary[] {
  const byOffset = new Map<number, number>();

  for (const { pattern, strength } of BOUNDARY_PATTERNS) {
    // `matchAll` needs a fresh lastIndex; the patterns are module-level and
    // global, so they are reset explicitly.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const offset = (match.index ?? 0) + match[0].length;
      // Strongest wins when several patterns land on the same offset.
      byOffset.set(offset, Math.max(byOffset.get(offset) ?? 0, strength));
    }
  }

  return [...byOffset.entries()]
    .map(([offset, strength]) => ({ offset, strength }))
    .sort((a, b) => a.offset - b.offset);
}

/**
 * Picks where to cut, given a window.
 *
 * Prefers the strongest boundary in the back half of the window: cutting early
 * at a strong break beats cutting exactly on target at a weak one, but cutting
 * in the first half wastes too much of the budget.
 */
function chooseCut(
  boundaries: Boundary[],
  start: number,
  targetEnd: number,
  hardEnd: number,
): number {
  const earliest = start + Math.floor((targetEnd - start) / 2);

  const candidates = boundaries.filter(
    (boundary) => boundary.offset > earliest && boundary.offset <= hardEnd,
  );

  if (candidates.length === 0) return hardEnd;

  // Strongest boundary; among equals, the one nearest the target size.
  let best = candidates[0];
  for (const candidate of candidates) {
    if (
      candidate.strength > best.strength ||
      (candidate.strength === best.strength &&
        Math.abs(candidate.offset - targetEnd) < Math.abs(best.offset - targetEnd))
    ) {
      best = candidate;
    }
  }

  return best.offset;
}

/** Character budget for a token budget, using the same ratio as the estimator. */
function charsForTokens(text: string, tokens: number): number {
  const perToken = text.length / Math.max(1, estimateTokens(text));
  return Math.ceil(tokens * perToken);
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const config = { ...DEFAULTS, ...options };
  const normalized = text.replace(/\r\n/g, '\n').trim();

  if (!normalized) return [];

  if (estimateTokens(normalized) <= config.maxTokens) {
    return [
      {
        content: normalized,
        index: 0,
        tokenCount: estimateTokens(normalized),
        offset: 0,
      },
    ];
  }

  const boundaries = findBoundaries(normalized);
  const targetChars = charsForTokens(normalized, config.targetTokens);
  const maxChars = charsForTokens(normalized, config.maxTokens);
  const overlapChars = charsForTokens(normalized, config.overlapTokens);

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < normalized.length) {
    const targetEnd = Math.min(start + targetChars, normalized.length);
    const hardEnd = Math.min(start + maxChars, normalized.length);

    const end =
      hardEnd >= normalized.length
        ? normalized.length
        : chooseCut(boundaries, start, targetEnd, hardEnd);

    const content = normalized.slice(start, end).trim();

    if (content) {
      chunks.push({
        content,
        index: chunks.length,
        tokenCount: estimateTokens(content),
        offset: start,
      });
    }

    if (end >= normalized.length) break;

    // Step back for the overlap, but never by more than half the chunk just
    // emitted.
    //
    // Without the clamp, an overlap configured larger than the chunk size makes
    // `end - overlapChars` fall at or behind `start`, the `start + 1` floor takes
    // over, and the loop advances one character per iteration — emitting
    // thousands of near-identical chunks instead of looping forever. It
    // terminates, which is why it is easy to miss, and it would quietly multiply
    // the embedding bill for a document by a factor of hundreds.
    const progress = end - start;
    const effectiveOverlap = Math.min(overlapChars, Math.floor(progress / 2));
    start = Math.max(start + 1, end - effectiveOverlap);
  }

  return mergeUndersizedTail(chunks, config.minTokens);
}

/**
 * Folds a too-small final chunk into its predecessor.
 *
 * A 12-token trailing fragment — a signature line, a page number — embeds to a
 * vector that matches almost any query weakly, which is worse than not existing:
 * it displaces a real result.
 */
function mergeUndersizedTail(chunks: Chunk[], minTokens: number): Chunk[] {
  if (chunks.length < 2) return chunks;

  const last = chunks[chunks.length - 1];
  if (last.tokenCount >= minTokens) return chunks;

  const previous = chunks[chunks.length - 2];
  const merged: Chunk = {
    ...previous,
    content: `${previous.content}\n${last.content}`,
    tokenCount: estimateTokens(`${previous.content}\n${last.content}`),
  };

  return [...chunks.slice(0, -2), merged];
}

/**
 * Groups chunks into API batches.
 *
 * Bounded on both count and total tokens: OpenAI's embedding endpoint limits
 * each, and exceeding either rejects the whole batch rather than trimming it.
 */
export function batchChunks<T extends { tokenCount: number }>(
  chunks: T[],
  maxPerBatch = 96,
  maxTokensPerBatch = 250_000,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let tokens = 0;

  for (const chunk of chunks) {
    const wouldExceed =
      current.length >= maxPerBatch ||
      (current.length > 0 && tokens + chunk.tokenCount > maxTokensPerBatch);

    if (wouldExceed) {
      batches.push(current);
      current = [];
      tokens = 0;
    }

    current.push(chunk);
    tokens += chunk.tokenCount;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

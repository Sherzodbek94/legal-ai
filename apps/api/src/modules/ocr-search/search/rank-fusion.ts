/**
 * Combining lexical and semantic result lists.
 *
 * The two halves of a hybrid query produce scores that are not comparable:
 * `ts_rank` is an unbounded relevance number whose scale depends on document
 * length and term frequency, while cosine distance is bounded on [0, 2] and runs
 * the opposite direction. Normalising them onto a shared scale requires knowing
 * each distribution, which changes per query.
 *
 * Reciprocal Rank Fusion sidesteps that entirely by discarding the scores and
 * using only positions. That is its point: it needs no tuning per corpus, no
 * calibration between retrievers, and it cannot be broken by one retriever
 * returning scores on an unexpected scale.
 */

/**
 * RRF damping constant.
 *
 * 60 is the value from the original Cormack et al. (2009) paper and the de facto
 * default. It controls how sharply rank 1 outranks rank 2: a small k makes the
 * top hit dominate, a large k flattens the list toward equality. 60 is flat
 * enough that a result found by *both* retrievers at middling rank can outrank
 * one found by a single retriever at rank 1 — which is the behaviour hybrid
 * search exists to get.
 */
export const RRF_K = 60;

export interface RankedResult {
  id: string;
  /** The retriever's own score, carried through for display and debugging. */
  score: number;
}

export interface FusedResult {
  id: string;
  /** Combined RRF score. Comparable within one query only, never across queries. */
  rrfScore: number;
  /** 1-based rank in the lexical list; null when absent from it. */
  lexicalRank: number | null;
  /** 1-based rank in the semantic list; null when absent from it. */
  semanticRank: number | null;
  lexicalScore: number | null;
  semanticScore: number | null;
  /** True when both retrievers found it — a strong signal on its own. */
  matchedBoth: boolean;
}

export interface FusionWeights {
  /** Multiplier on the lexical contribution. */
  lexical?: number;
  /** Multiplier on the semantic contribution. */
  semantic?: number;
  k?: number;
}

/**
 * One retriever's contribution at a given rank.
 *
 * Rank is 1-based: at rank 1 with k=60 this is 1/61, and the increments shrink
 * smoothly from there.
 */
export function rrfContribution(rank: number, k = RRF_K): number {
  if (rank < 1) return 0;
  return 1 / (k + rank);
}

/**
 * Fuses two ranked lists.
 *
 * Weights default to 1 each. They exist because the right balance is corpus- and
 * language-dependent: on this corpus the lexical half is weaker than usual —
 * `simple` configuration means no stemming, so a morphological variant simply
 * does not match — which is an argument for weighting semantic slightly higher
 * on Uzbek queries. The default stays neutral rather than encoding a guess.
 */
export function fuseRankings(
  lexical: RankedResult[],
  semantic: RankedResult[],
  weights: FusionWeights = {},
): FusedResult[] {
  const lexicalWeight = weights.lexical ?? 1;
  const semanticWeight = weights.semantic ?? 1;
  const k = weights.k ?? RRF_K;

  const merged = new Map<string, FusedResult>();

  const ensure = (id: string): FusedResult => {
    const existing = merged.get(id);
    if (existing) return existing;

    const created: FusedResult = {
      id,
      rrfScore: 0,
      lexicalRank: null,
      semanticRank: null,
      lexicalScore: null,
      semanticScore: null,
      matchedBoth: false,
    };
    merged.set(id, created);
    return created;
  };

  lexical.forEach((result, index) => {
    const rank = index + 1;
    const entry = ensure(result.id);
    entry.lexicalRank = rank;
    entry.lexicalScore = result.score;
    entry.rrfScore += lexicalWeight * rrfContribution(rank, k);
  });

  semantic.forEach((result, index) => {
    const rank = index + 1;
    const entry = ensure(result.id);
    entry.semanticRank = rank;
    entry.semanticScore = result.score;
    entry.rrfScore += semanticWeight * rrfContribution(rank, k);
  });

  for (const entry of merged.values()) {
    entry.matchedBoth = entry.lexicalRank !== null && entry.semanticRank !== null;
  }

  return [...merged.values()].sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    // Deterministic tie-break. Without it, equal-scoring results come back in
    // Map insertion order, which makes pagination unstable between calls.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Cosine distance to a similarity in [0, 1].
 *
 * pgvector's `<=>` returns distance on [0, 2], where 0 is identical. Presenting
 * that to a user inverted and unbounded is needlessly confusing, so it is
 * converted once at the boundary.
 */
export function distanceToSimilarity(distance: number): number {
  const similarity = 1 - distance / 2;
  return Math.min(1, Math.max(0, similarity));
}

/**
 * Collapses chunk hits into one hit per document.
 *
 * Without this, a long document with the same clause repeated in three sections
 * occupies the first three result slots and buries every other document. The
 * document keeps its best chunk's score — the strongest passage is what makes it
 * relevant — and the remaining matches are retained as supporting context rather
 * than as separate results.
 */
export function groupByDocument<
  T extends { id: string; rrfScore: number },
>(
  results: T[],
  documentIdOf: (result: T) => string,
  maxChunksPerDocument = 3,
): { documentId: string; best: T; chunks: T[]; score: number }[] {
  const byDocument = new Map<string, T[]>();

  for (const result of results) {
    const documentId = documentIdOf(result);
    const bucket = byDocument.get(documentId);
    if (bucket) bucket.push(result);
    else byDocument.set(documentId, [result]);
  }

  return [...byDocument.entries()]
    .map(([documentId, chunks]) => ({
      documentId,
      best: chunks[0],
      chunks: chunks.slice(0, maxChunksPerDocument),
      score: chunks[0].rrfScore,
    }))
    .sort((a, b) => b.score - a.score);
}

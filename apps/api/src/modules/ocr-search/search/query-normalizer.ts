/**
 * Turning a user's query into something both retrievers can use.
 *
 * The lexical side needs a `tsquery`, and building one by string concatenation is
 * an injection hazard: `plainto_tsquery` is safe because it treats its input as
 * plain text, but anything hand-assembling `&` and `:*` operators is parsing
 * untrusted input into an operator expression. Prefix matching is wanted here —
 * `simple` configuration does no stemming, so `shartnoma` should still find
 * `shartnomaning` — which means the operators have to be built. They are built
 * from tokens that have had every operator character stripped first.
 */
import { normalizeUzbekApostrophes } from '../ocr/ocr-language';

export interface NormalizedQuery {
  /** Cleaned text, for the embedding call. */
  semantic: string;
  /** A `tsquery` expression safe to interpolate. */
  tsquery: string;
  /** Tokens kept, for highlighting and diagnostics. */
  tokens: string[];
  /** True when nothing usable survived normalisation. */
  empty: boolean;
}

/**
 * Everything with meaning in tsquery syntax, plus quotes and backslashes.
 *
 * Stripped rather than escaped. A user typing `&` in a legal search means the
 * word "and", not a boolean operator, and there is no reading of `!` in a search
 * box that should negate a term.
 */
const TSQUERY_OPERATORS = /[&|!():*<>'"\\]/g;

/** Shortest token worth indexing on. */
const MIN_TOKEN_LENGTH = 2;

/** Cap on tokens, so a pasted page does not become a 400-clause tsquery. */
const MAX_TOKENS = 24;

/**
 * Very common words in the three languages of this corpus.
 *
 * Deliberately short. `simple` configuration applies no stopword list, so
 * without this a query like "договор о поставке товара" spends most of its
 * selectivity on "о". It is not a full stoplist — over-removing hurts more than
 * under-removing when the corpus is small.
 */
const STOPWORDS = new Set([
  // Russian
  'и', 'в', 'на', 'о', 'об', 'с', 'по', 'для', 'от', 'до', 'при', 'за', 'к',
  'из', 'не', 'что', 'как', 'а', 'но',
  // Uzbek
  'va', 'bilan', 'uchun', 'ham', 'bu', 'shu', 'yoki', 'lekin',
  // English
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by',
  'is', 'are', 'be',
]);

export function normalizeQuery(raw: string): NormalizedQuery {
  const cleaned = normalizeUzbekApostrophes(raw ?? '')
    .replace(TSQUERY_OPERATORS, ' ')
    // Control and zero-width characters: invisible in a search box, and they
    // would silently prevent any match.
    .replace(new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F]', 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return { semantic: '', tsquery: '', tokens: [], empty: true };
  }

  const allTokens = cleaned
    .toLowerCase()
    .split(/[\s.,;:/\\\-—–]+/)
    .filter(Boolean);

  let tokens = allTokens.filter(
    (token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token),
  );

  // If stopword removal emptied the query, the user searched only for stopwords.
  // Honour that literally rather than returning nothing.
  if (tokens.length === 0) {
    tokens = allTokens.filter((token) => token.length >= MIN_TOKEN_LENGTH);
  }

  tokens = tokens.slice(0, MAX_TOKENS);

  if (tokens.length === 0) {
    // Semantic search can still work on a query too short to tokenise — a
    // two-character query, or one that was entirely punctuation.
    return { semantic: cleaned, tsquery: '', tokens: [], empty: false };
  }

  // AND-of-prefixes. AND rather than OR because a legal search for three terms
  // means all three; OR returns every document containing the commonest one.
  // The `:*` prefix operator substitutes for the stemming `simple` does not do.
  const tsquery = tokens.map((token) => `${token}:*`).join(' & ');

  return { semantic: cleaned, tsquery, tokens, empty: false };
}

/**
 * A progressively looser variant, for when the strict AND query returns nothing.
 *
 * Searching "supply contract cement Tashkent" and getting zero results because
 * one document says "Toshkent" is a bad experience. The fallback ORs the terms so
 * partial matches surface, and RRF then ranks documents matching more terms
 * higher anyway.
 */
export function relaxQuery(query: NormalizedQuery): string {
  if (query.tokens.length === 0) return '';
  return query.tokens.map((token) => `${token}:*`).join(' | ');
}

/**
 * Formats a vector literal for pgvector.
 *
 * Values are validated numerically before interpolation. This string is
 * concatenated into SQL — a parameter placeholder cannot be used for a vector
 * literal in Prisma's raw API — so the guarantee that nothing but finite numbers
 * reaches it has to come from here.
 */
export function toVectorLiteral(embedding: number[]): string {
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Embedding contains a non-finite value');
    }
  }
  return `[${embedding.join(',')}]`;
}

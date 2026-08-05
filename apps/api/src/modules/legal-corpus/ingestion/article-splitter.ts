/**
 * Splitting a normative act into its articles.
 *
 * This is the one piece of chunking that is worth writing by hand rather than
 * reusing `chunkText`. An article is the unit a lawyer cites — "Fuqarolik
 * kodeksining 347-moddasi" — so a chunk that corresponds to exactly one article
 * yields a citation that is exact rather than approximate, and a retrieved
 * passage that answers the whole question rather than the half that happened to
 * fall on one side of a 512-token boundary.
 *
 * Pure functions, no database and no API key: the splitter is the part most
 * likely to need tuning against real texts, and tuning it should cost nothing.
 */
import { chunkText, estimateTokens } from '../../ocr-search/embedding/chunking';

export interface ArticleChunk {
  /** The article number as it should be cited, e.g. `347` or `347-1`. */
  articleLabel: string | null;
  /** 1-based part, when one article had to be split further. Null if whole. */
  articlePart: number | null;
  content: string;
  tokenCount: number;
}

/**
 * Article headings, across the forms Uzbek legal texts actually use.
 *
 * Four alphabets' worth of variation, all of which occur:
 *
 *   `347-modda.`            Uzbek Latin
 *   `347-модда.`            Uzbek Cyrillic
 *   `Статья 347.`           Russian
 *   `Article 347.`          English translations
 *
 * `347-1-modda` is a real and common form — an article inserted between 347 and
 * 348 by a later amendment — so the number pattern has to admit a suffix, and
 * the citation has to preserve it. Treating `347-1` as `347` would merge an
 * inserted article into its neighbour and cite both as the same provision.
 *
 * Anchored to a line start because these strings also appear mid-sentence as
 * cross-references ("...ushbu Kodeksning 347-moddasida nazarda tutilgan..."),
 * and splitting on those would cut an article in half at every reference to
 * another one.
 */
const ARTICLE_HEADING =
  /^[ \t]*(?:(\d+(?:-\d+)?)[-–—]\s*(?:modda|модда)|(?:статья|article)\s+(\d+(?:-\d+)?))\s*[.．:]?/gim;

/** Tokens above which a single article is split further. */
const MAX_ARTICLE_TOKENS = 800;

/**
 * Splits an act into per-article passages.
 *
 * Falls back to plain length-based chunking when the text exposes no article
 * headings at all — many resolutions and instructions are written as numbered
 * paragraphs rather than articles, and those are still worth indexing. The
 * fallback is signalled by `articleLabel: null`, which the citation layer reads
 * as "cite the act, not an article".
 */
export function splitIntoArticles(text: string): ArticleChunk[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const headings = [...normalized.matchAll(ARTICLE_HEADING)];

  if (headings.length === 0) {
    return chunkText(normalized).map((chunk) => ({
      articleLabel: null,
      articlePart: null,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
    }));
  }

  const chunks: ArticleChunk[] = [];

  // Anything before the first heading is the preamble — the act's title, its
  // adopting body, its date. Kept: a question like "when did the Civil Code
  // come into force" is answered there and nowhere else.
  const preamble = normalized.slice(0, headings[0].index).trim();
  if (preamble) {
    chunks.push(...asChunks(null, preamble));
  }

  for (const [position, heading] of headings.entries()) {
    const label = heading[1] ?? heading[2] ?? null;
    const start = heading.index;
    const end = headings[position + 1]?.index ?? normalized.length;

    // The heading itself stays in the body. A passage that begins "347-modda.
    // Qarzni hisobga olish" carries its own identity into the embedding, so a
    // semantic query naming the article can match on more than the number.
    const body = normalized.slice(start, end).trim();
    if (!body) continue;

    chunks.push(...asChunks(label, body));
  }

  return chunks;
}

/**
 * One article to one chunk, unless it is too long.
 *
 * A handful of articles — procedural codes especially — run to several pages,
 * past what an embedding can represent usefully. Those are split further and
 * numbered, so a citation can still say which part of the article a passage
 * came from rather than silently pointing at all of it.
 */
function asChunks(label: string | null, body: string): ArticleChunk[] {
  const tokenCount = estimateTokens(body);

  if (tokenCount <= MAX_ARTICLE_TOKENS) {
    return [{ articleLabel: label, articlePart: null, content: body, tokenCount }];
  }

  const parts = chunkText(body, { targetTokens: 512, maxTokens: MAX_ARTICLE_TOKENS });

  return parts.map((part, index) => ({
    articleLabel: label,
    // 1-based: "part 1 of 3" reads correctly to a person, unlike "part 0".
    articlePart: index + 1,
    content: part.content,
    tokenCount: part.tokenCount,
  }));
}

/**
 * Collapses the artefacts of extracted text without destroying structure.
 *
 * Line breaks are load-bearing here — the article heading pattern is anchored
 * to them — so runs of blank lines are collapsed to one rather than to a space,
 * and single newlines are left alone. Non-breaking spaces and the soft hyphens
 * that survive PDF extraction are removed, because they otherwise sit between a
 * number and `-modda` and stop the heading matching at all.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Renders a citation for a retrieved passage.
 *
 * Built here rather than in the UI so every surface that shows a source — the
 * search results, an AI answer, a generated document's footnotes — spells it
 * the same way. A citation that reads differently in two places invites the
 * reader to wonder whether it is the same provision.
 */
export function formatCitation(act: CitableAct, chunk: CitableChunk): string {
  const parts: string[] = [act.title];

  if (chunk.articleLabel) {
    parts.push(`${chunk.articleLabel}-modda`);
    if (chunk.articlePart !== null && chunk.articlePart !== undefined) {
      parts.push(`(${chunk.articlePart}-qism)`);
    }
  }

  return parts.join(', ');
}

export interface CitableAct {
  title: string;
}

export interface CitableChunk {
  articleLabel: string | null;
  articlePart?: number | null;
}

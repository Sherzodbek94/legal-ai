import type { LegalActStatus, LegalActType } from '@legaltech/database';

/**
 * Where legislation comes from.
 *
 * An interface for the same reason the counterparty registry has one: the
 * source is the part most likely to change, and none of the pipeline above it —
 * the article splitter, the embedder, the search — should care. lex.uz is the
 * sole official publisher, but it documents no API, so the route into it will
 * be whatever this deployment can lawfully obtain: a bulk export agreed with
 * the Adolat centre, an open-data set, or a directory of files.
 */

/** One act, as a source hands it over. */
export interface SourceAct {
  /** The source's own identifier. Stable across re-ingests. */
  externalId: string;
  url?: string;
  type: LegalActType;
  number?: string;
  title: string;
  /** BCP 47: `uz-Latn`, `uz-Cyrl`, `ru`. */
  language: string;
  adoptedAt?: Date;
  effectiveFrom?: Date;
  status: LegalActStatus;
  /**
   * Version marker.
   *
   * The single most valuable field a source can supply. Legislation changes
   * rarely, and re-embedding an unchanged code is the most expensive no-op
   * available here — a hash of the text is enough when the source offers
   * nothing better.
   */
  revision?: string;
  content: string;
}

export interface LegalCorpusSource {
  /** Recorded on every act, e.g. `lex.uz` or `files`. */
  readonly name: string;

  isConfigured(): boolean;

  /**
   * Yields acts one at a time.
   *
   * An async iterator rather than an array: the corpus is the whole statute
   * book, and a source that has to materialise all of it before the first row
   * is written cannot be resumed and cannot be watched.
   */
  acts(): AsyncIterable<SourceAct>;
}

/** DI token; the interface itself cannot be one. */
export const LEGAL_CORPUS_SOURCE = Symbol('LEGAL_CORPUS_SOURCE');

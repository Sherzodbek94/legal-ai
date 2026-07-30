/**
 * Language selection for Tesseract.
 *
 * Uzbek is the hard case and the reason this file exists. It is written in two
 * scripts that are both in current official use — Latin since the 1993 reform,
 * Cyrillic still pervasive in older records, court files, and anything produced
 * by an older government system — and Tesseract ships them as two separate
 * models (`uzb`, `uzb_cyrl`). Loading the wrong one does not fail; it returns
 * confident garbage.
 *
 * So the script is detected from the document, not configured per tenant, and
 * Russian is loaded alongside Uzbek by default because Uzbek legal documents
 * routinely contain Russian passages — bank details, counterparty names, quoted
 * regulation — inside otherwise Uzbek text.
 */

/** Tesseract traineddata identifiers. */
export const TESSERACT_LANGUAGES = {
  UZBEK_LATIN: 'uzb',
  UZBEK_CYRILLIC: 'uzb_cyrl',
  RUSSIAN: 'rus',
  ENGLISH: 'eng',
} as const;

export type TesseractLanguage =
  (typeof TESSERACT_LANGUAGES)[keyof typeof TESSERACT_LANGUAGES];

export type DetectedScript = 'cyrillic' | 'latin' | 'mixed' | 'unknown';

/**
 * Characters that appear in Uzbek Latin but not in English.
 *
 * `oʻ` and `gʻ` use U+02BB (modifier letter turned comma) in correct
 * orthography, but real documents use an apostrophe, a backtick, or U+2018
 * interchangeably. All of them are treated as the same signal.
 */
const UZBEK_LATIN_MARKERS = /[ʻʼ‘’'`]/;

const CYRILLIC = /[Ѐ-ӿ]/g;
const LATIN = /[A-Za-z]/g;

/**
 * Letters specific to Uzbek Cyrillic that Russian does not use.
 *
 * ў, қ, ғ, ҳ. Their presence distinguishes Uzbek Cyrillic from Russian, which
 * matters because the two are otherwise hard to tell apart by character set
 * alone.
 */
const UZBEK_CYRILLIC_MARKERS = /[ўқғҳЎҚҒҲ]/;

export interface ScriptAnalysis {
  script: DetectedScript;
  cyrillicRatio: number;
  latinRatio: number;
  /** True when Uzbek-specific Cyrillic letters are present. */
  hasUzbekCyrillic: boolean;
  /** True when Uzbek Latin apostrophe conventions are present. */
  hasUzbekLatin: boolean;
}

/**
 * Classifies a text sample by script.
 *
 * Ratios are over letters only — digits, punctuation, and whitespace dominate
 * legal documents (dates, account numbers, article references) and counting them
 * would flatten the signal this is trying to read.
 */
export function analyzeScript(sample: string): ScriptAnalysis {
  const cyrillicCount = (sample.match(CYRILLIC) ?? []).length;
  const latinCount = (sample.match(LATIN) ?? []).length;
  const letters = cyrillicCount + latinCount;

  if (letters === 0) {
    return {
      script: 'unknown',
      cyrillicRatio: 0,
      latinRatio: 0,
      hasUzbekCyrillic: false,
      hasUzbekLatin: false,
    };
  }

  const cyrillicRatio = cyrillicCount / letters;
  const latinRatio = latinCount / letters;

  // 15% is deliberately low. A page of Uzbek Latin with one Russian bank block
  // is mixed, and treating it as pure Latin loses that block entirely.
  const MIXED_THRESHOLD = 0.15;

  let script: DetectedScript;
  if (cyrillicRatio >= MIXED_THRESHOLD && latinRatio >= MIXED_THRESHOLD) {
    script = 'mixed';
  } else if (cyrillicRatio > latinRatio) {
    script = 'cyrillic';
  } else {
    script = 'latin';
  }

  return {
    script,
    cyrillicRatio,
    latinRatio,
    hasUzbekCyrillic: UZBEK_CYRILLIC_MARKERS.test(sample),
    hasUzbekLatin: UZBEK_LATIN_MARKERS.test(sample),
  };
}

/**
 * Language set to load, given a script analysis.
 *
 * Errs toward loading more models than strictly needed. An extra language costs
 * memory and some accuracy from a larger candidate space; a missing one costs
 * the text outright, and there is no way to tell from the output that it
 * happened.
 */
export function languagesForScript(analysis: ScriptAnalysis): TesseractLanguage[] {
  const { UZBEK_LATIN, UZBEK_CYRILLIC, RUSSIAN, ENGLISH } = TESSERACT_LANGUAGES;

  switch (analysis.script) {
    case 'cyrillic':
      // Russian always accompanies Uzbek Cyrillic: the two share almost the
      // whole alphabet and documents mix them freely.
      return analysis.hasUzbekCyrillic
        ? [UZBEK_CYRILLIC, RUSSIAN]
        : [RUSSIAN, UZBEK_CYRILLIC];

    case 'latin':
      return [UZBEK_LATIN, ENGLISH];

    case 'mixed':
      return [UZBEK_LATIN, UZBEK_CYRILLIC, RUSSIAN, ENGLISH];

    case 'unknown':
    default:
      // Nothing to go on — a pure scan with no text layer to sample. Load the
      // full set and let Tesseract decide.
      return [UZBEK_LATIN, UZBEK_CYRILLIC, RUSSIAN, ENGLISH];
  }
}

/** Tesseract's `+`-joined language parameter. */
export function toTesseractParam(languages: TesseractLanguage[]): string {
  return languages.join('+');
}

/**
 * Confidence floor below which text is flagged rather than trusted.
 *
 * 60 is low by Tesseract's scale but appropriate for this corpus: these are
 * photocopied, stamped, and faxed documents, and holding out for 80 would reject
 * most of a real archive. Below 60 the output is typically unusable enough that
 * a human needs to look, which is what LOW_CONFIDENCE signals — not a failure,
 * a caveat.
 */
export const CONFIDENCE_FLOOR = 60;

export function isConfidenceAcceptable(confidence: number | null): boolean {
  if (confidence === null) return true; // Text-layer extraction; nothing guessed.
  return confidence >= CONFIDENCE_FLOOR;
}

/**
 * Normalises Uzbek Latin apostrophes to one form.
 *
 * `oʻzbek`, `o'zbek`, and `o`zbek` are the same word typed three ways, and
 * without this they are three different search tokens. Applied to both indexed
 * text and queries, so the two always agree.
 */
export function normalizeUzbekApostrophes(text: string): string {
  return text.replace(/[ʻʼ‘’`]/g, "'");
}

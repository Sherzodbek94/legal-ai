/**
 * Personal and financial identifiers in Uzbek legal documents.
 *
 * Pure functions, no dependencies. Two callers with different needs share them:
 * the redactor that strips values before document text leaves for an LLM, and
 * the reviewer-facing scan that lists what a document is carrying before it is
 * exported or sent to a counterparty.
 *
 * ## The design problem
 *
 * Most Uzbek identifiers are bare digit strings of a fixed length, and legal
 * documents are full of bare digit strings that are not identifiers — contract
 * numbers, sums of money, dates, article references. A detector matching "nine
 * digits" would redact the amount payable out of every contract it touched.
 *
 * So each pattern below is anchored on something more than length:
 *
 *   * a **label** in one of the four spellings that occur (Uzbek Latin, Uzbek
 *     Cyrillic, Russian, English), for the identifiers that are otherwise
 *     ambiguous — STIR, PINFL, account numbers;
 *   * a **structural signature** where one exists — a passport's two letters,
 *     a phone's country code, an email's `@`;
 *   * a **checksum** where one exists — Luhn, for payment cards.
 *
 * The bias is deliberate and one-directional: a missed identifier is a leak,
 * and a false positive is a redacted contract number. Both are bad, but only
 * the first is irreversible, so ambiguous patterns are anchored tightly rather
 * than left greedy — and the ones with no anchor at all are not detected.
 */

export type PiiKind =
  | 'STIR'
  | 'PINFL'
  | 'PASSPORT'
  | 'BANK_ACCOUNT'
  | 'CARD'
  | 'PHONE'
  | 'EMAIL';

export interface PiiMatch {
  kind: PiiKind;
  /** The identifier itself, without any label that anchored it. */
  value: string;
  /** Character offset of `value` in the source text. */
  start: number;
  end: number;
}

/**
 * Label spellings that precede an identifier.
 *
 * Written once per identifier rather than as one shared list: STIR and PINFL
 * are both nine-to-fourteen digit strings, and a shared label alternation would
 * let a "STIR:" label claim a PINFL-length number and mislabel it in the
 * reviewer's report.
 */
const STIR_LABEL = String.raw`(?:STIR|СТИР|ИНН|INN|Soliq\s+to['’]?lovchi(?:ning)?\s+identifikatsiya\s+raqami)`;
const PINFL_LABEL = String.raw`(?:JSHSHIR|ЖШШИР|ПИНФЛ|PINFL|Jismoniy\s+shaxsning\s+shaxsiy\s+identifikatsiya\s+raqami)`;
const ACCOUNT_LABEL = String.raw`(?:h[\/\.]?\s*r|hisob\s+raqam(?:i|ы)?|х[\/\.]?\s*с|расчетный\s+счет|р[\/\.]?\s*с|account)`;

/** Separator between a label and its value: colon, dash, or just space. */
const SEP = String.raw`\s*[:№#\-–—]?\s*`;

/**
 * Word boundaries that work in Cyrillic.
 *
 * `\b` in JavaScript is defined against ASCII `\w`, so every Cyrillic letter
 * counts as a non-word character to it. `\bАА1234567` therefore never matches
 * after a Cyrillic word — which is precisely the case a passport number typed
 * in a Cyrillic layout arrives in. Explicit lookarounds over both alphabets
 * are correct where `\b` silently is not.
 */
const NOT_ALNUM_BEFORE = String.raw`(?<![A-Za-zА-Яа-яЁё0-9])`;
const NOT_ALNUM_AFTER = String.raw`(?![A-Za-zА-Яа-яЁё0-9])`;

/**
 * Digits with the grouping people actually type.
 *
 * `2020 8000 9000 0123 4567` and `20208000900001234567` are the same account,
 * and a pattern that only matched the second would miss most of the real ones.
 */
const grouped = (count: number) =>
  String.raw`(\d(?:[\s-]?\d){${count - 1}})`;

const PATTERNS: { kind: PiiKind; regex: RegExp; group: number }[] = [
  /**
   * STIR — nine digits. Label-anchored, because nine bare digits in a contract
   * is at least as often a sum in so'm.
   */
  {
    kind: 'STIR',
    regex: new RegExp(`${STIR_LABEL}${SEP}${grouped(9)}`, 'gi'),
    group: 1,
  },
  /** PINFL — fourteen digits, label-anchored for the same reason. */
  {
    kind: 'PINFL',
    regex: new RegExp(`${PINFL_LABEL}${SEP}${grouped(14)}`, 'gi'),
    group: 1,
  },
  /**
   * Settlement account — twenty digits, label-anchored.
   *
   * Detected as PII even though it is a company's rather than a person's: it is
   * the field that moves money, and a leaked account number is the one on this
   * list somebody can act on directly.
   */
  {
    kind: 'BANK_ACCOUNT',
    regex: new RegExp(`${ACCOUNT_LABEL}${SEP}${grouped(20)}`, 'gi'),
    group: 1,
  },
  /**
   * Passport — two Latin or Cyrillic letters and seven digits, e.g. `AA1234567`.
   *
   * Needs no label: the shape occurs in nothing else. Cyrillic `АА` is included
   * because Uzbek passports are printed with Latin letters that get retyped in
   * Cyrillic by anyone working in a Cyrillic layout, and the two are visually
   * identical.
   */
  {
    kind: 'PASSPORT',
    regex: new RegExp(
      `${NOT_ALNUM_BEFORE}([A-ZА-Я]{2}\\s?\\d{7})${NOT_ALNUM_AFTER}`,
      'g',
    ),
    group: 1,
  },
  /**
   * Payment card — sixteen digits, Luhn-checked in `findPii`.
   *
   * The checksum is what makes this safe to detect without a label: a random
   * sixteen-digit contract number passes Luhn about one time in ten, and a
   * genuine card always does.
   */
  {
    kind: 'CARD',
    regex: new RegExp(
      `${NOT_ALNUM_BEFORE}${grouped(16)}${NOT_ALNUM_AFTER}`,
      'g',
    ),
    group: 1,
  },
  /** Phone — anchored on the +998 country code or a 998 prefix. */
  {
    kind: 'PHONE',
    regex: /(\+?998[\s-]?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2})/g,
    group: 1,
  },
  {
    kind: 'EMAIL',
    regex: new RegExp(
      `${NOT_ALNUM_BEFORE}([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})${NOT_ALNUM_AFTER}`,
      'g',
    ),
    group: 1,
  },
];

/**
 * Every identifier in a piece of text, in the order it appears.
 *
 * Overlapping matches are resolved in favour of the earlier and then the
 * longer one — a labelled twenty-digit account also contains a sixteen-digit
 * run that could pass Luhn, and reporting both would have a reviewer chasing a
 * card that does not exist.
 */
export function findPii(text: string): PiiMatch[] {
  if (!text) return [];

  const found: PiiMatch[] = [];

  for (const { kind, regex, group } of PATTERNS) {
    // Fresh lastIndex per call: these are module-level `g` regexes and would
    // otherwise resume mid-string on the second document.
    regex.lastIndex = 0;

    for (const match of text.matchAll(regex)) {
      const value = match[group];
      if (!value) continue;

      if (kind === 'CARD' && !passesLuhn(value)) continue;

      const start = match.index + match[0].indexOf(value);

      found.push({ kind, value, start, end: start + value.length });
    }
  }

  return dropOverlaps(found);
}

/**
 * Keeps the earlier match, and the longer one where they start together.
 *
 * Length breaks the tie rather than pattern order, so a twenty-digit account
 * beats the sixteen-digit card-shaped substring inside it regardless of which
 * pattern happened to be declared first.
 */
function dropOverlaps(matches: PiiMatch[]): PiiMatch[] {
  const sorted = [...matches].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );

  const kept: PiiMatch[] = [];
  let cursor = -1;

  for (const match of sorted) {
    if (match.start < cursor) continue;
    kept.push(match);
    cursor = match.end;
  }

  return kept;
}

/**
 * The Luhn check digit, as used by every payment card scheme.
 *
 * Uzcard and Humo (`8600`, `9860`) follow it like Visa and Mastercard do, so
 * one implementation covers the local schemes and the international ones.
 */
export function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 12) return false;

  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;

    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

import { findPii, type PiiKind, type PiiMatch } from './pii-patterns';

export interface Redaction {
  /** The placeholder that replaced the value, e.g. `[STIR_1]`. */
  placeholder: string;
  kind: PiiKind;
  /** What a reviewer sees. Never the whole value. */
  masked: string;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
  /** Nothing was found; the text is unchanged. */
  clean: boolean;
}

/**
 * Replaces identifiers with stable placeholders before text leaves the system.
 *
 * The case this exists for: document text is sent to Anthropic or OpenAI to be
 * drafted or analysed, and that text routinely carries a client's passport
 * number, a settlement account, and a director's phone. None of it is needed
 * for the model to do its job — a contract clause is drafted the same way
 * whether the account number is real or `[BANK_ACCOUNT_1]` — so sending it is
 * a disclosure with no benefit.
 *
 * ## Why placeholders and not deletion
 *
 * The model has to be able to write the value back into the position it
 * belongs. Deleting it leaves the model to invent something for the gap, which
 * is exactly what `legal-system-prompt.ts` already forbids in words; a
 * placeholder makes it structurally unnecessary. `restore` then puts the real
 * values back into the model's output.
 *
 * ## Stability
 *
 * The same value gets the same placeholder throughout one document. Two
 * mentions of one account number must not become `[BANK_ACCOUNT_1]` and
 * `[BANK_ACCOUNT_2]`, or the model reasoning about "the same account" sees two.
 */
export function redactPii(text: string): RedactionResult {
  const matches = findPii(text);

  if (matches.length === 0) {
    return { text, redactions: [], clean: true };
  }

  const placeholderByValue = new Map<string, string>();
  const countByKind = new Map<PiiKind, number>();
  const redactions: Redaction[] = [];

  for (const match of matches) {
    // Keyed on the normalised digits, not the raw text: `8600 1234 5678 9012`
    // and `8600123456789012` are one card and must share one placeholder.
    const key = `${match.kind}:${normalize(match.value)}`;

    if (!placeholderByValue.has(key)) {
      const next = (countByKind.get(match.kind) ?? 0) + 1;
      countByKind.set(match.kind, next);

      const placeholder = `[${match.kind}_${next}]`;
      placeholderByValue.set(key, placeholder);

      redactions.push({
        placeholder,
        kind: match.kind,
        masked: maskValue(match.kind, match.value),
      });
    }
  }

  // Applied back-to-front so each replacement leaves the offsets of the ones
  // before it untouched.
  let redacted = text;

  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    const placeholder = placeholderByValue.get(
      `${match.kind}:${normalize(match.value)}`,
    )!;

    redacted =
      redacted.slice(0, match.start) + placeholder + redacted.slice(match.end);
  }

  return { text: redacted, redactions, clean: false };
}

/**
 * Puts the real values back into text that came out of the model.
 *
 * Takes the original text rather than a value map, so the caller never has to
 * hold a copy of the identifiers anywhere a log or an error report could reach
 * — `redactPii` returns only masked forms for exactly that reason.
 *
 * A placeholder the model invented, or one it corrupted, is left as-is rather
 * than guessed at. Text reading `[STIR_9]` where no ninth STIR existed is a
 * visible defect a reviewer will catch; silently substituting the nearest real
 * STIR would be an invisible one.
 */
export function restorePii(redactedOutput: string, originalText: string): string {
  const matches = findPii(originalText);
  if (matches.length === 0) return redactedOutput;

  const valueByPlaceholder = new Map<string, string>();
  const countByKind = new Map<PiiKind, number>();
  const seen = new Set<string>();

  // Rebuilt by replaying the same walk `redactPii` did, so the numbering is
  // identical by construction rather than by two implementations agreeing.
  for (const match of matches) {
    const key = `${match.kind}:${normalize(match.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const next = (countByKind.get(match.kind) ?? 0) + 1;
    countByKind.set(match.kind, next);

    valueByPlaceholder.set(`[${match.kind}_${next}]`, match.value);
  }

  return redactedOutput.replace(
    /\[(?:STIR|PINFL|PASSPORT|BANK_ACCOUNT|CARD|PHONE|EMAIL)_\d+\]/g,
    (placeholder) => valueByPlaceholder.get(placeholder) ?? placeholder,
  );
}

/** Digits and letters only, lowercased — the same identifier written two ways. */
function normalize(value: string): string {
  return value.replace(/[^A-Za-zА-Яа-я0-9]/g, '').toLowerCase();
}

/**
 * What a reviewer is shown.
 *
 * Enough to recognise which identifier is meant, never enough to reconstruct
 * it. This string is safe to log and safe to put in an API response; the raw
 * value is neither, which is why nothing else here returns one.
 */
export function maskValue(kind: PiiKind, value: string): string {
  if (kind === 'EMAIL') {
    const [local, domain] = value.split('@');
    const head = local.slice(0, 1);
    return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
  }

  const compact = value.replace(/\s/g, '');
  const tail = compact.slice(-4);

  return `${'*'.repeat(Math.max(0, compact.length - 4))}${tail}`;
}

/** Groups matches by kind, for a reviewer-facing summary. */
export function summarizePii(matches: PiiMatch[]): Record<string, number> {
  const summary: Record<string, number> = {};
  const seen = new Set<string>();

  for (const match of matches) {
    const key = `${match.kind}:${normalize(match.value)}`;
    // Counts distinct identifiers, not mentions. "3 phone numbers" is what a
    // reviewer needs; "11 occurrences" is noise.
    if (seen.has(key)) continue;
    seen.add(key);

    summary[match.kind] = (summary[match.kind] ?? 0) + 1;
  }

  return summary;
}

import { extractJson } from './json-extraction';
import type {
  LegalDocumentDraft,
  LegalDocumentSection,
} from '../schemas/legal-document.schema';

export type LegalDocumentParseResult =
  | { ok: true; document: LegalDocumentDraft; repaired: boolean }
  | { ok: false; error: string; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerces to a string array, dropping non-strings rather than failing. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseSections(value: unknown, issues: string[]): LegalDocumentSection[] {
  if (!Array.isArray(value)) {
    issues.push('sections: expected an array');
    return [];
  }

  const sections: LegalDocumentSection[] = [];

  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push(`sections[${index}]: expected an object`);
      return;
    }

    const heading = entry.heading;
    const body = entry.body;

    if (typeof heading !== 'string' || !heading.trim()) {
      issues.push(`sections[${index}].heading: expected a non-empty string`);
      return;
    }
    if (typeof body !== 'string') {
      issues.push(`sections[${index}].body: expected a string`);
      return;
    }

    // `order` is advisory — models often omit or mis-number it, and array
    // position is the reliable signal. Fall back rather than reject the draft.
    const rawOrder = entry.order;
    const order =
      typeof rawOrder === 'number' && Number.isInteger(rawOrder) && rawOrder > 0
        ? rawOrder
        : index + 1;

    sections.push({ heading, body, order });
  });

  return sections;
}

/**
 * Validates raw model output into a `LegalDocumentDraft`.
 *
 * Structural requirements (a title, at least one usable section) are enforced
 * strictly — a draft missing those is not a document. Advisory metadata
 * (`order`, `missingFields`, `reviewNotes`) is coerced, because discarding an
 * otherwise-complete contract over a malformed notes array would be the wrong
 * trade for the user.
 */
export function parseLegalDocument(raw: string): LegalDocumentParseResult {
  const extracted = extractJson(raw);

  if (!extracted.ok) {
    return {
      ok: false,
      error: extracted.error,
      issues: [extracted.detail],
    };
  }

  const data = extracted.value;
  const issues: string[] = [];

  if (!isRecord(data)) {
    return {
      ok: false,
      error: 'invalid-shape',
      issues: ['Root value is not a JSON object'],
    };
  }

  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (!title) {
    issues.push('title: expected a non-empty string');
  }

  const sections = parseSections(data.sections, issues);
  if (sections.length === 0) {
    issues.push('sections: at least one valid section is required');
  }

  if (!title || sections.length === 0) {
    return { ok: false, error: 'schema-validation-failed', issues };
  }

  return {
    ok: true,
    repaired: extracted.repaired,
    document: {
      title,
      documentType:
        typeof data.documentType === 'string' ? data.documentType : 'unknown',
      language: typeof data.language === 'string' ? data.language : 'unknown',
      sections,
      missingFields: toStringArray(data.missingFields),
      // Section-level problems are surfaced to the reviewing attorney rather
      // than dropped — they mark exactly where the draft is untrustworthy.
      reviewNotes: [...toStringArray(data.reviewNotes), ...issues],
    },
  };
}

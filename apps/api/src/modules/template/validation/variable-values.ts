/**
 * Validates caller-supplied variable values against a template version's
 * declared schema.
 *
 * Two outputs, because they serve different consumers:
 *   * `values`          — typed, stored on `GeneratedDocument.promptVariables`
 *                         so a generation can be reproduced exactly.
 *   * `promptVariables` — flattened to strings and sanitised, which is what the
 *                         AI engine accepts and what actually reaches the model.
 *
 * Returns a result rather than throwing: values failing validation is the
 * normal case (a user filling a form), and the caller needs the full issue list
 * to render field-level errors, not just the first failure.
 */
import { sanitizePromptValue } from '../../../common/prompt/sanitize-prompt-value';
import { sanitizeDocumentValue } from '../../../common/text/sanitize-document-value';
import {
  ABSOLUTE_MAX_LENGTH,
  type VariableDefinition,
  type VariableSchema,
} from './variable-schema';

export interface ValueIssue {
  key: string;
  message: string;
}

export type VariableValue = string | number | boolean;

export interface ValueValidationSuccess {
  ok: true;
  values: Record<string, VariableValue>;
  promptVariables: Record<string, string>;
}

export interface ValueValidationFailure {
  ok: false;
  issues: ValueIssue[];
}

export type ValueValidationResult =
  | ValueValidationSuccess
  | ValueValidationFailure;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-02-30` parses in JS but is not a date; round-trip to catch it. */
function isRealCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    // Reject anything Number() would coerce loosely (whitespace, hex, Infinity)
    // by requiring a plain decimal literal.
    if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return undefined;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * `money` is validated as a decimal but formatted to a fixed two places, so a
 * contract never renders "1500.5 USD".
 */
function formatMoney(amount: number, currency = 'UZS'): string {
  return `${amount.toFixed(2)} ${currency}`;
}

function validateOne(
  definition: VariableDefinition,
  raw: unknown,
  issues: ValueIssue[],
): VariableValue | undefined {
  const { key, label, type } = definition;

  switch (type) {
    case 'string':
    case 'text': {
      const value = typeof raw === 'string' ? raw : String(raw);
      const maxLength = definition.maxLength ?? ABSOLUTE_MAX_LENGTH;

      if (value.length > maxLength) {
        issues.push({
          key,
          message: `${label} must be at most ${maxLength} characters`,
        });
        return undefined;
      }
      if (definition.minLength !== undefined && value.length < definition.minLength) {
        issues.push({
          key,
          message: `${label} must be at least ${definition.minLength} characters`,
        });
        return undefined;
      }
      if (definition.pattern) {
        // The schema parser already rejected patterns with catastrophic
        // backtracking shapes, and the length check above bounds the input.
        const anchored = new RegExp(`^(?:${definition.pattern})$`);
        if (!anchored.test(value)) {
          issues.push({ key, message: `${label} is not in the expected format` });
          return undefined;
        }
      }
      return value;
    }

    case 'number':
    case 'integer':
    case 'money': {
      const value = coerceNumber(raw);
      if (value === undefined) {
        issues.push({ key, message: `${label} must be a number` });
        return undefined;
      }
      if (type === 'integer' && !Number.isInteger(value)) {
        issues.push({ key, message: `${label} must be a whole number` });
        return undefined;
      }
      if (definition.min !== undefined && value < definition.min) {
        issues.push({ key, message: `${label} must be at least ${definition.min}` });
        return undefined;
      }
      if (definition.max !== undefined && value > definition.max) {
        issues.push({ key, message: `${label} must be at most ${definition.max}` });
        return undefined;
      }
      return value;
    }

    case 'boolean': {
      const value = coerceBoolean(raw);
      if (value === undefined) {
        issues.push({ key, message: `${label} must be true or false` });
        return undefined;
      }
      return value;
    }

    case 'date': {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!isRealCalendarDate(value)) {
        issues.push({ key, message: `${label} must be a valid date (YYYY-MM-DD)` });
        return undefined;
      }
      return value;
    }

    case 'enum': {
      const value = typeof raw === 'string' ? raw : String(raw);
      const permitted = definition.options?.some((o) => o.value === value);
      if (!permitted) {
        issues.push({
          key,
          message: `${label} must be one of: ${(definition.options ?? [])
            .map((o) => o.value)
            .join(', ')}`,
        });
        return undefined;
      }
      return value;
    }

    default: {
      // Unreachable while VariableType and this switch agree; the compiler
      // enforces that, and this catches a schema persisted by a newer release.
      issues.push({ key, message: `${label} has an unsupported type` });
      return undefined;
    }
  }
}

/** Renders a validated value for the prompt. */
function toPromptString(
  definition: VariableDefinition,
  value: VariableValue,
): string {
  if (definition.type === 'money' && typeof value === 'number') {
    return formatMoney(value, definition.currency);
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  return String(value);
}

/**
 * Validated values rendered for substitution into a document body.
 *
 * Separate from `promptVariables` because the two have opposite requirements.
 * A prompt value is stripped of the characters used to escape a delimited block;
 * a document value must survive verbatim, since brackets and angle quotes are
 * ordinary punctuation in a contract. Only the type-driven formatting — money to
 * two decimal places, booleans to words — is shared.
 */
export function formatValuesForDocument(
  schema: VariableSchema,
  values: Record<string, VariableValue>,
): Record<string, string> {
  const rendered: Record<string, string> = {};

  for (const definition of schema.variables) {
    const value = values[definition.key];
    if (value === undefined) continue;
    rendered[definition.key] = sanitizeDocumentValue(
      toPromptString(definition, value),
    );
  }

  return rendered;
}

export function validateVariableValues(
  schema: VariableSchema,
  input: Record<string, unknown> = {},
): ValueValidationResult {
  const issues: ValueIssue[] = [];
  const values: Record<string, VariableValue> = {};
  const promptVariables: Record<string, string> = {};

  const declared = new Set(schema.variables.map((variable) => variable.key));

  // Strict, matching the global ValidationPipe's `forbidNonWhitelisted`: an
  // undeclared variable is a caller mistake, and silently dropping it produces
  // a document missing a clause nobody notices until it is signed.
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) {
      issues.push({ key, message: `Unknown variable "${key}"` });
    }
  }

  for (const definition of schema.variables) {
    const raw = input[definition.key];

    if (isAbsent(raw)) {
      if (definition.defaultValue !== undefined) {
        const applied = validateOne(definition, definition.defaultValue, issues);
        if (applied !== undefined) {
          values[definition.key] = applied;
        }
        continue;
      }
      if (definition.required) {
        issues.push({
          key: definition.key,
          message: `${definition.label} is required`,
        });
      }
      continue;
    }

    const value = validateOne(definition, raw, issues);
    if (value !== undefined) {
      values[definition.key] = value;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  for (const definition of schema.variables) {
    const value = values[definition.key];
    if (value === undefined) continue;

    const rendered = toPromptString(definition, value);
    // Sanitised on the way to the prompt, not on the way into storage: the
    // stored value must stay faithful to what the user actually entered.
    promptVariables[definition.key] = sanitizePromptValue(
      rendered,
      definition.maxLength ?? undefined,
    );
  }

  return { ok: true, values, promptVariables };
}

/**
 * The variable contract a template version declares.
 *
 * Stored as JSON on `TemplateVersion.variableSchema` rather than modelled as
 * columns: the set of variables is authored per template by the legal team, so
 * it changes far more often than the deployment does. That flexibility is also
 * the risk — the schema arrives as untrusted JSON and is compiled into
 * validators, so everything in this file treats it as hostile input.
 *
 * Deliberately *not* raw JSON Schema. A closed vocabulary of legal-drafting
 * types (party, money, date, enum, …) keeps the form renderer, the validator,
 * and the prompt formatter agreeing on what a variable means, which arbitrary
 * JSON Schema cannot guarantee.
 */

export const VARIABLE_TYPES = [
  'string',
  'text',
  'number',
  'integer',
  'money',
  'boolean',
  'date',
  'enum',
] as const;

export type VariableType = (typeof VARIABLE_TYPES)[number];

export interface VariableOption {
  value: string;
  label?: string;
}

export interface VariableDefinition {
  /** `snake_case`, matching the placeholder used in the template body. */
  key: string;
  label: string;
  type: VariableType;
  required?: boolean;
  description?: string;
  /** Applied when the caller omits an optional variable. */
  defaultValue?: string | number | boolean;

  /**
   * Hidden behind a disclosure in the compact form.
   *
   * The shipped employment contract declares 31 variables, 30 of them required
   * — a wall that has to be filled in before a routine hire can be papered.
   * Most of those are statutory or house-standard figures that are the same on
   * every contract; a few are the actual particulars of this hire. This flag is
   * the difference.
   *
   * A variable may only be advanced if leaving it alone still produces a valid
   * submission — it is optional, or it carries a `defaultValue`. Hiding a
   * required field with nothing to fall back on would produce a form that
   * cannot be submitted and does not say why; see `parseVariable`, which
   * rejects that combination rather than trusting the author to avoid it.
   */
  advanced?: boolean;

  // --- string / text --------------------------------------------------------
  minLength?: number;
  maxLength?: number;
  /** Anchored on use; see `assertSafePattern` for the accepted subset. */
  pattern?: string;

  // --- number / integer / money ---------------------------------------------
  min?: number;
  max?: number;
  /** ISO 4217, for `money`. Defaults to UZS. */
  currency?: string;

  // --- enum -----------------------------------------------------------------
  options?: VariableOption[];
}

export interface VariableSchema {
  /** Schema format version, so a future shape change stays distinguishable. */
  version: 1;
  variables: VariableDefinition[];
}

export interface SchemaIssue {
  /** Dotted location within the schema, e.g. `variables[2].pattern`. */
  path: string;
  message: string;
}

/** Raised when a *schema* is malformed — as opposed to values failing it. */
export class VariableSchemaError extends Error {
  constructor(readonly issues: SchemaIssue[]) {
    super(`Invalid variable schema: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'VariableSchemaError';
  }
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Bounds chosen to keep a schema renderable as a form and cheap to validate. */
const MAX_VARIABLES = 200;
const MAX_OPTIONS = 200;
const MAX_PATTERN_LENGTH = 200;
/** Hard ceiling on any single value, independent of what the schema asks for. */
export const ABSOLUTE_MAX_LENGTH = 10_000;

/**
 * Rejects patterns whose matching can blow up super-linearly.
 *
 * Author-supplied regexes are compiled and then run against caller-supplied
 * input, which is a textbook ReDoS setup: `(a+)+$` against a long non-matching
 * string will hang the event loop and take the whole API process with it.
 *
 * This is a conservative heuristic, not a proof of safety — it rejects nested
 * and adjacent unbounded quantifiers, which covers the catastrophic-backtracking
 * shapes that actually occur. A pattern that needs more expressive power than
 * this allows belongs in code as a named validator, not in template JSON.
 */
function assertSafePattern(pattern: string, path: string, issues: SchemaIssue[]) {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    issues.push({
      path,
      message: `pattern must be at most ${MAX_PATTERN_LENGTH} characters`,
    });
    return;
  }

  // A quantified group that itself ends in a quantifier: (x+)+, (x*)+, (x+){2,}
  const NESTED_QUANTIFIER = /\([^)]*[+*}][^)]*\)\s*[+*{]/;
  // Two unbounded quantifiers separated only by an optional character class.
  const ADJACENT_QUANTIFIERS = /[+*]\s*[^\s|)]{0,4}\s*[+*]/;

  if (NESTED_QUANTIFIER.test(pattern) || ADJACENT_QUANTIFIERS.test(pattern)) {
    issues.push({
      path,
      message:
        'pattern contains nested or adjacent unbounded quantifiers, which risk catastrophic backtracking',
    });
    return;
  }

  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch {
    issues.push({ path, message: 'pattern is not a valid regular expression' });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkNumber(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
  { min = 0 }: { min?: number } = {},
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: `${path} must be a finite number` });
    return undefined;
  }
  if (value < min) {
    issues.push({ path, message: `${path} must be at least ${min}` });
    return undefined;
  }
  return value;
}

function parseVariable(
  raw: unknown,
  index: number,
  issues: SchemaIssue[],
  seenKeys: Set<string>,
): VariableDefinition | null {
  const at = `variables[${index}]`;

  if (!isPlainObject(raw)) {
    issues.push({ path: at, message: `${at} must be an object` });
    return null;
  }

  const key = raw.key;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    issues.push({
      path: `${at}.key`,
      message: `${at}.key must be snake_case, starting with a letter, max 63 characters`,
    });
    return null;
  }

  if (seenKeys.has(key)) {
    issues.push({ path: `${at}.key`, message: `duplicate variable key "${key}"` });
    return null;
  }
  seenKeys.add(key);

  const type = raw.type;
  if (typeof type !== 'string' || !VARIABLE_TYPES.includes(type as VariableType)) {
    issues.push({
      path: `${at}.type`,
      message: `${at}.type must be one of ${VARIABLE_TYPES.join(', ')}`,
    });
    return null;
  }

  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : key;

  const definition: VariableDefinition = {
    key,
    label,
    type: type as VariableType,
    required: raw.required === true,
  };

  if (typeof raw.description === 'string') {
    definition.description = raw.description.slice(0, 500);
  }

  if (
    typeof raw.defaultValue === 'string' ||
    typeof raw.defaultValue === 'number' ||
    typeof raw.defaultValue === 'boolean'
  ) {
    definition.defaultValue = raw.defaultValue;
  }

  if (raw.advanced === true) {
    // Refused rather than silently downgraded to `advanced: false`: an author
    // who marked this advanced believes it does not need filling in, and the
    // honest answer is that the schema says otherwise. Downgrading would leave
    // them with a form they think is compact and is not.
    if (definition.required && definition.defaultValue === undefined) {
      issues.push({
        path: `${at}.advanced`,
        message: `${at} cannot be advanced while it is required with no defaultValue — the compact form would hide a field that must be filled in, and offer no way to discover it`,
      });
    } else {
      definition.advanced = true;
    }
  }

  if (definition.type === 'string' || definition.type === 'text') {
    definition.minLength = checkNumber(raw.minLength, `${at}.minLength`, issues);
    const maxLength = checkNumber(raw.maxLength, `${at}.maxLength`, issues, {
      min: 1,
    });
    if (maxLength !== undefined) {
      definition.maxLength = Math.min(maxLength, ABSOLUTE_MAX_LENGTH);
    }
    if (
      definition.minLength !== undefined &&
      definition.maxLength !== undefined &&
      definition.minLength > definition.maxLength
    ) {
      issues.push({
        path: `${at}.minLength`,
        message: `${at}.minLength cannot exceed maxLength`,
      });
    }
    if (raw.pattern !== undefined) {
      if (typeof raw.pattern !== 'string') {
        issues.push({ path: `${at}.pattern`, message: `${at}.pattern must be a string` });
      } else {
        assertSafePattern(raw.pattern, `${at}.pattern`, issues);
        definition.pattern = raw.pattern;
      }
    }
  }

  if (
    definition.type === 'number' ||
    definition.type === 'integer' ||
    definition.type === 'money'
  ) {
    // Negatives are legitimate here (a credit note, a negative adjustment), so
    // no implicit floor.
    definition.min = checkNumber(raw.min, `${at}.min`, issues, {
      min: Number.NEGATIVE_INFINITY,
    });
    definition.max = checkNumber(raw.max, `${at}.max`, issues, {
      min: Number.NEGATIVE_INFINITY,
    });
    if (
      definition.min !== undefined &&
      definition.max !== undefined &&
      definition.min > definition.max
    ) {
      issues.push({ path: `${at}.min`, message: `${at}.min cannot exceed max` });
    }
  }

  if (definition.type === 'money') {
    const currency = raw.currency ?? 'UZS';
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      issues.push({
        path: `${at}.currency`,
        message: `${at}.currency must be a three-letter ISO 4217 code`,
      });
    } else {
      definition.currency = currency;
    }
  }

  if (definition.type === 'enum') {
    const options = raw.options;
    if (!Array.isArray(options) || options.length === 0) {
      issues.push({
        path: `${at}.options`,
        message: `${at}.options must be a non-empty array for an enum variable`,
      });
    } else if (options.length > MAX_OPTIONS) {
      issues.push({
        path: `${at}.options`,
        message: `${at}.options must hold at most ${MAX_OPTIONS} entries`,
      });
    } else {
      const seenValues = new Set<string>();
      const parsed: VariableOption[] = [];

      options.forEach((option, optionIndex) => {
        const optionPath = `${at}.options[${optionIndex}]`;
        const value = isPlainObject(option) ? option.value : option;

        if (typeof value !== 'string' || !value.trim()) {
          issues.push({
            path: optionPath,
            message: `${optionPath} must have a non-empty string value`,
          });
          return;
        }
        if (seenValues.has(value)) {
          issues.push({
            path: optionPath,
            message: `${optionPath} duplicates value "${value}"`,
          });
          return;
        }
        seenValues.add(value);

        const label =
          isPlainObject(option) && typeof option.label === 'string'
            ? option.label
            : undefined;
        parsed.push(label ? { value, label } : { value });
      });

      definition.options = parsed;
    }
  }

  return definition;
}

/**
 * Validates and normalises an author-supplied schema.
 *
 * Throws rather than returning a result: a malformed schema is a bug in what is
 * being saved, not a routine outcome, and callers should not be able to
 * accidentally persist one by ignoring a return value.
 */
export function parseVariableSchema(raw: unknown): VariableSchema {
  const issues: SchemaIssue[] = [];

  if (!isPlainObject(raw)) {
    throw new VariableSchemaError([
      { path: '', message: 'schema must be an object' },
    ]);
  }

  if (raw.version !== 1) {
    issues.push({ path: 'version', message: 'schema version must be 1' });
  }

  const variables = raw.variables;
  if (!Array.isArray(variables)) {
    throw new VariableSchemaError([
      ...issues,
      { path: 'variables', message: 'variables must be an array' },
    ]);
  }

  if (variables.length > MAX_VARIABLES) {
    issues.push({
      path: 'variables',
      message: `a template may declare at most ${MAX_VARIABLES} variables`,
    });
  }

  const seenKeys = new Set<string>();
  const parsed = variables
    .map((variable, index) => parseVariable(variable, index, issues, seenKeys))
    .filter((variable): variable is VariableDefinition => variable !== null);

  if (issues.length > 0) {
    throw new VariableSchemaError(issues);
  }

  return { version: 1, variables: parsed };
}

/** An empty but valid schema, for templates that take no variables. */
export const EMPTY_VARIABLE_SCHEMA: VariableSchema = {
  version: 1,
  variables: [],
};

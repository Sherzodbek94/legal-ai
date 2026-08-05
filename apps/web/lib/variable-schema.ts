/**
 * The variable contract a template version declares.
 *
 * Mirrors `apps/api/src/modules/template/validation/variable-schema.ts`. The
 * two are separate declarations of the same wire shape because the packages do
 * not share types; the API remains the authority — it re-validates everything
 * this file describes, so a drift here produces a rejected form, never a bad
 * document.
 */

export type VariableType =
  | 'string'
  | 'text'
  | 'number'
  | 'integer'
  | 'money'
  | 'boolean'
  | 'date'
  | 'enum';

export interface VariableOption {
  value: string;
  label: string;
}

export interface VariableDefinition {
  key: string;
  label: string;
  type: VariableType;
  required?: boolean;
  description?: string;
  defaultValue?: string | number | boolean;
  /**
   * Rendered inside the compact form's disclosure rather than in the main list.
   *
   * The API guarantees an advanced variable is either optional or carries a
   * `defaultValue`, so leaving the disclosure closed always produces a valid
   * submission. The form relies on that: it never validates the flag itself.
   */
  advanced?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  currency?: string;
  options?: VariableOption[];
}

export interface VariableSchema {
  version: 1;
  variables: VariableDefinition[];
}

/**
 * Reads a schema off a template version, tolerating a shape it does not expect.
 *
 * The value arrives from a JSON column that may have been written by a
 * different release. An unreadable schema renders as "no variables" — the form
 * still submits, and the API rejects it with a precise reason — which is better
 * than a page that throws where a form belongs.
 */
export function parseSchema(raw: unknown): VariableDefinition[] {
  if (typeof raw !== 'object' || raw === null) return [];

  const variables = (raw as { variables?: unknown }).variables;
  if (!Array.isArray(variables)) return [];

  return variables.filter(
    (variable): variable is VariableDefinition =>
      typeof variable === 'object' &&
      variable !== null &&
      typeof (variable as VariableDefinition).key === 'string' &&
      typeof (variable as VariableDefinition).label === 'string',
  );
}

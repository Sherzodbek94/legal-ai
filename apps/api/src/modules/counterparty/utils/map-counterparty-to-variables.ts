/**
 * Converts a registry lookup into the flat variable set a template consumes.
 *
 * Mirrors `mapCompanyToVariables` key for key, under a `counterparty_` prefix,
 * so a contract template can address both parties the same way.
 */
import { sanitizePromptValue } from '../../../common/prompt/sanitize-prompt-value';
import type { RegistryEntity } from '../providers/registry-provider';

export type CounterpartyVariables = Record<string, string>;

const DEFAULT_MAX_VALUE_LENGTH = 500;

/**
 * Registry values are third-party strings that end up inside an LLM prompt,
 * which makes them an injection vector exactly like company profile fields —
 * and rather more so, since nobody in this workspace controls what a
 * counterparty registered as its legal name.
 */
const sanitize = sanitizePromptValue;

export interface MapCounterpartyOptions {
  /** See `mapCompanyToVariables`: off so "not provided" stays distinguishable. */
  includeEmpty?: boolean;
  maxValueLength?: number;
}

export function mapCounterpartyToVariables(
  entity: RegistryEntity,
  options: MapCounterpartyOptions = {},
): CounterpartyVariables {
  const { includeEmpty = false, maxValueLength = DEFAULT_MAX_VALUE_LENGTH } =
    options;

  const raw: Record<string, string | null | undefined> = {
    counterparty_legal_name: entity.legalName,
    // Falls back to the legal name so a template addressing the party
    // conversationally never renders an empty string.
    counterparty_name: entity.shortName || entity.legalName,
    counterparty_stir: entity.stir,
    counterparty_oked: entity.oked,
    counterparty_legal_address: entity.legalAddress,
    counterparty_director_name: entity.directorName,
    counterparty_director_position: entity.directorPosition || 'Director',
    counterparty_phone: entity.phone,
    counterparty_email: entity.email,
  };

  const result: CounterpartyVariables = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) {
      if (includeEmpty) result[key] = '';
      continue;
    }

    const cleaned = sanitize(String(value), maxValueLength);

    if (!cleaned) {
      if (includeEmpty) result[key] = '';
      continue;
    }

    result[key] = cleaned;
  }

  return result;
}

/**
 * Bank details a registry cannot supply.
 *
 * MFO and the settlement account are not published in the state register, so a
 * template needing them still needs the counterparty to provide them. Exported
 * so the UI can say which fields remain to be filled by hand instead of
 * leaving the drafter to discover it at the signature page.
 */
export const COUNTERPARTY_VARIABLES_NOT_IN_REGISTRY = [
  'counterparty_mfo',
  'counterparty_bank_account',
  'counterparty_bank_name',
] as const;

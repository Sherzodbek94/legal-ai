/**
 * Converts a company record into the flat variable set injected into AI
 * document-generation prompts.
 */
import { sanitizePromptValue } from '../../../common/prompt/sanitize-prompt-value';

/** The subset of Company this mapper reads. */
export interface MappableCompany {
  name: string;
  legalName?: string | null;
  stir?: string | null;
  oked?: string | null;
  mfo?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  vatCode?: string | null;
  legalAddress?: string | null;
  actualAddress?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  directorName?: string | null;
  directorPosition?: string | null;
  accountantName?: string | null;
}

export type CompanyVariables = Record<string, string>;

/**
 * Alternative keys the same value is also published under.
 *
 * Templates are authored data, not code: whoever writes one picks the
 * placeholder names, and they do not consult this file. The shipped employment
 * contract asks for `company_tin`, `company_address` and
 * `company_representative_name`, while this mapper emits `company_stir`,
 * `company_legal_address` and `company_director_name` — so four of its eight
 * employer fields silently arrived blank and had to be typed by hand, on a form
 * whose whole point is that they are already known.
 *
 * Aliasing here rather than renaming the template's keys, because the keys are
 * recorded in every document already generated from it: renaming would make
 * those `promptVariables` unreadable against the current schema, which is the
 * record of what a signed contract was built from.
 */
const ALIASES: Record<string, string[]> = {
  company_stir: ['company_tin', 'company_inn'],
  company_legal_address: ['company_address'],
  company_director_name: ['company_representative_name'],
  company_director_position: ['company_representative_position'],
  company_legal_name: ['company_full_name'],
};

export interface MapCompanyOptions {
  /**
   * Include keys whose value is absent, mapped to ''. Off by default so a
   * template can distinguish "not provided" from "empty", and so prompts do
   * not carry a wall of blank fields.
   */
  includeEmpty?: boolean;
  /** Upper bound per value; longer input is truncated. */
  maxValueLength?: number;
}

const DEFAULT_MAX_VALUE_LENGTH = 500;

/**
 * Company profile fields are user-controlled and flow into an LLM prompt, which
 * makes them an injection vector: a directorName of "]] Ignore prior
 * instructions and ..." is a plausible attack, not a hypothetical.
 *
 * The neutralising rules live in `common/prompt` because template variable
 * input needs exactly the same treatment, and a second copy of security-critical
 * string handling is a copy that quietly drifts.
 */
const sanitize = sanitizePromptValue;

function formatBankAccount(account: string): string {
  // Uzbek settlement accounts are conventionally read in groups of four.
  return account.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

/**
 * Maps a company to prompt variables.
 *
 * Keys are `snake_case` and prefixed `company_` so a template can hold
 * variables from several sources without collision.
 */
export function mapCompanyToVariables(
  company: MappableCompany,
  options: MapCompanyOptions = {},
): CompanyVariables {
  const { includeEmpty = false, maxValueLength = DEFAULT_MAX_VALUE_LENGTH } =
    options;

  const bankAccount = company.bankAccount?.trim();

  const raw: Record<string, string | null | undefined> = {
    company_name: company.name,
    // Contracts should carry the registered legal name; fall back to the
    // display name so the variable is never silently missing.
    company_legal_name: company.legalName || company.name,
    company_stir: company.stir,
    company_oked: company.oked,
    company_mfo: company.mfo,
    company_bank_account: bankAccount,
    company_bank_account_formatted: bankAccount
      ? formatBankAccount(bankAccount)
      : undefined,
    company_bank_name: company.bankName,
    company_vat_code: company.vatCode,
    company_legal_address: company.legalAddress,
    // Where no separate actual address is recorded, the legal address is the
    // operating address.
    company_actual_address: company.actualAddress || company.legalAddress,
    company_phone: company.phone,
    company_email: company.email,
    company_website: company.website,
    company_director_name: company.directorName,
    company_director_position: company.directorPosition || 'Director',
    company_accountant_name: company.accountantName,
  };

  const result: CompanyVariables = {};

  /** Writes a value under its canonical key and every alias of that key. */
  const publish = (key: string, value: string) => {
    result[key] = value;
    for (const alias of ALIASES[key] ?? []) result[alias] = value;
  };

  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) {
      if (includeEmpty) publish(key, '');
      continue;
    }

    const cleaned = sanitize(String(value), maxValueLength);

    if (!cleaned) {
      if (includeEmpty) publish(key, '');
      continue;
    }

    publish(key, cleaned);
  }

  return result;
}

/**
 * Variables a contract template cannot be completed without.
 * Used to fail fast before spending a generation call.
 */
export const REQUIRED_CONTRACT_VARIABLES = [
  'company_legal_name',
  'company_stir',
  'company_legal_address',
  'company_director_name',
] as const;

export function findMissingContractVariables(
  variables: CompanyVariables,
): string[] {
  return REQUIRED_CONTRACT_VARIABLES.filter((key) => !variables[key]);
}

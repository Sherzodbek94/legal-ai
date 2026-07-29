/**
 * Converts a company record into the flat variable set injected into AI
 * document-generation prompts.
 */

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
 * C0 and C1 control characters - includes the newlines an attacker would use
 * to forge what looks like a new instruction line in the prompt.
 *
 * Built with `new RegExp` from escaped strings so this file stays pure ASCII:
 * literal control characters in source are invisible in review and get
 * silently mangled by editors and diff tools.
 */
const CONTROL_CHARS = new RegExp('[\u0000-\u001F\u007F-\u009F]', 'g');

/**
 * Zero-width and bidirectional-override characters. Invisible to a human
 * reviewing the company profile, but still tokenised by the model and usable
 * to disguise injected text.
 */
const INVISIBLE_CHARS = new RegExp(
  '[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]',
  'g',
);

/** Characters that could terminate a delimited variable block in a prompt. */
const DELIMITER_CHARS = /[{}[\]<>]/g;

/**
 * Neutralises a value before it reaches a prompt.
 *
 * Company profile fields are user-controlled and flow into an LLM prompt, which
 * makes them an injection vector: a directorName of "]] Ignore prior
 * instructions and ..." is a plausible attack, not a hypothetical. This cannot
 * make injection impossible on its own — the durable defences are delimiting
 * the data and instructing the model to treat it as data — but it removes the
 * characters used to break out of a delimited block.
 */
function sanitize(value: string, maxLength: number): string {
  return value
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(DELIMITER_CHARS, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

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

/**
 * The business-registry lookup contract.
 *
 * One interface with one implementation today (iHamkor) because the source is
 * the part most likely to change: iHamkor operates under a public-private
 * partnership contract that can be renegotiated, and a bank or the tax
 * authority may issue direct access later. Everything above this line — the
 * service, the controller, the variable mapper, the UI — is written against
 * this shape and not against any provider's payload.
 */

/**
 * What a registry can tell you about a legal entity.
 *
 * Deliberately a subset of `Company`: these are the fields a public registry
 * actually holds. **Bank details are absent on purpose** — MFO and the
 * settlement account are not published in the register, and a lookup that
 * appeared to offer them would invite someone to sign a contract against
 * invented payment instructions.
 */
export interface RegistryEntity {
  /** Registered legal name, as it must appear on a contract. */
  legalName: string;
  /** Trading or short name, when the registry distinguishes one. */
  shortName?: string;
  /** STIR / ИНН — 9 digits, normalised. */
  stir: string;
  /** OKED / ОКЭД — primary economic activity, 5 digits. */
  oked?: string;
  legalAddress?: string;
  directorName?: string;
  directorPosition?: string;
  phone?: string;
  email?: string;
  /** Registry status, e.g. active or liquidated. See `RegistryStatus`. */
  status: RegistryStatus;
  /** Date of state registration, when supplied. */
  registeredAt?: Date;
  /** The provider's own identifier for this record, for support requests. */
  sourceRef?: string;
}

/**
 * Whether the entity is currently trading.
 *
 * `UNKNOWN` is not a synonym for active. A provider that does not report status
 * must say so rather than have this default to something reassuring — a
 * counterparty in liquidation is exactly what a lookup exists to reveal, and
 * silently calling that "active" would be worse than not showing a status.
 */
export type RegistryStatus = 'ACTIVE' | 'LIQUIDATED' | 'SUSPENDED' | 'UNKNOWN';

/** A lookup result, with the provenance a signed contract needs. */
export interface RegistryLookup {
  entity: RegistryEntity;
  /** Which provider answered — carried through to the UI and stored with it. */
  source: string;
  /**
   * When this snapshot was taken.
   *
   * Not "now": a cached answer is reported at the time it was fetched, so a
   * document records the age of the data it was built from rather than the
   * moment somebody happened to open the form.
   */
  retrievedAt: Date;
}

/**
 * Why a lookup produced nothing.
 *
 * Separated from a thrown error because "no such taxpayer" is an ordinary
 * answer the user needs to see, while "the provider is down" is an operational
 * fault they can only wait out — and the two must not read the same on screen.
 */
export class RegistryUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RegistryUnavailableError';
  }
}

export interface CounterpartyRegistryProvider {
  /** Short identifier recorded as the provenance of a lookup, e.g. `ihamkor`. */
  readonly source: string;

  /**
   * Whether this deployment holds credentials for the provider.
   *
   * Same fail-closed rule as every other integration here: unset credentials
   * mean the feature reports itself unavailable, never that it silently
   * returns nothing and lets the caller read that as "not registered".
   */
  isConfigured(): boolean;

  /**
   * Looks up one taxpayer by STIR.
   *
   * Resolves `null` when the registry has no such entity — a real answer.
   * Throws `RegistryUnavailableError` when it could not be asked.
   */
  findByStir(stir: string): Promise<RegistryLookup | null>;
}

/** DI token; the interface itself cannot be one. */
export const COUNTERPARTY_REGISTRY_PROVIDER = Symbol(
  'COUNTERPARTY_REGISTRY_PROVIDER',
);

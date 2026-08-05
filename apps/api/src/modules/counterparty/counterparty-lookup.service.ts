import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { NotRegistered } from './providers/ihamkor.provider';
import {
  COUNTERPARTY_REGISTRY_PROVIDER,
  RegistryUnavailableError,
  type CounterpartyRegistryProvider,
  type RegistryLookup,
} from './providers/registry-provider';

/**
 * Business-registry lookup for the other side of a contract.
 *
 * The product models its *own* company in full — seventeen `company_*`
 * variables reach every template — while the counterparty was a name typed
 * into an export query string. That asymmetry is what this closes: a contract
 * names two parties, and only one of them had registered details behind it.
 *
 * It also serves a rule the AI already works under. `legal-system-prompt.ts`
 * forbids the model from inventing a STIR, MFO, or account number; a registry
 * lookup is the only way to satisfy a template that needs one without asking
 * the user to retype it from a scan.
 *
 * **Nothing here is persisted.** A lookup returns a suggestion carrying its
 * source and age; whether it becomes part of a document is the user's decision,
 * expressed by submitting it with the rest of the template variables. That is
 * the same shape as OneID's `legalEntities`, and for the same reason — a wrong
 * STIR in a signed contract is a liability, so no registry answer is applied
 * to anything without somebody confirming it.
 */
@Injectable()
export class CounterpartyLookupService {
  private readonly logger = new Logger(CounterpartyLookupService.name);

  /**
   * Registry records change on the timescale of company filings, not minutes,
   * so an hour of cache costs nothing in accuracy. What it buys is a hard
   * ceiling on billable provider calls when several drafters look up the same
   * frequent counterparty in one afternoon.
   */
  private static readonly CACHE_TTL_SECONDS = 3600;

  constructor(
    @Inject(COUNTERPARTY_REGISTRY_PROVIDER)
    private readonly provider: CounterpartyRegistryProvider,
    private readonly redis: RedisService,
  ) {}

  isAvailable(): boolean {
    return this.provider.isConfigured();
  }

  /**
   * Looks up a taxpayer by STIR.
   *
   * `null` means the registry has no such entity. A provider fault raises 503
   * instead, so the UI can say "we could not check" rather than "no such
   * company" — the second would have a user with a correct STIR sit there
   * editing it.
   */
  async findByStir(stir: string): Promise<RegistryLookup | null> {
    const normalized = stir.replace(/\D/g, '');
    const cacheKey = `counterparty:stir:${normalized}`;

    const cached = await this.readCache(cacheKey);
    if (cached !== undefined) return cached;

    let result: RegistryLookup | null;

    try {
      result = await this.provider.findByStir(normalized);
    } catch (error) {
      if (error instanceof NotRegistered) {
        result = null;
      } else if (error instanceof RegistryUnavailableError) {
        throw new ServiceUnavailableException(error.message);
      } else {
        this.logger.error(
          `Unexpected counterparty lookup failure: ${(error as Error)?.message ?? 'unknown error'}`,
        );
        throw new ServiceUnavailableException(
          'The business registry is not responding',
        );
      }
    }

    await this.writeCache(cacheKey, result);
    return result;
  }

  /**
   * `undefined` for a cache miss, distinct from a cached `null`.
   *
   * A negative answer is worth caching too — an unregistered STIR is usually a
   * typo, and a user correcting it one digit at a time would otherwise spend a
   * provider call on every attempt.
   */
  private async readCache(key: string): Promise<RegistryLookup | null | undefined> {
    try {
      const raw = await this.redis.client.get(key);
      if (raw === null) return undefined;
      if (raw === 'null') return null;

      const parsed = JSON.parse(raw) as RegistryLookup;
      // Revived rather than left as a string: `retrievedAt` is what the UI
      // renders as the age of the data, and JSON has no date type.
      return { ...parsed, retrievedAt: new Date(parsed.retrievedAt) };
    } catch {
      // A cache that cannot be read is not a reason to refuse the lookup.
      return undefined;
    }
  }

  private async writeCache(key: string, value: RegistryLookup | null): Promise<void> {
    try {
      await this.redis.client.set(
        key,
        value === null ? 'null' : JSON.stringify(value),
        'EX',
        CounterpartyLookupService.CACHE_TTL_SECONDS,
      );
    } catch {
      // Nor is a cache that cannot be written.
    }
  }
}

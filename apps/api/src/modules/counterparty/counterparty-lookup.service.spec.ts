import { ServiceUnavailableException } from '@nestjs/common';
import { CounterpartyLookupService } from './counterparty-lookup.service';
import { NotRegistered } from './providers/ihamkor.provider';
import {
  RegistryUnavailableError,
  type CounterpartyRegistryProvider,
  type RegistryLookup,
} from './providers/registry-provider';

const RETRIEVED_AT = new Date('2026-08-04T09:00:00.000Z');

function lookupFor(stir: string): RegistryLookup {
  return {
    source: 'ihamkor',
    retrievedAt: RETRIEVED_AT,
    entity: {
      legalName: 'Sifat Qurilish MChJ',
      stir,
      status: 'ACTIVE',
      legalAddress: 'Tashkent, Chilonzor 12',
      directorName: 'Aziz Karimov',
    },
  };
}

/** An in-memory stand-in for the one Redis command pair the service uses. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    client: {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
    },
  };
}

function build(
  provider: Partial<CounterpartyRegistryProvider> = {},
  redis = fakeRedis(),
) {
  const full: CounterpartyRegistryProvider = {
    source: 'ihamkor',
    isConfigured: () => true,
    findByStir: jest.fn(async () => lookupFor('305123456')),
    ...provider,
  };

  return {
    provider: full,
    redis,
    service: new CounterpartyLookupService(full, redis as never),
  };
}

describe('CounterpartyLookupService', () => {
  describe('lookup', () => {
    it('returns the registry record for a known STIR', async () => {
      const { service } = build();

      const result = await service.findByStir('305123456');

      expect(result?.entity.legalName).toBe('Sifat Qurilish MChJ');
      expect(result?.source).toBe('ihamkor');
    });

    it('strips punctuation a user pasted out of a contract', async () => {
      const findByStir = jest.fn(async () => lookupFor('305123456'));
      const { service } = build({ findByStir });

      await service.findByStir('305 123-456');

      expect(findByStir).toHaveBeenCalledWith('305123456');
    });

    it('reports an unregistered STIR as an answer, not a failure', async () => {
      const { service } = build({
        findByStir: jest.fn(async () => {
          throw new NotRegistered();
        }),
      });

      await expect(service.findByStir('305123456')).resolves.toBeNull();
    });
  });

  describe('when the registry cannot be reached', () => {
    // The distinction this suite protects: "no such company" and "we could not
    // check" must not collapse into one another. A user whose STIR is correct
    // would otherwise sit editing a number that was right the first time.
    it('raises 503 rather than reporting the company as unregistered', async () => {
      const { service } = build({
        findByStir: jest.fn(async () => {
          throw new RegistryUnavailableError('registry is down', true);
        }),
      });

      await expect(service.findByStir('305123456')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('raises 503 for an unconfigured deployment too', async () => {
      const { service } = build({
        isConfigured: () => false,
        findByStir: jest.fn(async () => {
          throw new RegistryUnavailableError('nothing configured', false);
        }),
      });

      await expect(service.findByStir('305123456')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('does not cache a failure', async () => {
      const findByStir = jest.fn(async () => {
        throw new RegistryUnavailableError('registry is down', true);
      });
      const { service } = build({ findByStir });

      await expect(service.findByStir('305123456')).rejects.toThrow();
      await expect(service.findByStir('305123456')).rejects.toThrow();

      // An outage that cached itself would outlast the outage.
      expect(findByStir).toHaveBeenCalledTimes(2);
    });
  });

  describe('caching', () => {
    it('answers a repeated lookup without calling the provider again', async () => {
      const findByStir = jest.fn(async () => lookupFor('305123456'));
      const { service } = build({ findByStir });

      await service.findByStir('305123456');
      const second = await service.findByStir('305123456');

      expect(findByStir).toHaveBeenCalledTimes(1);
      expect(second?.entity.legalName).toBe('Sifat Qurilish MChJ');
    });

    it('revives retrievedAt as a Date, not the string JSON left behind', async () => {
      const { service } = build();

      await service.findByStir('305123456');
      const cached = await service.findByStir('305123456');

      expect(cached?.retrievedAt).toBeInstanceOf(Date);
      expect(cached?.retrievedAt.toISOString()).toBe(RETRIEVED_AT.toISOString());
    });

    it('caches a negative answer as well', async () => {
      const findByStir = jest.fn(async () => {
        throw new NotRegistered();
      });
      const { service } = build({ findByStir });

      await service.findByStir('305123456');
      await expect(service.findByStir('305123456')).resolves.toBeNull();

      // Correcting a mistyped STIR one digit at a time should not cost a
      // billable call per keystroke.
      expect(findByStir).toHaveBeenCalledTimes(1);
    });

    it('still answers when Redis is unavailable', async () => {
      const broken = {
        client: {
          get: jest.fn(async () => {
            throw new Error('redis down');
          }),
          set: jest.fn(async () => {
            throw new Error('redis down');
          }),
        },
      };
      const { service } = build({}, broken as never);

      await expect(service.findByStir('305123456')).resolves.not.toBeNull();
    });
  });

  describe('availability', () => {
    it('follows the provider', () => {
      expect(build({ isConfigured: () => true }).service.isAvailable()).toBe(true);
      expect(build({ isConfigured: () => false }).service.isAvailable()).toBe(false);
    });
  });
});

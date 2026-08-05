import { OneIdService, type OneIdLegalEntity } from './oneid.service';
import type { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import type { RedisService } from '../../../redis/redis.service';

/**
 * `cacheLegalEntities` / `consumeLegalEntities` — the prefill bridge for
 * company onboarding after a OneID login.
 *
 * The OneID callback is a browser redirect, not a fetch the frontend can
 * read a body from, so a first-time login's `legalEntities` (STIR, company
 * name, director flag) have to survive the redirect some other way. This
 * exercises the Redis round trip in isolation: it is written once, read
 * exactly once, and a second read after that (a page refresh) finds nothing
 * rather than replaying stale data from a previous login.
 */
describe('OneIdService — legal entities prefill', () => {
  const ENTITIES: OneIdLegalEntity[] = [
    { tin: '123456789', name: 'Acme Legal', isDirector: true },
  ];

  function build() {
    const store = new Map<string, string>();

    const redis = {
      client: {
        set: jest.fn(async (key: string, value: string) => {
          store.set(key, value);
          return 'OK';
        }),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        del: jest.fn(async (key: string) => {
          const existed = store.delete(key);
          return existed ? 1 : 0;
        }),
      },
    } as unknown as RedisService;

    const service = new OneIdService(
      {} as unknown as ConfigService,
      {} as unknown as HttpService,
      redis,
    );

    return { service, redis };
  }

  it('returns nothing for a user who never had entities cached', async () => {
    const { service } = build();
    expect(await service.consumeLegalEntities('user_1')).toEqual([]);
  });

  it('round-trips what was cached', async () => {
    const { service } = build();

    await service.cacheLegalEntities('user_1', ENTITIES);

    expect(await service.consumeLegalEntities('user_1')).toEqual(ENTITIES);
  });

  it('is consumed exactly once — a second read gets nothing', async () => {
    const { service } = build();
    await service.cacheLegalEntities('user_1', ENTITIES);

    await service.consumeLegalEntities('user_1');
    const second = await service.consumeLegalEntities('user_1');

    expect(second).toEqual([]);
  });

  it('does not cache an empty list', async () => {
    const { service, redis } = build();

    await service.cacheLegalEntities('user_1', []);

    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('keeps different users’ cached entities separate', async () => {
    const { service } = build();
    const otherEntities: OneIdLegalEntity[] = [
      { tin: '987654321', name: 'Other LLC', isDirector: false },
    ];

    await service.cacheLegalEntities('user_1', ENTITIES);
    await service.cacheLegalEntities('user_2', otherEntities);

    expect(await service.consumeLegalEntities('user_2')).toEqual(otherEntities);
    expect(await service.consumeLegalEntities('user_1')).toEqual(ENTITIES);
  });
});

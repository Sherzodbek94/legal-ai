import { of, throwError } from 'rxjs';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { IHamkorProvider, NotRegistered } from './ihamkor.provider';
import { RegistryUnavailableError } from './registry-provider';

function build(
  config: Record<string, string> = { IHAMKOR_API_KEY: 'test-key' },
  response: unknown = { data: {} },
) {
  const get = jest.fn(() => of({ data: response }));

  const provider = new IHamkorProvider(
    { get } as unknown as HttpService,
    {
      get: (key: string, fallback?: string) => config[key] ?? fallback ?? '',
    } as unknown as ConfigService,
  );

  return { provider, get };
}

/** An axios-shaped rejection, which is what `translate` reads. */
function httpError(status: number) {
  return throwError(() => ({ response: { status }, message: `HTTP ${status}` }));
}

const RECORD = {
  legalName: 'Sifat Qurilish MChJ',
  tin: '305123456',
  oked: '41200',
  address: 'Tashkent, Chilonzor 12',
  director: 'Aziz Karimov',
  status: 'ACTIVE',
};

describe('IHamkorProvider', () => {
  describe('configuration', () => {
    it('is unconfigured without an API key', () => {
      expect(build({}).provider.isConfigured()).toBe(false);
    });

    it('refuses to look anything up when unconfigured', async () => {
      const { provider, get } = build({});

      await expect(provider.findByStir('305123456')).rejects.toBeInstanceOf(
        RegistryUnavailableError,
      );
      // Fails closed: no request is attempted at all.
      expect(get).not.toHaveBeenCalled();
    });

    it('marks a missing key as not worth retrying', async () => {
      const { provider } = build({});

      await expect(provider.findByStir('305123456')).rejects.toMatchObject({
        retryable: false,
      });
    });
  });

  describe('parsing', () => {
    it('maps a record onto the registry shape', async () => {
      const { provider } = build(undefined, { data: RECORD });

      const result = await provider.findByStir('305123456');

      expect(result?.entity).toMatchObject({
        legalName: 'Sifat Qurilish MChJ',
        stir: '305123456',
        oked: '41200',
        legalAddress: 'Tashkent, Chilonzor 12',
        directorName: 'Aziz Karimov',
        status: 'ACTIVE',
      });
      expect(result?.source).toBe('ihamkor');
    });

    it('reads a record returned without a data envelope', async () => {
      const { provider } = build(undefined, RECORD);

      const result = await provider.findByStir('305123456');

      expect(result?.entity.legalName).toBe('Sifat Qurilish MChJ');
    });

    it('keeps the STIR that was asked for rather than the one echoed back', async () => {
      // A provider that answered with a different taxpayer would otherwise
      // file one company's details under another company's tax number.
      const { provider } = build(undefined, {
        data: { ...RECORD, tin: '999999999' },
      });

      const result = await provider.findByStir('305123456');

      expect(result?.entity.stir).toBe('305123456');
    });

    it('refuses a record with no legal name', async () => {
      // Evidence the response shape changed. Half a counterparty reaches a
      // signature page looking complete, so this must not degrade quietly.
      const { provider } = build(undefined, { data: { tin: '305123456' } });

      await expect(provider.findByStir('305123456')).rejects.toBeInstanceOf(
        RegistryUnavailableError,
      );
    });

    it('refuses an unreadable body', async () => {
      const { provider } = build(undefined, 'not json');

      await expect(provider.findByStir('305123456')).rejects.toBeInstanceOf(
        RegistryUnavailableError,
      );
    });
  });

  describe('status mapping', () => {
    it.each([
      ['ACTIVE', 'ACTIVE'],
      ['faol', 'ACTIVE'],
      ['LIQUIDATED', 'LIQUIDATED'],
      ['tugatilgan', 'LIQUIDATED'],
      ['SUSPENDED', 'SUSPENDED'],
    ])('maps %s to %s', async (input, expected) => {
      const { provider } = build(undefined, {
        data: { ...RECORD, status: input },
      });

      const result = await provider.findByStir('305123456');

      expect(result?.entity.status).toBe(expected);
    });

    it.each([['something-new'], [''], [undefined]])(
      'maps an unrecognised status (%s) to UNKNOWN, never ACTIVE',
      async (input) => {
        // The failure that matters is a liquidated counterparty shown as
        // trading, so an unrecognised code must not land on the reassuring
        // value.
        const { provider } = build(undefined, {
          data: { ...RECORD, status: input },
        });

        const result = await provider.findByStir('305123456');

        expect(result?.entity.status).toBe('UNKNOWN');
      },
    );
  });

  describe('error translation', () => {
    it('turns a 404 into "not registered"', async () => {
      const get = jest.fn(() => httpError(404));
      const provider = new IHamkorProvider(
        { get } as unknown as HttpService,
        { get: () => 'test-key' } as unknown as ConfigService,
      );

      await expect(provider.findByStir('305123456')).rejects.toBeInstanceOf(
        NotRegistered,
      );
    });

    it.each([[401], [403]])(
      'treats %s as a deployment fault that will not fix itself',
      async (status) => {
        const get = jest.fn(() => httpError(status));
        const provider = new IHamkorProvider(
          { get } as unknown as HttpService,
          { get: () => 'test-key' } as unknown as ConfigService,
        );

        await expect(provider.findByStir('305123456')).rejects.toMatchObject({
          name: 'RegistryUnavailableError',
          retryable: false,
        });
      },
    );

    it.each([[429], [500], [503]])('treats %s as retryable', async (status) => {
      const get = jest.fn(() => httpError(status));
      const provider = new IHamkorProvider(
        { get } as unknown as HttpService,
        { get: () => 'test-key' } as unknown as ConfigService,
      );

      await expect(provider.findByStir('305123456')).rejects.toMatchObject({
        name: 'RegistryUnavailableError',
        retryable: true,
      });
    });
  });

  describe('request', () => {
    it('sends the API key as a bearer token', async () => {
      const { provider, get } = build(undefined, { data: RECORD });

      await provider.findByStir('305123456');

      expect(get).toHaveBeenCalledWith(
        expect.stringContaining('/v1/legal-entities/305123456'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        }),
      );
    });
  });
});

/**
 * One-time codes for phone sign-in.
 *
 * A correct code IS the sign-in here — the number is unique and proven by
 * possession — so every limit in this file is an authentication control, not a
 * convenience. Three of them are worth stating outright, because none of their
 * failures is visible from the outside:
 *
 *   * The hourly send quota is what stops someone using this service to bill
 *     SMS against a victim's number ("SMS pumping"). Every message costs real
 *     money, so a leak here drains a prepaid balance and takes phone sign-in
 *     down with it.
 *   * The attempt counter has to be burned BEFORE the comparison and the
 *     challenge deleted when it runs out, or an attacker's budget resets on
 *     every request and a 6-digit code becomes brute-forceable.
 *   * A code is bound to the number it was sent to. Without that, a code
 *     captured for one number is replayable against another.
 *
 * Redis is faked rather than mocked: these behaviours are expressed in `MULTI`,
 * `INCR`/`EXPIRE` and `HINCRBY` semantics, and assertions against call
 * arguments would test that the code calls Redis, not that the limits hold.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TooManyRequestsException } from '../../../common/exceptions/too-many-requests.exception';
import type { RedisService } from '../../../redis/redis.service';
import type { DevSmsService } from '../../notification/providers/devsms.service';
import { OtpService } from './otp.service';

// ---------------------------------------------------------------------------
// A Redis good enough to hold the properties under test
// ---------------------------------------------------------------------------

type Entry = { value: string | Record<string, string>; ttl: number | null };

class FakeRedis {
  readonly store = new Map<string, Entry>();

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    return this.store.get(key)?.ttl ?? -2;
  }

  async incr(key: string): Promise<number> {
    const current = Number(this.store.get(key)?.value ?? 0) + 1;
    this.store.set(key, { value: String(current), ttl: this.store.get(key)?.ttl ?? null });
    return current;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.ttl = seconds;
    return 1;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    const exIndex = args.findIndex((arg) => arg === 'EX');
    this.store.set(key, {
      value,
      ttl: exIndex >= 0 ? Number(args[exIndex + 1]) : null,
    });
    return 'OK';
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const value = this.store.get(key)?.value;
    return typeof value === 'object' ? { ...value } : {};
  }

  async hincrby(key: string, field: string, by: number): Promise<number> {
    const entry = this.store.get(key);
    const hash = (typeof entry?.value === 'object' ? entry.value : {}) as Record<string, string>;
    const next = Number(hash[field] ?? 0) + by;
    hash[field] = String(next);
    this.store.set(key, { value: hash, ttl: entry?.ttl ?? null });
    return next;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  /** Queues commands and applies them on exec, which is what MULTI guarantees. */
  multi() {
    const queued: Array<() => Promise<unknown>> = [];
    const chain = {
      hset: (key: string, hash: Record<string, string>) => {
        queued.push(async () => {
          const ttl = this.store.get(key)?.ttl ?? null;
          this.store.set(key, { value: { ...hash }, ttl });
        });
        return chain;
      },
      expire: (key: string, seconds: number) => {
        queued.push(() => this.expire(key, seconds));
        return chain;
      },
      set: (key: string, value: string, ...args: unknown[]) => {
        queued.push(() => this.set(key, value, ...args));
        return chain;
      },
      exec: async () => {
        for (const run of queued) await run();
        return [];
      },
    };
    return chain;
  }
}

function build(
  settings: Record<string, unknown> = {},
  sms: Partial<DevSmsService> = {},
) {
  const redis = new FakeRedis();
  // Parameters are declared so `mock.calls[n][1]` is typed as the code rather
  // than as an element of an empty tuple.
  const sendOtp = jest.fn(async (_phone: string, _code: string) => ({
    providerMessageId: '1',
  }));

  const service = new OtpService(
    { client: redis } as unknown as RedisService,
    {
      get: <T>(key: string, fallback?: T) =>
        (settings[key] as T) ?? fallback,
    } as unknown as ConfigService,
    { isConfigured: () => true, sendOtp, ...sms } as unknown as DevSmsService,
  );

  return { service, redis, sendOtp };
}

/** The code just issued, read back out of the fake. */
function storedHash(redis: FakeRedis): string | undefined {
  for (const [key, entry] of redis.store) {
    if (key.startsWith('otp:code:') && typeof entry.value === 'object') {
      return entry.value.hash;
    }
  }
  return undefined;
}

const PHONE = '+998901234567';

describe('OtpService', () => {
  describe('requestOtp', () => {
    it('reports the code lifetime and the resend cooldown back to the caller', async () => {
      const { service } = build();

      expect(await service.requestOtp(PHONE)).toEqual({
        expiresIn: 300,
        resendAfter: 60,
      });
    });

    it('delivers a code of the configured length', async () => {
      const { service, sendOtp } = build({ OTP_CODE_LENGTH: 6 });

      await service.requestOtp(PHONE);

      expect(sendOtp).toHaveBeenCalledTimes(1);
      expect(sendOtp.mock.calls[0][1]).toMatch(/^\d{6}$/);
    });

    it('pads a code whose random value has leading zeros', async () => {
      // `randomInt(0, 10**6)` returns 42 about once in twenty thousand codes.
      // Sending "42" instead of "000042" is a code the template rejects for
      // being too short.
      const { service, sendOtp } = build();

      // A different number each time, so the cooldown does not reject the run
      // before enough codes have been drawn to be worth checking.
      for (let attempt = 0; attempt < 50; attempt++) {
        await service.requestOtp(`99890${String(attempt).padStart(7, '0')}`);
      }

      for (const call of sendOtp.mock.calls) {
        expect(call[1]).toHaveLength(6);
      }
    });

    it('never writes the code itself, only a digest', async () => {
      const { service, redis, sendOtp } = build();

      await service.requestOtp(PHONE);
      const code = sendOtp.mock.calls[0][1] as string;

      const dump = JSON.stringify([...redis.store.entries()]);
      expect(dump).not.toContain(code);
      expect(storedHash(redis)).toMatch(/^[a-f0-9]{64}$/);
    });

    it('keys by digest, so a phone number never lands in a Redis key', async () => {
      // Keys show up in logs, MONITOR output and crash dumps, and a phone
      // number is personal data.
      const { service, redis } = build();

      await service.requestOtp(PHONE);

      for (const key of redis.store.keys()) {
        expect(key).not.toContain('998901234567');
        expect(key).toMatch(/^otp:(code|cooldown|quota):[a-f0-9]{64}$/);
      }
    });

    it('refuses a second request inside the cooldown', async () => {
      const { service } = build();

      await service.requestOtp(PHONE);

      await expect(service.requestOtp(PHONE)).rejects.toBeInstanceOf(
        TooManyRequestsException,
      );
    });

    it('says how long is left on the cooldown', async () => {
      const { service } = build({ OTP_RESEND_COOLDOWN_SECONDS: 45 });

      await service.requestOtp(PHONE);

      await expect(service.requestOtp(PHONE)).rejects.toThrow(/45s/);
    });

    it('does not send a second message while cooling down', async () => {
      // The cooldown is a spend control as much as a UX one.
      const { service, sendOtp } = build();

      await service.requestOtp(PHONE);
      await service.requestOtp(PHONE).catch(() => undefined);

      expect(sendOtp).toHaveBeenCalledTimes(1);
    });

    describe('hourly quota', () => {
      /** Requests repeatedly, stepping past the cooldown each time. */
      async function requestTimes(times: number, settings: Record<string, unknown> = {}) {
        const { service, redis, sendOtp } = build(settings);
        const results: unknown[] = [];

        for (let attempt = 0; attempt < times; attempt++) {
          // Clearing only the cooldown leaves the quota counter standing, which
          // is exactly the shape of a real attack: wait out the cooldown, ask
          // again.
          for (const key of [...redis.store.keys()]) {
            if (key.startsWith('otp:cooldown:')) redis.store.delete(key);
          }
          results.push(await service.requestOtp(PHONE).catch((error) => error));
        }

        return { results, sendOtp };
      }

      it('allows exactly the configured number of sends in an hour', async () => {
        const { results, sendOtp } = await requestTimes(5, { OTP_MAX_SENDS_PER_HOUR: 5 });

        expect(results.filter((r) => r instanceof Error)).toHaveLength(0);
        expect(sendOtp).toHaveBeenCalledTimes(5);
      });

      it('refuses the one after that, and sends nothing', async () => {
        // This is the SMS-pumping control: without it an attacker bills the
        // account for as many messages as they care to request.
        const { results, sendOtp } = await requestTimes(6, { OTP_MAX_SENDS_PER_HOUR: 5 });

        expect(results[5]).toBeInstanceOf(TooManyRequestsException);
        expect(sendOtp).toHaveBeenCalledTimes(5);
      });

      it('gives the quota counter an expiry, so it is a rate and not a lifetime cap', async () => {
        const { service, redis } = build();

        await service.requestOtp(PHONE);

        const quota = [...redis.store.entries()].find(([key]) =>
          key.startsWith('otp:quota:'),
        );
        expect(quota?.[1].ttl).toBe(3600);
      });
    });
  });

  describe('verifyOtp', () => {
    /** Issues a code and hands it back. */
    async function issue(settings: Record<string, unknown> = {}) {
      const context = build(settings);
      await context.service.requestOtp(PHONE);
      return { ...context, code: context.sendOtp.mock.calls[0][1] as string };
    }

    it('accepts the code it issued', async () => {
      const { service, code } = await issue();

      expect(await service.verifyOtp(PHONE, code)).toBe(true);
    });

    it('rejects a wrong code without throwing', async () => {
      // The caller decides the response; verification only reports.
      const { service, code } = await issue();
      const wrong = code === '000000' ? '000001' : '000000';

      expect(await service.verifyOtp(PHONE, wrong)).toBe(false);
    });

    it('consumes the challenge on success, so a code works once', async () => {
      const { service, code } = await issue();

      expect(await service.verifyOtp(PHONE, code)).toBe(true);
      await expect(service.verifyOtp(PHONE, code)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses when no code was ever requested', async () => {
      const { service } = build();

      await expect(service.verifyOtp(PHONE, '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('will not accept a code issued for a different number', async () => {
      // The digest is bound to the phone number, so a code observed on one
      // number cannot be replayed against another.
      const { service, code } = await issue();

      await service.requestOtp('+998907654321');

      expect(await service.verifyOtp('+998907654321', code)).toBe(false);
    });

    it('treats spacing and punctuation in the number as the same account', async () => {
      // `User.phone` is stored in this normalised form; two normalisations
      // would make one person two accounts.
      const { service, code } = await issue();

      expect(await service.verifyOtp('+998 90 123-45-67', code)).toBe(true);
    });

    describe('attempt budget', () => {
      it('burns an attempt on every guess', async () => {
        const { service, redis, code } = await issue({ OTP_MAX_ATTEMPTS: 5 });
        void code;

        await service.verifyOtp(PHONE, '000000');
        await service.verifyOtp(PHONE, '111111');

        const entry = [...redis.store.entries()].find(([key]) =>
          key.startsWith('otp:code:'),
        );
        expect((entry?.[1].value as Record<string, string>).attempts).toBe('2');
      });

      it('allows exactly the configured number of guesses', async () => {
        const { service } = await issue({ OTP_MAX_ATTEMPTS: 3 });

        for (let attempt = 0; attempt < 3; attempt++) {
          expect(await service.verifyOtp(PHONE, '000000')).toBe(false);
        }
      });

      it('refuses the one after that', async () => {
        const { service } = await issue({ OTP_MAX_ATTEMPTS: 3 });

        for (let attempt = 0; attempt < 3; attempt++) {
          await service.verifyOtp(PHONE, '000000');
        }

        await expect(service.verifyOtp(PHONE, '000000')).rejects.toBeInstanceOf(
          TooManyRequestsException,
        );
      });

      it('destroys the challenge when the budget runs out', async () => {
        // Not just refusing the request: leaving the challenge in place would
        // reset the attacker's budget on the next call, which makes a 6-digit
        // code brute-forceable.
        const { service, redis } = await issue({ OTP_MAX_ATTEMPTS: 2 });

        for (let attempt = 0; attempt < 3; attempt++) {
          await service.verifyOtp(PHONE, '000000').catch(() => undefined);
        }

        expect([...redis.store.keys()].some((key) => key.startsWith('otp:code:'))).toBe(
          false,
        );
      });

      it('will not accept the correct code once the budget is gone', async () => {
        const { service, code } = await issue({ OTP_MAX_ATTEMPTS: 2 });

        for (let attempt = 0; attempt < 3; attempt++) {
          await service.verifyOtp(PHONE, '000000').catch(() => undefined);
        }

        await expect(service.verifyOtp(PHONE, code)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });
  });

  describe('delivery', () => {
    it('sends through the OTP template, not as free text', async () => {
      // Operators only carry moderated wording; custom text is accepted and
      // silently not delivered.
      const send = jest.fn();
      const { service, sendOtp } = build({}, { send } as Partial<DevSmsService>);

      await service.requestOtp(PHONE);

      expect(sendOtp).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });

    it('does not leak the provider’s wording to the caller', async () => {
      // A gateway error can name the account and the sender id.
      const { service } = build(
        {},
        {
          sendOtp: jest.fn(async () => {
            throw new Error('DevSMS refused: account 4546 suspended');
          }),
        },
      );

      const error = await service.requestOtp(PHONE).catch((caught) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).not.toContain('4546');
      expect(error.message).toMatch(/Could not send the code/);
    });

    it('logs only the last four digits of the number', async () => {
      const errors: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          errors.push(String(message));
        });

      const { service } = build(
        {},
        { sendOtp: jest.fn(async () => { throw new Error('down'); }) },
      );

      await service.requestOtp(PHONE).catch(() => undefined);
      spy.mockRestore();

      expect(errors[0]).toContain('4567');
      expect(errors[0]).not.toContain('998901234567');
    });

    it('refuses to issue a code it cannot deliver in production', async () => {
      // The alternative is a user in front of a code box for a message nobody
      // is going to send, with no error anywhere.
      const { service } = build(
        { NODE_ENV: 'production' },
        { isConfigured: () => false },
      );

      await expect(service.requestOtp(PHONE)).rejects.toThrow(/refusing to issue/);
    });

    it('logs the code instead outside production', async () => {
      const warnings: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((message: unknown) => {
          warnings.push(String(message));
        });

      const { service } = build(
        { NODE_ENV: 'development' },
        { isConfigured: () => false },
      );
      await service.requestOtp(PHONE);
      spy.mockRestore();

      // How local development works, and deliberately at `warn` so it is
      // obvious that is what happened.
      expect(warnings.some((line) => /\[dev\] OTP for \*{4}4567: \d{6}/.test(line))).toBe(
        true,
      );
    });
  });

  describe('isAvailable', () => {
    it('is true when a gateway is configured', () => {
      expect(build({ NODE_ENV: 'production' }).service.isAvailable()).toBe(true);
    });

    it('is true without one outside production, where codes go to the log', () => {
      expect(
        build({ NODE_ENV: 'development' }, { isConfigured: () => false }).service.isAvailable(),
      ).toBe(true);
    });

    it('is false in production without one', () => {
      // Mirrors `deliver` exactly. If these two disagreed, the sign-in page
      // would offer a method the API is about to refuse.
      expect(
        build({ NODE_ENV: 'production' }, { isConfigured: () => false }).service.isAvailable(),
      ).toBe(false);
    });
  });

  describe('normalizePhone', () => {
    it.each([
      ['+998 90 123-45-67', '+998901234567'],
      ['(90) 123 45 67', '901234567'],
      ['+998901234567', '+998901234567'],
    ])('reduces %p to %p', (input, expected) => {
      expect(build().service.normalizePhone(input)).toBe(expected);
    });
  });
});

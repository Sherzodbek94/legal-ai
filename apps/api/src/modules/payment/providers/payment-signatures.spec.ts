/**
 * Signature primitives for all four gateways.
 *
 * Separated from the webhook integration tests because these are where a
 * mistake is silent: a wrong field order or a float-parsed amount still
 * produces a plausible-looking digest, and the only symptom is that genuine
 * callbacks start failing — or, worse, forged ones start passing.
 */
import { createHash, createHmac } from 'node:crypto';
import {
  buildClickSignString,
  parseClickAmountToMinorUnits,
  verifyClickSignature,
} from './click/click-signature';
import { paymeAmountToMinorUnits, verifyPaymeAuth } from './payme/payme-auth';
import {
  buildStripeSignatureHeader,
  parseStripeSignatureHeader,
  verifyStripeSignature,
} from './stripe/stripe-signature';
import type { ConfigService } from '@nestjs/config';
import { UzumService } from './uzum/uzum.service';
import type { PaymentService } from '../payment.service';
import type { IdempotencyService } from '../idempotency/idempotency.service';

describe('CLICK signatures', () => {
  const SECRET = 'secret-key';

  const prepareInput = {
    click_trans_id: '900001',
    service_id: '12345',
    merchant_trans_id: 'order_1',
    amount: '49.00',
    action: '0',
    sign_time: '2026-07-30 10:00:00',
  };

  it('concatenates the Prepare fields in the documented order', () => {
    // Field order is the protocol; an alphabetical or object-key order would
    // produce a digest that never matches CLICK's.
    const expected = createHash('md5')
      .update('900001' + '12345' + SECRET + 'order_1' + '49.00' + '0' + '2026-07-30 10:00:00')
      .digest('hex');

    expect(buildClickSignString(prepareInput, SECRET)).toBe(expected);
  });

  it('inserts merchant_prepare_id for the Complete action', () => {
    const completeInput = {
      ...prepareInput,
      action: '1',
      merchant_prepare_id: '900001',
    };

    const expected = createHash('md5')
      .update(
        '900001' + '12345' + SECRET + 'order_1' + '900001' + '49.00' + '1' + '2026-07-30 10:00:00',
      )
      .digest('hex');

    expect(buildClickSignString(completeInput, SECRET)).toBe(expected);
  });

  it('produces a different digest for Prepare and Complete', () => {
    const complete = { ...prepareInput, action: '1', merchant_prepare_id: '900001' };
    expect(buildClickSignString(prepareInput, SECRET)).not.toBe(
      buildClickSignString(complete, SECRET),
    );
  });

  describe('verification', () => {
    it('accepts a correct signature', () => {
      const sign_string = buildClickSignString(prepareInput, SECRET);
      expect(verifyClickSignature({ ...prepareInput, sign_string }, SECRET)).toBe(true);
    });

    it('accepts an uppercase digest, which some clients send', () => {
      const sign_string = buildClickSignString(prepareInput, SECRET).toUpperCase();
      expect(verifyClickSignature({ ...prepareInput, sign_string }, SECRET)).toBe(true);
    });

    it('rejects a digest computed with a different secret', () => {
      const sign_string = buildClickSignString(prepareInput, 'other-secret');
      expect(verifyClickSignature({ ...prepareInput, sign_string }, SECRET)).toBe(false);
    });

    it('rejects an altered amount', () => {
      const sign_string = buildClickSignString(prepareInput, SECRET);
      expect(
        verifyClickSignature(
          { ...prepareInput, amount: '4900.00', sign_string },
          SECRET,
        ),
      ).toBe(false);
    });

    it('rejects a missing or empty signature', () => {
      expect(verifyClickSignature({ ...prepareInput }, SECRET)).toBe(false);
      expect(
        verifyClickSignature({ ...prepareInput, sign_string: '' }, SECRET),
      ).toBe(false);
    });

    it('rejects a wrong-length signature without throwing', () => {
      // timingSafeEqual throws on unequal lengths; the guard must come first.
      expect(() =>
        verifyClickSignature({ ...prepareInput, sign_string: 'abc' }, SECRET),
      ).not.toThrow();
      expect(
        verifyClickSignature({ ...prepareInput, sign_string: 'abc' }, SECRET),
      ).toBe(false);
    });
  });

  describe('amount parsing', () => {
    it('converts a decimal string to minor units exactly', () => {
      expect(parseClickAmountToMinorUnits('49.00')).toBe(4900);
      expect(parseClickAmountToMinorUnits('0.01')).toBe(1);
      expect(parseClickAmountToMinorUnits('1000')).toBe(100_000);
    });

    it('does not lose a cent to floating-point rounding', () => {
      // `49.29 * 100` is 4928.9999... in IEEE 754 and truncates to 4928.
      expect(parseClickAmountToMinorUnits('49.29')).toBe(4929);
      expect(parseClickAmountToMinorUnits('1.10')).toBe(110);
      expect(parseClickAmountToMinorUnits('8.70')).toBe(870);
    });

    it('pads a single decimal place', () => {
      expect(parseClickAmountToMinorUnits('49.5')).toBe(4950);
    });

    it('rejects anything that is not a plain decimal amount', () => {
      expect(parseClickAmountToMinorUnits('49.001')).toBeNull();
      expect(parseClickAmountToMinorUnits('-49.00')).toBeNull();
      expect(parseClickAmountToMinorUnits('49,00')).toBeNull();
      expect(parseClickAmountToMinorUnits('abc')).toBeNull();
      expect(parseClickAmountToMinorUnits('')).toBeNull();
      expect(parseClickAmountToMinorUnits('1e3')).toBeNull();
    });
  });
});

describe('Payme authentication', () => {
  const KEY = 'merchant-key';
  const header = (login: string, password: string) =>
    `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

  it('accepts the documented Paycom login with the merchant key', () => {
    expect(verifyPaymeAuth(header('Paycom', KEY), KEY)).toBe(true);
  });

  it('rejects a wrong key', () => {
    expect(verifyPaymeAuth(header('Paycom', 'wrong'), KEY)).toBe(false);
  });

  it('rejects a wrong login', () => {
    expect(verifyPaymeAuth(header('Merchant', KEY), KEY)).toBe(false);
  });

  it('rejects a missing or non-Basic header', () => {
    expect(verifyPaymeAuth(undefined, KEY)).toBe(false);
    expect(verifyPaymeAuth(`Bearer ${KEY}`, KEY)).toBe(false);
    expect(verifyPaymeAuth('Basic', KEY)).toBe(false);
  });

  it('rejects everything when no key is configured', () => {
    // An unconfigured environment must refuse callbacks, not accept them all.
    expect(verifyPaymeAuth(header('Paycom', ''), '')).toBe(false);
  });

  it('splits on the first colon, so a key containing one still works', () => {
    const key = 'abc:def';
    expect(verifyPaymeAuth(header('Paycom', key), key)).toBe(true);
  });

  it('rejects malformed base64 without throwing', () => {
    expect(() => verifyPaymeAuth('Basic !!!!', KEY)).not.toThrow();
    expect(verifyPaymeAuth('Basic !!!!', KEY)).toBe(false);
  });

  describe('amounts', () => {
    it('accepts non-negative integer tiyin', () => {
      expect(paymeAmountToMinorUnits(490_000)).toBe(490_000);
      expect(paymeAmountToMinorUnits(0)).toBe(0);
    });

    it('rejects fractional, negative, and non-numeric amounts', () => {
      expect(paymeAmountToMinorUnits(1.5)).toBeNull();
      expect(paymeAmountToMinorUnits(-1)).toBeNull();
      expect(paymeAmountToMinorUnits('490000')).toBeNull();
      expect(paymeAmountToMinorUnits(Number.NaN)).toBeNull();
    });
  });
});

describe('Stripe signatures', () => {
  const SECRET = 'whsec_test';
  const BODY = '{"id":"evt_1","type":"payment_intent.succeeded"}';
  const NOW = new Date('2026-07-30T12:00:00Z');
  const TIMESTAMP = Math.floor(NOW.getTime() / 1000);

  const validHeader = () => buildStripeSignatureHeader(BODY, SECRET, TIMESTAMP);

  it('parses a header into a timestamp and signatures', () => {
    expect(parseStripeSignatureHeader('t=123,v1=abc,v1=def')).toEqual({
      timestamp: 123,
      signatures: ['abc', 'def'],
    });
  });

  it('ignores schemes other than v1', () => {
    expect(parseStripeSignatureHeader('t=123,v0=xyz,v1=abc')?.signatures).toEqual([
      'abc',
    ]);
  });

  it('returns null for a header with no timestamp or no signature', () => {
    expect(parseStripeSignatureHeader('v1=abc')).toBeNull();
    expect(parseStripeSignatureHeader('t=123')).toBeNull();
    expect(parseStripeSignatureHeader(undefined)).toBeNull();
  });

  it('accepts a correctly signed payload', () => {
    expect(
      verifyStripeSignature(BODY, validHeader(), SECRET, { now: NOW }),
    ).toEqual({ valid: true });
  });

  it('signs the raw bytes, so a re-serialised body fails', () => {
    // Same JSON, different key order — exactly what JSON.parse + stringify
    // produces, and why the controller must read req.rawBody.
    const reserialized = '{"type":"payment_intent.succeeded","id":"evt_1"}';
    expect(
      verifyStripeSignature(reserialized, validHeader(), SECRET, { now: NOW }),
    ).toEqual({ valid: false, reason: 'NO_MATCHING_SIGNATURE' });
  });

  it('rejects a payload signed with a different secret', () => {
    const header = buildStripeSignatureHeader(BODY, 'whsec_other', TIMESTAMP);
    expect(verifyStripeSignature(BODY, header, SECRET, { now: NOW }).valid).toBe(
      false,
    );
  });

  it('rejects a replay outside the tolerance window', () => {
    const old = buildStripeSignatureHeader(BODY, SECRET, TIMESTAMP - 3600);
    expect(verifyStripeSignature(BODY, old, SECRET, { now: NOW })).toEqual({
      valid: false,
      reason: 'TIMESTAMP_OUT_OF_TOLERANCE',
    });
  });

  it('rejects a forward-dated timestamp as well as a stale one', () => {
    const future = buildStripeSignatureHeader(BODY, SECRET, TIMESTAMP + 3600);
    expect(verifyStripeSignature(BODY, future, SECRET, { now: NOW }).valid).toBe(
      false,
    );
  });

  it('accepts a timestamp inside the window', () => {
    const recent = buildStripeSignatureHeader(BODY, SECRET, TIMESTAMP - 60);
    expect(verifyStripeSignature(BODY, recent, SECRET, { now: NOW }).valid).toBe(
      true,
    );
  });

  it('accepts when any one of several signatures matches', () => {
    // Stripe sends multiple v1 values while a secret is being rotated.
    const good = createHmac('sha256', SECRET)
      .update(`${TIMESTAMP}.${BODY}`)
      .digest('hex');
    const header = `t=${TIMESTAMP},v1=${'0'.repeat(64)},v1=${good}`;

    expect(verifyStripeSignature(BODY, header, SECRET, { now: NOW }).valid).toBe(
      true,
    );
  });

  it('reports a malformed header distinctly from a bad signature', () => {
    expect(verifyStripeSignature(BODY, 'garbage', SECRET, { now: NOW })).toEqual({
      valid: false,
      reason: 'MALFORMED_HEADER',
    });
  });

  it('handles a Buffer body identically to a string', () => {
    expect(
      verifyStripeSignature(Buffer.from(BODY, 'utf8'), validHeader(), SECRET, {
        now: NOW,
      }).valid,
    ).toBe(true);
  });
});

/**
 * Uzum.
 *
 * The gateway the other three's protections were never extended to: until this
 * block there was no test anywhere that a forged Uzum callback is rejected,
 * which made it the one place a wrong signature could have gone unnoticed.
 *
 * The base string itself is ASSUMED — Uzum issues its integration contract per
 * merchant and this implements the shape their public checkout documentation
 * describes. These tests therefore pin what the code does, not what the
 * contract says. They will keep passing if the two disagree; reconciling them
 * is a separate, manual job against the issued contract. What they do
 * guarantee is that the protections around the base string hold, and that any
 * future change to it is deliberate rather than accidental.
 */
describe('Uzum signatures', () => {
  const SECRET = 'uzum-secret';
  const MERCHANT = 'merchant-1';

  const CALLBACK = {
    operation: 'confirm' as const,
    transactionId: 'utx-900001',
    orderId: 'order_1',
    amount: 4_900_000,
    signature: '',
  };

  function build(settings: Record<string, string> = {}) {
    const config = {
      get: (key: string, fallback?: string) =>
        ({ UZUM_SECRET_KEY: SECRET, UZUM_MERCHANT_ID: MERCHANT, ...settings })[key] ??
        fallback ??
        '',
    } as unknown as ConfigService;

    return new UzumService(
      {} as unknown as PaymentService,
      {} as unknown as IdempotencyService,
      config,
    );
  }

  /** A correctly signed copy of a callback. */
  function signed(overrides: Partial<typeof CALLBACK> = {}) {
    const service = build();
    const dto = { ...CALLBACK, ...overrides };
    return { service, dto: { ...dto, signature: service.buildSignature(dto) } };
  }

  it('signs transactionId, orderId, amount and merchantId, in that order', () => {
    // Field order is the protocol. An object-key or alphabetical order would
    // produce a digest that never matches Uzum's.
    const expected = createHmac('sha256', SECRET)
      .update(['utx-900001', 'order_1', '4900000', MERCHANT].join('|'))
      .digest('hex');

    expect(build().buildSignature(CALLBACK)).toBe(expected);
  });

  it('signs the amount as integer minor units', () => {
    // A float-formatted amount ("49000.00") digests differently and would make
    // every genuine callback fail. Minor units everywhere is the house rule.
    const asFloat = createHmac('sha256', SECRET)
      .update(['utx-900001', 'order_1', '4900000.00', MERCHANT].join('|'))
      .digest('hex');

    expect(build().buildSignature(CALLBACK)).not.toBe(asFloat);
  });

  it('accepts a correctly signed callback', () => {
    const { service, dto } = signed();
    expect(service.verifySignature(dto)).toBe(true);
  });

  it('rejects a callback whose amount was altered after signing', () => {
    // THE property. The amount is inside the signed base string, so raising it
    // invalidates the signature — without that, a forged callback could settle
    // an order for any figure it liked.
    const { service, dto } = signed();

    expect(service.verifySignature({ ...dto, amount: 999_999_999 })).toBe(false);
  });

  it('rejects a callback pointed at a different order', () => {
    const { service, dto } = signed();

    expect(service.verifySignature({ ...dto, orderId: 'order_2' })).toBe(false);
  });

  it('rejects a callback replayed under a different transaction id', () => {
    const { service, dto } = signed();

    expect(service.verifySignature({ ...dto, transactionId: 'utx-900002' })).toBe(false);
  });

  it('rejects a signature produced with another secret', () => {
    const attacker = new UzumService(
      {} as unknown as PaymentService,
      {} as unknown as IdempotencyService,
      {
        get: (key: string) =>
          ({ UZUM_SECRET_KEY: 'wrong-secret', UZUM_MERCHANT_ID: MERCHANT })[key] ?? '',
      } as unknown as ConfigService,
    );

    const forged = { ...CALLBACK, signature: attacker.buildSignature(CALLBACK) };

    expect(build().verifySignature(forged)).toBe(false);
  });

  it('accepts an uppercase signature', () => {
    // Hex case carries no meaning, and a gateway that upper-cases its digest
    // would otherwise have every callback rejected.
    const { service, dto } = signed();

    expect(service.verifySignature({ ...dto, signature: dto.signature.toUpperCase() })).toBe(
      true,
    );
  });

  it('fails closed when no secret is configured', () => {
    // The secret is the only thing authenticating a payment confirmation. With
    // none, every callback is rejected rather than accepted unsigned.
    const service = build({ UZUM_SECRET_KEY: '' });

    expect(service.verifySignature({ ...CALLBACK, signature: 'anything' })).toBe(false);
  });

  it.each([
    ['', 'empty'],
    [undefined, 'missing'],
    [42, 'not a string'],
  ])('rejects a %p signature (%s)', (signature, _description) => {
      // A short or absent value must not reach timingSafeEqual, which throws on
      // a length mismatch — a throw here would become a 500 instead of a clean
      // rejection.
      expect(
        build().verifySignature({
          ...CALLBACK,
          signature: signature as unknown as string,
        }),
      ).toBe(false);
    },
  );

  it('rejects a signature of the wrong length without throwing', () => {
    expect(build().verifySignature({ ...CALLBACK, signature: 'abc123' })).toBe(false);
  });

  it('refuses the callback outright when the signature does not verify', async () => {
    // The handler must stop before any payment state is touched: the stubbed
    // PaymentService below would throw if it were reached.
    const { dto } = signed();

    await expect(
      build().handle({ ...dto, amount: 1 } as never),
    ).resolves.toEqual({ status: 'FAILED', errorCode: 'INVALID_SIGNATURE' });
  });
});

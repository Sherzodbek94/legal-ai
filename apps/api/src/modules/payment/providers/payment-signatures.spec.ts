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

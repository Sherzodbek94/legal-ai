/**
 * CLICK webhook integration tests.
 *
 * Drives a real Nest application over HTTP with supertest, so the request
 * passes through the global ValidationPipe, the controller, the service, and
 * the settlement path exactly as it would in production. Only the database is
 * substituted (see __testing__/in-memory-prisma).
 *
 * The cases that matter most are the retries: CLICK re-delivers Prepare and
 * Complete on any timeout or non-2xx, and "the second delivery must not charge
 * again" is the property this module exists to guarantee.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  PaymentOrderStatus,
  PaymentProvider,
  PaymentStatus,
  ProviderTransactionState,
} from '@legaltech/database';
import { ClickController } from './click.controller';
import { ClickService } from './click.service';
import { buildClickSignString } from './click-signature';
import { ClickError } from './click-errors';
import { PaymentService } from '../../payment.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { InMemoryPrisma } from '../../__testing__/in-memory-prisma';

const SECRET = 'click-secret-key';
const SERVICE_ID = '12345';

/** Builds a correctly signed callback; individual tests override fields. */
function callback(
  overrides: Record<string, string> = {},
  { sign = true }: { sign?: boolean } = {},
) {
  const base: Record<string, string> = {
    click_trans_id: '900001',
    service_id: SERVICE_ID,
    merchant_trans_id: 'order_1',
    amount: '49.00',
    action: '0',
    error: '0',
    error_note: 'Success',
    sign_time: '2026-07-30 10:00:00',
    ...overrides,
  };

  if (sign) {
    base.sign_string = buildClickSignString(base as never, SECRET);
  }
  return base;
}

describe('CLICK webhooks (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;

  beforeAll(async () => {
    db = new InMemoryPrisma();

    const moduleRef = await Test.createTestingModule({
      controllers: [ClickController],
      providers: [
        ClickService,
        PaymentService,
        IdempotencyService,
        { provide: PrismaService, useValue: db },
        {
          provide: ConfigService,
          useValue: {
            get: <T>(key: string, fallback?: T) => {
              const values: Record<string, unknown> = {
                CLICK_SECRET_KEY: SECRET,
                CLICK_SERVICE_ID: SERVICE_ID,
              };
              return (values[key] as T) ?? fallback;
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Same pipe configuration as main.ts, so DTO rejection behaves identically.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    db.reset();
    db.seedOrder({ id: 'order_1', amountCents: 4900, currency: 'usd' });
  });

  const prepare = (body: Record<string, string>) =>
    request(app.getHttpServer()).post('/payments/click/prepare').send(body);

  const complete = (body: Record<string, string>) =>
    request(app.getHttpServer()).post('/payments/click/complete').send(body);

  // ---------------------------------------------------------------------------
  // Signature
  // ---------------------------------------------------------------------------

  describe('signature verification', () => {
    it('accepts a correctly signed Prepare', async () => {
      const response = await prepare(callback()).expect(200);
      expect(response.body.error).toBe(ClickError.SUCCESS);
    });

    it('rejects a tampered amount, even though the field itself is valid', async () => {
      // Sign for 49.00, then present 4900.00 — the classic "pay one, claim
      // more" alteration.
      const body = callback();
      body.amount = '4900.00';

      const response = await prepare(body).expect(200);
      expect(response.body.error).toBe(ClickError.SIGN_CHECK_FAILED);
    });

    it('rejects a wrong signature', async () => {
      const body = callback({}, { sign: false });
      body.sign_string = 'f'.repeat(32);

      const response = await prepare(body).expect(200);
      expect(response.body.error).toBe(ClickError.SIGN_CHECK_FAILED);
    });

    it('rejects a signature of the wrong length without crashing', async () => {
      const body = callback({}, { sign: false });
      body.sign_string = 'abc';

      const response = await prepare(body).expect(200);
      expect(response.body.error).toBe(ClickError.SIGN_CHECK_FAILED);
    });

    it('rejects a callback for another service_id', async () => {
      const body = callback({ service_id: '99999' });
      const response = await prepare(body).expect(200);
      expect(response.body.error).toBe(ClickError.SIGN_CHECK_FAILED);
    });

    it('answers 200 even when refusing, so CLICK does not retry forever', async () => {
      const body = callback({}, { sign: false });
      body.sign_string = 'f'.repeat(32);
      // A 4xx here would read as an undelivered callback and be retried
      // indefinitely.
      await prepare(body).expect(200);
    });

    it('rejects a body missing required protocol fields', async () => {
      await prepare({ click_trans_id: '1' } as never).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Prepare
  // ---------------------------------------------------------------------------

  describe('prepare', () => {
    it('registers a transaction against the order', async () => {
      const response = await prepare(callback()).expect(200);

      expect(response.body).toMatchObject({
        error: ClickError.SUCCESS,
        merchant_trans_id: 'order_1',
        merchant_prepare_id: 900001,
      });

      expect(db.tables.providerTransaction).toHaveLength(1);
      expect(db.tables.providerTransaction[0]).toMatchObject({
        provider: PaymentProvider.CLICK,
        providerTransactionId: '900001',
        state: ProviderTransactionState.CREATED,
      });
    });

    it('rejects an unknown order', async () => {
      const response = await prepare(
        callback({ merchant_trans_id: 'order_missing' }),
      ).expect(200);

      expect(response.body.error).toBe(ClickError.ORDER_NOT_FOUND);
    });

    it('rejects an amount that does not match the order', async () => {
      // Correctly signed for 10.00, but the order is 49.00.
      const response = await prepare(callback({ amount: '10.00' })).expect(200);
      expect(response.body.error).toBe(ClickError.INCORRECT_AMOUNT);
      expect(db.tables.providerTransaction).toHaveLength(0);
    });

    it('reports an already-paid order rather than re-preparing it', async () => {
      db.tables.paymentOrder[0].status = PaymentOrderStatus.PAID;

      const response = await prepare(callback()).expect(200);
      expect(response.body.error).toBe(ClickError.ALREADY_PAID);
    });

    it('rejects an expired order', async () => {
      db.tables.paymentOrder[0].status = PaymentOrderStatus.EXPIRED;

      const response = await prepare(callback()).expect(200);
      expect(response.body.error).toBe(ClickError.TRANSACTION_CANCELLED);
    });

    it('rejects the wrong action on the prepare endpoint', async () => {
      const response = await prepare(callback({ action: '1' })).expect(200);
      expect(response.body.error).toBe(ClickError.ACTION_NOT_FOUND);
    });

    it('is idempotent: a redelivered Prepare creates no second transaction', async () => {
      const body = callback();

      const first = await prepare(body).expect(200);
      const second = await prepare(body).expect(200);

      expect(second.body).toEqual(first.body);
      expect(db.tables.providerTransaction).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Complete
  // ---------------------------------------------------------------------------

  describe('complete', () => {
    const completeBody = () =>
      callback({
        action: '1',
        merchant_prepare_id: '900001',
      });

    beforeEach(async () => {
      await prepare(callback());
    });

    it('captures the payment and marks the order paid', async () => {
      const response = await complete(completeBody()).expect(200);

      expect(response.body).toMatchObject({
        error: ClickError.SUCCESS,
        merchant_confirm_id: 900001,
      });

      expect(db.tables.paymentOrder[0].status).toBe(PaymentOrderStatus.PAID);
      expect(db.tables.paymentOrder[0].paidAt).toBeInstanceOf(Date);
      expect(db.tables.providerTransaction[0].state).toBe(
        ProviderTransactionState.PERFORMED,
      );
    });

    it('writes exactly one ledger entry', async () => {
      await complete(completeBody()).expect(200);

      expect(db.tables.paymentTransaction).toHaveLength(1);
      expect(db.tables.paymentTransaction[0]).toMatchObject({
        provider: PaymentProvider.CLICK,
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4900,
      });
    });

    it('does not double-bill when CLICK redelivers Complete', async () => {
      const body = completeBody();

      const first = await complete(body).expect(200);
      const second = await complete(body).expect(200);
      const third = await complete(body).expect(200);

      // Every delivery reports success — from CLICK's side the transaction is
      // performed — but only one charge exists.
      expect(first.body.error).toBe(ClickError.SUCCESS);
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);

      expect(db.tables.paymentTransaction).toHaveLength(1);
    });

    it('does not double-bill when two deliveries race', async () => {
      const body = completeBody();

      const responses = await Promise.all([
        complete(body),
        complete(body),
        complete(body),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.body.error).toBe(ClickError.SUCCESS);
      }
      expect(db.tables.paymentTransaction).toHaveLength(1);
    });

    it('rejects a Complete with no preceding Prepare', async () => {
      const body = callback({
        click_trans_id: '900999',
        action: '1',
        merchant_prepare_id: '900999',
      });

      const response = await complete(body).expect(200);
      expect(response.body.error).toBe(ClickError.TRANSACTION_NOT_FOUND);
    });

    it('cancels rather than captures when CLICK reports a failure', async () => {
      const body = callback({
        action: '1',
        merchant_prepare_id: '900001',
        error: '-5001',
        error_note: 'Payment failed',
      });

      const response = await complete(body).expect(200);

      expect(response.body.error).toBe(ClickError.TRANSACTION_CANCELLED);
      expect(db.tables.providerTransaction[0].state).toBe(
        ProviderTransactionState.CANCELED,
      );
      expect(db.tables.paymentOrder[0].status).toBe(PaymentOrderStatus.CANCELED);
      expect(db.tables.paymentTransaction).toHaveLength(0);
    });

    it('refuses to capture a transaction that was already cancelled', async () => {
      // Fresh transaction id so the assertion exercises the state check rather
      // than the replay cache.
      db.seedTransaction({
        provider: PaymentProvider.CLICK,
        providerTransactionId: '900002',
        orderId: 'order_1',
        state: ProviderTransactionState.CANCELED,
      });

      const response = await complete(
        callback({
          click_trans_id: '900002',
          action: '1',
          merchant_prepare_id: '900002',
        }),
      ).expect(200);

      expect(response.body.error).toBe(ClickError.TRANSACTION_CANCELLED);
      expect(db.tables.paymentTransaction).toHaveLength(0);
    });

    it('refuses contradictory Completes for one transaction, in-band', async () => {
      // First delivery cancels; a second claiming success for the same
      // click_trans_id contradicts it. Answering 409 would be correct in
      // isolation and disastrous here — CLICK retries any non-2xx forever.
      await complete(
        callback({
          action: '1',
          merchant_prepare_id: '900001',
          error: '-5001',
        }),
      ).expect(200);

      const response = await complete(completeBody()).expect(200);

      expect(response.body.error).toBe(ClickError.ERROR_IN_REQUEST);
      expect(db.tables.paymentTransaction).toHaveLength(0);
    });

    it('rejects the wrong action on the complete endpoint', async () => {
      const response = await complete(callback({ action: '0' })).expect(200);
      expect(response.body.error).toBe(ClickError.ACTION_NOT_FOUND);
    });
  });

  // ---------------------------------------------------------------------------
  // Subscription activation
  // ---------------------------------------------------------------------------

  describe('subscription activation', () => {
    it('activates the plan in the same transaction as the capture', async () => {
      db.reset();
      db.tables.subscription.push({
        id: 'sub_1',
        companyId: 'co_1',
        plan: 'FREE',
        status: 'ACTIVE',
        currentPeriodEnd: null,
      });
      db.seedOrder({
        id: 'order_1',
        amountCents: 4900,
        subscriptionId: 'sub_1',
        plan: 'PRO',
      });

      await prepare(callback()).expect(200);
      await complete(
        callback({ action: '1', merchant_prepare_id: '900001' }),
      ).expect(200);

      expect(db.tables.subscription[0]).toMatchObject({
        plan: 'PRO',
        status: 'ACTIVE',
      });
      expect(db.tables.subscription[0].currentPeriodEnd).toBeInstanceOf(Date);
    });
  });
});

/**
 * Uzum callback integration tests.
 *
 * Drives a real Nest application over HTTP with supertest, so the request goes
 * through the global ValidationPipe, the controller, the service and the
 * settlement path exactly as it would in production. Only the database is
 * substituted (see __testing__/in-memory-prisma), and it reproduces the unique
 * constraints the retry paths actually rely on.
 *
 * Uzum re-delivers on any timeout or non-2xx, so "the second delivery must not
 * charge again" is the property this module exists to guarantee — same as CLICK
 * and Payme. Two independent layers enforce it and both are exercised here: the
 * idempotency record keyed on operation + transaction id, and the conditional
 * state claim inside `capture` that a concurrent delivery cannot pass twice.
 *
 * As in the signature tests: the wire contract is Uzum's published checkout
 * shape, not the per-merchant agreement, and reconciling the two is still a
 * manual job. These pin the behaviour around it.
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
import { UzumController } from './uzum.controller';
import { UzumService } from './uzum.service';
import { PaymentService } from '../../payment.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { InMemoryPrisma } from '../../__testing__/in-memory-prisma';

const SECRET = 'uzum-secret-key';
const MERCHANT = 'merchant-1';

describe('Uzum callbacks (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let uzum: UzumService;

  beforeAll(async () => {
    db = new InMemoryPrisma();

    const moduleRef = await Test.createTestingModule({
      controllers: [UzumController],
      providers: [
        UzumService,
        PaymentService,
        IdempotencyService,
        { provide: PrismaService, useValue: db },
        {
          provide: ConfigService,
          useValue: {
            get: <T>(key: string, fallback?: T) => {
              const values: Record<string, unknown> = {
                UZUM_SECRET_KEY: SECRET,
                UZUM_MERCHANT_ID: MERCHANT,
              };
              return (values[key] as T) ?? fallback;
            },
          },
        },
      ],
    }).compile();

    uzum = moduleRef.get(UzumService);

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
    db.seedOrder({ id: 'order_1', amountCents: 4900, currency: 'uzs' });
  });

  /** A correctly signed callback; individual tests override fields. */
  function callback(
    overrides: Partial<{
      operation: string;
      transactionId: string;
      orderId: string;
      amount: number;
      reason: number;
    }> = {},
    { sign = true }: { sign?: boolean } = {},
  ) {
    const base = {
      operation: 'check',
      transactionId: 'utx-900001',
      orderId: 'order_1',
      amount: 4900,
      ...overrides,
    } as Record<string, unknown>;

    return sign
      ? { ...base, signature: uzum.buildSignature(base as never) }
      : base;
  }

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/payments/uzum').send(body);

  const ledger = () =>
    db.tables.paymentTransaction as unknown as Array<Record<string, unknown>>;

  // ---------------------------------------------------------------------------
  // Signature, over HTTP
  // ---------------------------------------------------------------------------

  describe('signature verification', () => {
    it('accepts a correctly signed callback', async () => {
      const response = await post(callback()).expect(200);
      expect(response.body.status).toBe('OK');
    });

    it('rejects a tampered amount, even though the field itself is valid', async () => {
      // Sign for 4900, present 490000 — the classic "pay one, claim more".
      const body = callback();
      body.amount = 490_000;

      const response = await post(body).expect(200);
      expect(response.body).toEqual({
        status: 'FAILED',
        errorCode: 'INVALID_SIGNATURE',
      });
    });

    it('answers 200 even when refusing, so Uzum does not retry forever', async () => {
      // A 4xx here reads as an undelivered callback and is redelivered
      // indefinitely.
      await post({ ...callback({}, { sign: false }), signature: 'f'.repeat(64) }).expect(
        200,
      );
    });

    it('touches no payment state when the signature fails', async () => {
      await post({ ...callback({ operation: 'confirm' }, { sign: false }), signature: 'f'.repeat(64) });

      expect(db.tables.providerTransaction).toHaveLength(0);
      expect(ledger()).toHaveLength(0);
    });

    it('rejects a body missing required protocol fields', async () => {
      await post({ operation: 'check' }).expect(400);
    });

    it('rejects an unknown operation at the DTO, before any handler runs', async () => {
      await post(callback({ operation: 'refund' })).expect(400);
    });

    it('rejects an unexpected extra field', async () => {
      // `forbidNonWhitelisted` — an unrecognised field means the wire contract
      // moved, and guessing at it is how a signature silently stops covering
      // something.
      await post({ ...callback(), unexpected: 'x' }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // check
  // ---------------------------------------------------------------------------

  describe('check', () => {
    it('confirms a payable order', async () => {
      const response = await post(callback()).expect(200);

      expect(response.body).toMatchObject({
        status: 'OK',
        orderId: 'order_1',
        amount: 4900,
      });
    });

    it('reports an unknown order rather than inventing one', async () => {
      const response = await post(callback({ orderId: 'order_missing' })).expect(200);

      expect(response.body).toEqual({
        status: 'FAILED',
        errorCode: 'ORDER_NOT_FOUND',
      });
    });

    it('refuses an order that is already paid', async () => {
      db.reset();
      db.seedOrder({ id: 'order_1', status: PaymentOrderStatus.PAID });

      const response = await post(callback()).expect(200);
      expect(response.body.errorCode).toBe('ORDER_NOT_FOUND');
    });

    it('refuses an expired order', async () => {
      db.reset();
      db.seedOrder({ id: 'order_1', expiresAt: new Date(Date.now() - 1000) });

      const response = await post(callback()).expect(200);
      expect(response.body.errorCode).toBe('ORDER_NOT_FOUND');
    });

    it('refuses an amount that does not match the order', async () => {
      // Signed correctly for 5000, but the order is for 4900. The signature
      // proves who sent it, not that the figure is right.
      const response = await post(callback({ amount: 5000 })).expect(200);

      expect(response.body).toEqual({
        status: 'FAILED',
        errorCode: 'INVALID_AMOUNT',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  describe('create', () => {
    const create = (overrides = {}) =>
      post(callback({ operation: 'create', ...overrides }));

    it('registers a transaction against the order', async () => {
      const response = await create().expect(200);

      expect(response.body).toMatchObject({
        status: 'OK',
        transactionId: 'utx-900001',
        state: ProviderTransactionState.CREATED,
      });
      expect(db.tables.providerTransaction).toHaveLength(1);
    });

    it('does not create a second transaction when redelivered', async () => {
      await create().expect(200);
      await create().expect(200);

      expect(db.tables.providerTransaction).toHaveLength(1);
    });

    it('refuses to register against an unknown order', async () => {
      const response = await create({ orderId: 'order_missing' }).expect(200);

      expect(response.body.errorCode).toBe('ORDER_NOT_FOUND');
      expect(db.tables.providerTransaction).toHaveLength(0);
    });

    it('refuses a mismatched amount without registering anything', async () => {
      const response = await create({ amount: 5000 }).expect(200);

      expect(response.body.errorCode).toBe('INVALID_AMOUNT');
      expect(db.tables.providerTransaction).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // confirm — where the money moves
  // ---------------------------------------------------------------------------

  describe('confirm', () => {
    const confirm = (overrides = {}) =>
      post(callback({ operation: 'confirm', ...overrides }));

    beforeEach(async () => {
      await post(callback({ operation: 'create' }));
    });

    it('settles the order', async () => {
      const response = await confirm().expect(200);

      expect(response.body).toMatchObject({
        status: 'OK',
        orderId: 'order_1',
        state: ProviderTransactionState.PERFORMED,
      });

      const order = db.tables.paymentOrder[0] as unknown as Record<string, unknown>;
      expect(order.status).toBe(PaymentOrderStatus.PAID);
      expect(order.paidAt).toBeInstanceOf(Date);
    });

    it('writes exactly one ledger entry', async () => {
      await confirm().expect(200);

      expect(ledger()).toHaveLength(1);
      expect(ledger()[0]).toMatchObject({
        provider: PaymentProvider.UZUM,
        amountCents: 4900,
        status: PaymentStatus.SUCCEEDED,
      });
    });

    it('does NOT charge again when the callback is redelivered', async () => {
      // The property the module exists for. Uzum redelivers on any timeout, and
      // a second ledger row is a second charge against a real customer.
      await confirm().expect(200);
      await confirm().expect(200);
      await confirm().expect(200);

      expect(ledger()).toHaveLength(1);
    });

    it('still reports success on a redelivery, so Uzum stops retrying', async () => {
      await confirm().expect(200);
      const second = await confirm().expect(200);

      // From Uzum's side the transaction is confirmed either way; reporting a
      // failure would put it into a retry loop over a settled payment.
      expect(second.body.status).toBe('OK');
    });

    it('does not charge twice even when the idempotency record is lost', async () => {
      // The second line of defence: `capture` claims the transaction with a
      // conditional update, so two deliveries that both get past the
      // idempotency layer still produce one ledger row.
      await confirm().expect(200);
      db.tables.idempotencyRecord.length = 0;

      await confirm().expect(200);

      expect(ledger()).toHaveLength(1);
    });

    it('reports an unknown transaction rather than settling anything', async () => {
      const response = await confirm({ transactionId: 'utx-unknown' }).expect(200);

      expect(response.body).toEqual({
        status: 'FAILED',
        errorCode: 'TRANSACTION_NOT_FOUND',
      });
      expect(ledger()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // reverse
  // ---------------------------------------------------------------------------

  describe('reverse', () => {
    const reverse = (overrides = {}) =>
      post(callback({ operation: 'reverse', reason: 5, ...overrides }));

    it('cancels a created transaction', async () => {
      await post(callback({ operation: 'create' }));

      const response = await reverse().expect(200);

      expect(response.body.status).toBe('OK');
      expect(db.tables.providerTransaction[0].state).toBe(
        ProviderTransactionState.CANCELED,
      );
    });

    it('reverses a settled one, and says so', async () => {
      await post(callback({ operation: 'create' }));
      await post(callback({ operation: 'confirm' }));

      const response = await reverse().expect(200);

      expect(response.body).toMatchObject({
        status: 'OK',
        reversed: true,
        state: ProviderTransactionState.REVERSED,
      });
    });

    it('reports an unknown transaction', async () => {
      const response = await reverse({ transactionId: 'utx-unknown' }).expect(200);

      expect(response.body.errorCode).toBe('TRANSACTION_NOT_FOUND');
    });

    it('is idempotent across redeliveries', async () => {
      await post(callback({ operation: 'create' }));

      await reverse().expect(200);
      const second = await reverse().expect(200);

      expect(second.body.status).toBe('OK');
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency keying
  // ---------------------------------------------------------------------------

  describe('idempotency keys', () => {
    it('keys on the operation as well as the transaction id', async () => {
      // A key of the transaction id alone would make `confirm` replay the
      // stored `create` response and never settle the order.
      await post(callback({ operation: 'create' })).expect(200);
      const confirmed = await post(callback({ operation: 'confirm' })).expect(200);

      expect(confirmed.body.state).toBe(ProviderTransactionState.PERFORMED);
      expect(db.tables.idempotencyRecord).toHaveLength(2);
    });

    it('separates transactions that share an operation', async () => {
      db.seedOrder({ id: 'order_2', amountCents: 4900 });

      await post(callback({ operation: 'create' })).expect(200);
      await post(
        callback({ operation: 'create', transactionId: 'utx-900002', orderId: 'order_2' }),
      ).expect(200);

      expect(db.tables.providerTransaction).toHaveLength(2);
    });
  });
});

/**
 * Payme Merchant API integration tests.
 *
 * Payme's certification suite drives the transaction state machine through
 * every legal and illegal transition and checks the exact JSON-RPC error code
 * returned for each. These cases mirror that: the assertions are on protocol
 * codes, not on internal behaviour, because the codes are the contract.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  PaymentOrderStatus,
  PaymentProvider,
  PaymentStatus,
  ProviderTransactionState,
} from '@legaltech/database';
import { PaymeController } from './payme.controller';
import { PaymeService } from './payme.service';
import {
  PAYME_TRANSACTION_TIMEOUT_MS,
  PaymeErrorCode,
  PaymeTransactionState,
} from './payme-errors';
import { PaymentService } from '../../payment.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { InMemoryPrisma } from '../../__testing__/in-memory-prisma';

const MERCHANT_KEY = 'payme-merchant-key';
const AUTH = `Basic ${Buffer.from(`Paycom:${MERCHANT_KEY}`).toString('base64')}`;

let rpcId = 0;

function rpc(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: ++rpcId, method, params };
}

describe('Payme Merchant API (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;

  beforeAll(async () => {
    db = new InMemoryPrisma();

    const moduleRef = await Test.createTestingModule({
      controllers: [PaymeController],
      providers: [
        PaymeService,
        PaymentService,
        { provide: PrismaService, useValue: db },
        {
          provide: ConfigService,
          useValue: {
            get: <T>(key: string, fallback?: T) => {
              const values: Record<string, unknown> = {
                PAYME_MERCHANT_KEY: MERCHANT_KEY,
                PAYME_ACCOUNT_FIELD: 'order_id',
              };
              return (values[key] as T) ?? fallback;
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    db.reset();
    db.seedOrder({ id: 'order_1', amountCents: 490_000, currency: 'uzs' });
  });

  const call = (body: unknown, auth: string | null = AUTH) => {
    const req = request(app.getHttpServer()).post('/payments/payme');
    if (auth) req.set('Authorization', auth);
    return req.send(body as object);
  };

  // ---------------------------------------------------------------------------
  // Transport and auth
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    it('rejects a missing Authorization header with -32504 at HTTP 200', async () => {
      const response = await call(rpc('CheckPerformTransaction'), null).expect(200);

      expect(response.body.error.code).toBe(
        PaymeErrorCode.INSUFFICIENT_PRIVILEGES,
      );
    });

    it('rejects a wrong merchant key', async () => {
      const wrong = `Basic ${Buffer.from('Paycom:nope').toString('base64')}`;
      const response = await call(rpc('CheckPerformTransaction'), wrong).expect(200);

      expect(response.body.error.code).toBe(
        PaymeErrorCode.INSUFFICIENT_PRIVILEGES,
      );
    });

    it('rejects the right key under the wrong login', async () => {
      const wrong = `Basic ${Buffer.from(`Merchant:${MERCHANT_KEY}`).toString('base64')}`;
      const response = await call(rpc('CheckPerformTransaction'), wrong).expect(200);

      expect(response.body.error.code).toBe(
        PaymeErrorCode.INSUFFICIENT_PRIVILEGES,
      );
    });

    it('refuses to disclose which methods exist before authenticating', async () => {
      const response = await call(rpc('NoSuchMethod'), null).expect(200);
      // Auth failure, not METHOD_NOT_FOUND.
      expect(response.body.error.code).toBe(
        PaymeErrorCode.INSUFFICIENT_PRIVILEGES,
      );
    });
  });

  describe('JSON-RPC envelope', () => {
    it('echoes the request id and jsonrpc version', async () => {
      const body = rpc('CheckPerformTransaction', {
        account: { order_id: 'order_1' },
        amount: 490_000,
      });

      const response = await call(body).expect(200);
      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(body.id);
    });

    it('rejects an unknown method with -32601', async () => {
      const response = await call(rpc('Nonsense')).expect(200);
      expect(response.body.error.code).toBe(PaymeErrorCode.METHOD_NOT_FOUND);
    });

    it('rejects a request with no method', async () => {
      const response = await call({ jsonrpc: '2.0', id: 1 }).expect(200);
      expect(response.body.error.code).toBe(PaymeErrorCode.INVALID_REQUEST);
    });

    it('returns localised messages, which Payme shows to the customer', async () => {
      const response = await call(rpc('Nonsense')).expect(200);
      expect(response.body.error.message).toEqual(
        expect.objectContaining({
          ru: expect.any(String),
          uz: expect.any(String),
          en: expect.any(String),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // CheckPerformTransaction
  // ---------------------------------------------------------------------------

  describe('CheckPerformTransaction', () => {
    it('allows a payable order with a matching amount', async () => {
      const response = await call(
        rpc('CheckPerformTransaction', {
          account: { order_id: 'order_1' },
          amount: 490_000,
        }),
      ).expect(200);

      expect(response.body.result).toEqual({ allow: true });
    });

    it('rejects an unknown order and names the account field', async () => {
      const response = await call(
        rpc('CheckPerformTransaction', {
          account: { order_id: 'order_missing' },
          amount: 490_000,
        }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.ORDER_NOT_FOUND);
      // Payme's UI uses `data` to highlight the offending input.
      expect(response.body.error.data).toBe('order_id');
    });

    it('rejects a mismatched amount with -31001', async () => {
      const response = await call(
        rpc('CheckPerformTransaction', {
          account: { order_id: 'order_1' },
          amount: 1,
        }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.INVALID_AMOUNT);
    });

    it('rejects an order that is already paid', async () => {
      db.tables.paymentOrder[0].status = PaymentOrderStatus.PAID;

      const response = await call(
        rpc('CheckPerformTransaction', {
          account: { order_id: 'order_1' },
          amount: 490_000,
        }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.ORDER_NOT_FOUND);
    });

    it('rejects a missing account object', async () => {
      const response = await call(
        rpc('CheckPerformTransaction', { amount: 490_000 }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.ORDER_NOT_FOUND);
    });

    it('rejects a non-integer amount', async () => {
      const response = await call(
        rpc('CheckPerformTransaction', {
          account: { order_id: 'order_1' },
          amount: 4900.5,
        }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.INVALID_AMOUNT);
    });
  });

  // ---------------------------------------------------------------------------
  // CreateTransaction
  // ---------------------------------------------------------------------------

  describe('CreateTransaction', () => {
    const create = (id = 'pt_1', amount = 490_000) =>
      call(
        rpc('CreateTransaction', {
          id,
          time: Date.now(),
          amount,
          account: { order_id: 'order_1' },
        }),
      );

    it('creates a transaction in state 1', async () => {
      const response = await create().expect(200);

      expect(response.body.result).toMatchObject({
        state: PaymeTransactionState.CREATED,
      });
      expect(response.body.result.create_time).toEqual(expect.any(Number));
      expect(db.tables.providerTransaction).toHaveLength(1);
    });

    it('is idempotent: a repeat returns the same transaction, not a second one', async () => {
      const first = await create().expect(200);
      const second = await create().expect(200);

      expect(second.body.result).toEqual(first.body.result);
      expect(db.tables.providerTransaction).toHaveLength(1);
    });

    it('rejects a second concurrent transaction against the same order', async () => {
      await create('pt_1').expect(200);
      const response = await create('pt_2').expect(200);

      // Two live transactions on one order would both be able to perform.
      expect(response.body.error.code).toBe(PaymeErrorCode.ORDER_NOT_PAYABLE);
    });

    it('rejects a mismatched amount', async () => {
      const response = await create('pt_1', 1).expect(200);
      expect(response.body.error.code).toBe(PaymeErrorCode.INVALID_AMOUNT);
    });

    it('rejects an unknown order', async () => {
      const response = await call(
        rpc('CreateTransaction', {
          id: 'pt_x',
          time: Date.now(),
          amount: 490_000,
          account: { order_id: 'nope' },
        }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.ORDER_NOT_FOUND);
    });

    it('refuses to recreate a transaction that has already performed', async () => {
      await create().expect(200);
      await call(rpc('PerformTransaction', { id: 'pt_1' })).expect(200);

      const response = await create().expect(200);
      expect(response.body.error.code).toBe(PaymeErrorCode.UNABLE_TO_PERFORM);
    });

    it('cancels and refuses a transaction older than the 12-hour timeout', async () => {
      await create().expect(200);
      db.tables.providerTransaction[0].createdTime = new Date(
        Date.now() - PAYME_TRANSACTION_TIMEOUT_MS - 1000,
      );

      const response = await create().expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.UNABLE_TO_PERFORM);
      expect(db.tables.providerTransaction[0].state).toBe(
        ProviderTransactionState.CANCELED,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // PerformTransaction
  // ---------------------------------------------------------------------------

  describe('PerformTransaction', () => {
    beforeEach(async () => {
      await call(
        rpc('CreateTransaction', {
          id: 'pt_1',
          time: Date.now(),
          amount: 490_000,
          account: { order_id: 'order_1' },
        }),
      );
    });

    const perform = () => call(rpc('PerformTransaction', { id: 'pt_1' }));

    it('captures the payment and reports state 2', async () => {
      const response = await perform().expect(200);

      expect(response.body.result).toMatchObject({
        state: PaymeTransactionState.PERFORMED,
      });
      expect(response.body.result.perform_time).toEqual(expect.any(Number));

      expect(db.tables.paymentOrder[0].status).toBe(PaymentOrderStatus.PAID);
      expect(db.tables.paymentTransaction).toHaveLength(1);
      expect(db.tables.paymentTransaction[0]).toMatchObject({
        provider: PaymentProvider.PAYME,
        status: PaymentStatus.SUCCEEDED,
      });
    });

    it('does not double-bill on redelivery', async () => {
      const first = await perform().expect(200);
      const second = await perform().expect(200);

      // The same perform_time must come back — Payme compares it against what
      // it recorded, so returning `now` on a retry is a protocol mismatch.
      expect(second.body.result).toEqual(first.body.result);
      expect(db.tables.paymentTransaction).toHaveLength(1);
    });

    it('does not double-bill when deliveries race', async () => {
      const responses = await Promise.all([perform(), perform(), perform()]);

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.body.result.state).toBe(PaymeTransactionState.PERFORMED);
      }
      expect(db.tables.paymentTransaction).toHaveLength(1);
    });

    it('rejects an unknown transaction with -31003', async () => {
      const response = await call(
        rpc('PerformTransaction', { id: 'pt_missing' }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.TRANSACTION_NOT_FOUND);
    });

    it('refuses to perform a cancelled transaction', async () => {
      await call(rpc('CancelTransaction', { id: 'pt_1', reason: 3 })).expect(200);

      const response = await perform().expect(200);
      expect(response.body.error.code).toBe(PaymeErrorCode.UNABLE_TO_PERFORM);
      expect(db.tables.paymentTransaction).toHaveLength(0);
    });

    it('refuses to perform after the 12-hour timeout, and cancels', async () => {
      db.tables.providerTransaction[0].createdTime = new Date(
        Date.now() - PAYME_TRANSACTION_TIMEOUT_MS - 1000,
      );

      const response = await perform().expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.UNABLE_TO_PERFORM);
      expect(db.tables.providerTransaction[0].state).toBe(
        ProviderTransactionState.CANCELED,
      );
      expect(db.tables.paymentTransaction).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // CancelTransaction
  // ---------------------------------------------------------------------------

  describe('CancelTransaction', () => {
    beforeEach(async () => {
      await call(
        rpc('CreateTransaction', {
          id: 'pt_1',
          time: Date.now(),
          amount: 490_000,
          account: { order_id: 'order_1' },
        }),
      );
    });

    it('cancels a created transaction to state -1', async () => {
      const response = await call(
        rpc('CancelTransaction', { id: 'pt_1', reason: 3 }),
      ).expect(200);

      expect(response.body.result.state).toBe(PaymeTransactionState.CANCELED);
      expect(db.tables.paymentOrder[0].status).toBe(PaymentOrderStatus.CANCELED);
    });

    it('reverses a performed transaction to state -2 and records a refund', async () => {
      await call(rpc('PerformTransaction', { id: 'pt_1' })).expect(200);

      const response = await call(
        rpc('CancelTransaction', { id: 'pt_1', reason: 5 }),
      ).expect(200);

      expect(response.body.result.state).toBe(
        PaymeTransactionState.CANCELED_AFTER_PERFORM,
      );

      // Correction as a new row: the ledger is append-only, so the charge and
      // the refund both remain.
      expect(db.tables.paymentTransaction).toHaveLength(2);
      expect(db.tables.paymentTransaction[1]).toMatchObject({
        status: PaymentStatus.REFUNDED,
      });
    });

    it('is idempotent on redelivery', async () => {
      const first = await call(
        rpc('CancelTransaction', { id: 'pt_1', reason: 3 }),
      ).expect(200);
      const second = await call(
        rpc('CancelTransaction', { id: 'pt_1', reason: 3 }),
      ).expect(200);

      expect(second.body.result).toEqual(first.body.result);
    });

    it('does not issue a second refund on a redelivered reversal', async () => {
      await call(rpc('PerformTransaction', { id: 'pt_1' })).expect(200);
      await call(rpc('CancelTransaction', { id: 'pt_1', reason: 5 })).expect(200);
      await call(rpc('CancelTransaction', { id: 'pt_1', reason: 5 })).expect(200);

      expect(db.tables.paymentTransaction).toHaveLength(2);
    });

    it('rejects an unknown transaction', async () => {
      const response = await call(
        rpc('CancelTransaction', { id: 'nope', reason: 3 }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.TRANSACTION_NOT_FOUND);
    });
  });

  // ---------------------------------------------------------------------------
  // CheckTransaction and GetStatement
  // ---------------------------------------------------------------------------

  describe('CheckTransaction', () => {
    it('reports timestamps as epoch milliseconds, zero when absent', async () => {
      await call(
        rpc('CreateTransaction', {
          id: 'pt_1',
          time: Date.now(),
          amount: 490_000,
          account: { order_id: 'order_1' },
        }),
      );

      const response = await call(
        rpc('CheckTransaction', { id: 'pt_1' }),
      ).expect(200);

      expect(response.body.result).toMatchObject({
        state: PaymeTransactionState.CREATED,
        perform_time: 0,
        cancel_time: 0,
        reason: null,
      });
      expect(response.body.result.create_time).toEqual(expect.any(Number));
    });

    it('reports the cancellation reason verbatim', async () => {
      await call(
        rpc('CreateTransaction', {
          id: 'pt_1',
          time: Date.now(),
          amount: 490_000,
          account: { order_id: 'order_1' },
        }),
      );
      await call(rpc('CancelTransaction', { id: 'pt_1', reason: 3 }));

      const response = await call(
        rpc('CheckTransaction', { id: 'pt_1' }),
      ).expect(200);

      expect(response.body.result.reason).toBe(3);
    });

    it('rejects an unknown transaction', async () => {
      const response = await call(
        rpc('CheckTransaction', { id: 'nope' }),
      ).expect(200);

      expect(response.body.error.code).toBe(PaymeErrorCode.TRANSACTION_NOT_FOUND);
    });
  });

  describe('GetStatement', () => {
    it('returns transactions within the requested window', async () => {
      await call(
        rpc('CreateTransaction', {
          id: 'pt_1',
          time: Date.now(),
          amount: 490_000,
          account: { order_id: 'order_1' },
        }),
      );

      const response = await call(
        rpc('GetStatement', {
          from: Date.now() - 60_000,
          to: Date.now() + 60_000,
        }),
      ).expect(200);

      expect(response.body.result.transactions).toHaveLength(1);
      expect(response.body.result.transactions[0]).toMatchObject({
        id: 'pt_1',
        amount: 490_000,
        account: { order_id: 'order_1' },
      });
    });

    it('rejects a request with no time range', async () => {
      const response = await call(rpc('GetStatement', {})).expect(200);
      expect(response.body.error.code).toBe(PaymeErrorCode.INVALID_PARAMS);
    });
  });
});

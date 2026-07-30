import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentOrderStatus,
  PaymentProvider,
  ProviderTransactionState,
} from '@legaltech/database';
import { PaymentService } from '../../payment.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import type { UzumCallbackDto } from './uzum.dto';

/**
 * Uzum Bank checkout callbacks.
 *
 * IMPORTANT — read before trusting this in production. Unlike CLICK and Payme,
 * whose merchant protocols are published, Uzum issues its integration contract
 * per merchant under agreement. This implements the shape their checkout API
 * documentation describes — `check` / `create` / `confirm` / `reverse`
 * operations with an HMAC-SHA256 signature over the payload — but the exact
 * field names, signature base string, and response codes MUST be reconciled
 * against the contract issued for this merchant before go-live.
 *
 * The parts that are not guesswork, and are what actually protect money, are
 * shared with the other gateways: constant-time signature comparison, the
 * unique-transaction constraint, and the same atomic capture path.
 */
@Injectable()
export class UzumService {
  private readonly logger = new Logger(UzumService.name);

  constructor(
    private readonly payments: PaymentService,
    private readonly idempotency: IdempotencyService,
    private readonly config: ConfigService,
  ) {}

  private get secretKey(): string {
    return this.config.get<string>('UZUM_SECRET_KEY', '');
  }

  private get merchantId(): string {
    return this.config.get<string>('UZUM_MERCHANT_ID', '');
  }

  /**
   * HMAC-SHA256 over `transactionId|orderId|amount|merchantId`.
   *
   * Assumed base string — see the class note. Isolated in one method precisely
   * so adjusting it to the issued contract is a one-line change rather than a
   * hunt through the handler.
   */
  buildSignature(dto: UzumCallbackDto): string {
    const base = [
      dto.transactionId,
      dto.orderId,
      String(dto.amount),
      this.merchantId,
    ].join('|');

    return createHmac('sha256', this.secretKey).update(base).digest('hex');
  }

  verifySignature(dto: UzumCallbackDto): boolean {
    if (!this.secretKey) {
      this.logger.error('UZUM_SECRET_KEY is not configured; rejecting callback');
      return false;
    }
    if (typeof dto.signature !== 'string' || !dto.signature) return false;

    const expected = Buffer.from(this.buildSignature(dto), 'utf8');
    const presented = Buffer.from(dto.signature.toLowerCase(), 'utf8');

    if (expected.length !== presented.length) return false;
    return timingSafeEqual(expected, presented);
  }

  async handle(dto: UzumCallbackDto) {
    if (!this.verifySignature(dto)) {
      this.logger.warn(
        `Uzum signature rejected for transaction ${dto.transactionId}`,
      );
      return { status: 'FAILED', errorCode: 'INVALID_SIGNATURE' };
    }

    const key = `uzum:${dto.operation}:${dto.transactionId}`;

    const { body } = await this.idempotency.execute(key, dto, async () => ({
      statusCode: 200,
      body: await this.route(dto),
    }));

    return body;
  }

  private async route(dto: UzumCallbackDto) {
    switch (dto.operation) {
      case 'check':
        return this.check(dto);
      case 'create':
        return this.create(dto);
      case 'confirm':
        return this.confirm(dto);
      case 'reverse':
        return this.reverse(dto);
      default:
        return { status: 'FAILED', errorCode: 'UNSUPPORTED_OPERATION' };
    }
  }

  private async check(dto: UzumCallbackDto) {
    const order = await this.payments.findPayableOrder(dto.orderId);
    if (!order) return { status: 'FAILED', errorCode: 'ORDER_NOT_FOUND' };

    if (order.amountCents !== dto.amount) {
      return { status: 'FAILED', errorCode: 'INVALID_AMOUNT' };
    }
    return { status: 'OK', orderId: order.id, amount: order.amountCents };
  }

  private async create(dto: UzumCallbackDto) {
    const order = await this.payments.findPayableOrder(dto.orderId);
    if (!order) return { status: 'FAILED', errorCode: 'ORDER_NOT_FOUND' };

    if (order.amountCents !== dto.amount) {
      return { status: 'FAILED', errorCode: 'INVALID_AMOUNT' };
    }

    const { transaction } = await this.payments.createOrGetTransaction({
      provider: PaymentProvider.UZUM,
      providerTransactionId: dto.transactionId,
      orderId: order.id,
      amountCents: dto.amount,
      rawPayload: { ...dto },
    });

    return {
      status: 'OK',
      transactionId: transaction.providerTransactionId,
      state: transaction.state,
    };
  }

  private async confirm(dto: UzumCallbackDto) {
    const result = await this.payments.capture({
      provider: PaymentProvider.UZUM,
      providerTransactionId: dto.transactionId,
    });

    if (!result) return { status: 'FAILED', errorCode: 'TRANSACTION_NOT_FOUND' };

    // `captured === false` means an earlier delivery already performed it; from
    // Uzum's side the transaction is confirmed either way.
    return {
      status: 'OK',
      transactionId: dto.transactionId,
      orderId: result.order.id,
      state: result.transaction.state,
    };
  }

  private async reverse(dto: UzumCallbackDto) {
    const result = await this.payments.cancel({
      provider: PaymentProvider.UZUM,
      providerTransactionId: dto.transactionId,
      reason: dto.reason,
    });

    if (!result) return { status: 'FAILED', errorCode: 'TRANSACTION_NOT_FOUND' };

    return {
      status: 'OK',
      transactionId: dto.transactionId,
      state: result.transaction.state,
      reversed: result.transaction.state === ProviderTransactionState.REVERSED,
    };
  }
}

export { PaymentOrderStatus };

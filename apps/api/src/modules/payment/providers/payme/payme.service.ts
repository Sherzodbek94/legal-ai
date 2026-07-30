import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentOrderStatus,
  PaymentProvider,
  ProviderTransactionState,
  type ProviderTransaction,
} from '@legaltech/database';
import { PaymentService } from '../../payment.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  PAYME_TRANSACTION_TIMEOUT_MS,
  PaymeError,
  PaymeErrorCode,
  PaymeTransactionState,
} from './payme-errors';
import { paymeAmountToMinorUnits, verifyPaymeAuth } from './payme-auth';

/**
 * Payme Merchant API.
 *
 * The state machine is the whole of this protocol. Payme's certification suite
 * drives it through every legal and illegal transition and checks the exact
 * error code returned for each, so the shape below is the specification rather
 * than an implementation choice:
 *
 *   CheckPerformTransaction — may this order be paid at all?
 *   CreateTransaction       — reserve it (idempotent on transaction id)
 *   PerformTransaction      — capture (idempotent)
 *   CancelTransaction       — cancel or reverse (idempotent)
 *   CheckTransaction        — report state and timestamps
 *   GetStatement            — reconciliation over a time range
 *
 * The account field carrying our order id is configurable because it is agreed
 * per merchant with Payme; `order_id` is the common default.
 */
@Injectable()
export class PaymeService {
  private readonly logger = new Logger(PaymeService.name);

  constructor(
    private readonly payments: PaymentService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get merchantKey(): string {
    return this.config.get<string>('PAYME_MERCHANT_KEY', '');
  }

  private get accountField(): string {
    return this.config.get<string>('PAYME_ACCOUNT_FIELD', 'order_id');
  }

  /**
   * Authenticates the caller.
   *
   * An unset key is treated as a failed check rather than a passed one: an
   * unconfigured environment must reject callbacks, not accept every one.
   */
  authorize(authorizationHeader: string | undefined): void {
    if (!this.merchantKey) {
      this.logger.error('PAYME_MERCHANT_KEY is not configured; rejecting request');
      throw new PaymeError(PaymeErrorCode.INSUFFICIENT_PRIVILEGES);
    }
    if (!verifyPaymeAuth(authorizationHeader, this.merchantKey)) {
      throw new PaymeError(PaymeErrorCode.INSUFFICIENT_PRIVILEGES);
    }
  }

  async dispatch(
    method: string | undefined,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const safeParams = params ?? {};

    switch (method) {
      case 'CheckPerformTransaction':
        return this.checkPerformTransaction(safeParams);
      case 'CreateTransaction':
        return this.createTransaction(safeParams);
      case 'PerformTransaction':
        return this.performTransaction(safeParams);
      case 'CancelTransaction':
        return this.cancelTransaction(safeParams);
      case 'CheckTransaction':
        return this.checkTransaction(safeParams);
      case 'GetStatement':
        return this.getStatement(safeParams);
      default:
        throw new PaymeError(PaymeErrorCode.METHOD_NOT_FOUND);
    }
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  private async checkPerformTransaction(params: Record<string, unknown>) {
    const orderId = this.readOrderId(params);
    const amount = this.readAmount(params);

    const order = await this.payments.findPayableOrder(orderId);
    if (!order) {
      // Account errors must name the field so Payme's UI can highlight the
      // right input to the customer.
      throw new PaymeError(PaymeErrorCode.ORDER_NOT_FOUND, this.accountField);
    }

    if (order.amountCents !== amount) {
      throw new PaymeError(PaymeErrorCode.INVALID_AMOUNT);
    }

    return { allow: true };
  }

  private async createTransaction(params: Record<string, unknown>) {
    const transactionId = this.readTransactionId(params);
    const orderId = this.readOrderId(params);
    const amount = this.readAmount(params);
    const time = this.readTime(params);

    const existing = await this.payments.findProviderTransaction(
      PaymentProvider.PAYME,
      transactionId,
    );

    // Idempotent replay. Payme retries CreateTransaction and expects the
    // original transaction echoed back, not a second one.
    if (existing) {
      if (existing.state !== ProviderTransactionState.CREATED) {
        throw new PaymeError(PaymeErrorCode.UNABLE_TO_PERFORM);
      }
      if (this.hasTimedOut(existing)) {
        // Payme has already written this off; cancelling keeps our record and
        // theirs in agreement.
        await this.payments.cancel({
          provider: PaymentProvider.PAYME,
          providerTransactionId: transactionId,
          reason: 4,
        });
        throw new PaymeError(PaymeErrorCode.UNABLE_TO_PERFORM);
      }
      return this.createResult(existing);
    }

    const order = await this.payments.findPayableOrder(orderId);
    if (!order) {
      throw new PaymeError(PaymeErrorCode.ORDER_NOT_FOUND, this.accountField);
    }
    if (order.amountCents !== amount) {
      throw new PaymeError(PaymeErrorCode.INVALID_AMOUNT);
    }

    // One live transaction per order. Without this, two Payme sessions could
    // both hold a transaction against the same order and both perform.
    const conflicting = await this.prisma.client.providerTransaction.findFirst({
      where: {
        orderId: order.id,
        state: ProviderTransactionState.CREATED,
      },
    });
    if (conflicting) {
      throw new PaymeError(PaymeErrorCode.ORDER_NOT_PAYABLE, this.accountField);
    }

    const { transaction } = await this.payments.createOrGetTransaction({
      provider: PaymentProvider.PAYME,
      providerTransactionId: transactionId,
      orderId: order.id,
      amountCents: amount,
      createdTime: time ? new Date(time) : new Date(),
      rawPayload: params as never,
    });

    return this.createResult(transaction);
  }

  private async performTransaction(params: Record<string, unknown>) {
    const transactionId = this.readTransactionId(params);

    const existing = await this.payments.findProviderTransaction(
      PaymentProvider.PAYME,
      transactionId,
    );
    if (!existing) {
      throw new PaymeError(PaymeErrorCode.TRANSACTION_NOT_FOUND);
    }

    // Already performed: return the original capture time. Payme compares it
    // against what it recorded, so returning `now` on a retry is a mismatch.
    if (existing.state === ProviderTransactionState.PERFORMED) {
      return this.performResult(existing);
    }

    if (existing.state !== ProviderTransactionState.CREATED) {
      throw new PaymeError(PaymeErrorCode.UNABLE_TO_PERFORM);
    }

    if (this.hasTimedOut(existing)) {
      await this.payments.cancel({
        provider: PaymentProvider.PAYME,
        providerTransactionId: transactionId,
        reason: 4,
      });
      throw new PaymeError(PaymeErrorCode.UNABLE_TO_PERFORM);
    }

    const result = await this.payments.capture({
      provider: PaymentProvider.PAYME,
      providerTransactionId: transactionId,
    });

    if (!result) {
      throw new PaymeError(PaymeErrorCode.TRANSACTION_NOT_FOUND);
    }

    return this.performResult(result.transaction);
  }

  private async cancelTransaction(params: Record<string, unknown>) {
    const transactionId = this.readTransactionId(params);
    const reason = typeof params.reason === 'number' ? params.reason : undefined;

    const existing = await this.payments.findProviderTransaction(
      PaymentProvider.PAYME,
      transactionId,
    );
    if (!existing) {
      throw new PaymeError(PaymeErrorCode.TRANSACTION_NOT_FOUND);
    }

    // Idempotent: a repeat cancel reports the existing cancellation.
    if (
      existing.state === ProviderTransactionState.CANCELED ||
      existing.state === ProviderTransactionState.REVERSED
    ) {
      return this.cancelResult(existing);
    }

    const result = await this.payments.cancel({
      provider: PaymentProvider.PAYME,
      providerTransactionId: transactionId,
      reason,
    });

    if (!result) {
      throw new PaymeError(PaymeErrorCode.TRANSACTION_NOT_FOUND);
    }

    return this.cancelResult(result.transaction);
  }

  private async checkTransaction(params: Record<string, unknown>) {
    const transactionId = this.readTransactionId(params);

    const existing = await this.payments.findProviderTransaction(
      PaymentProvider.PAYME,
      transactionId,
    );
    if (!existing) {
      throw new PaymeError(PaymeErrorCode.TRANSACTION_NOT_FOUND);
    }

    return {
      create_time: existing.createdTime.getTime(),
      perform_time: existing.performedTime?.getTime() ?? 0,
      cancel_time: existing.canceledTime?.getTime() ?? 0,
      transaction: existing.id,
      state: this.toPaymeState(existing.state),
      reason: existing.reason ?? null,
    };
  }

  private async getStatement(params: Record<string, unknown>) {
    const from = typeof params.from === 'number' ? params.from : null;
    const to = typeof params.to === 'number' ? params.to : null;

    if (from === null || to === null) {
      throw new PaymeError(PaymeErrorCode.INVALID_PARAMS);
    }

    // Projected because this is the one query here whose row count is set by the
    // caller: Payme picks the date range, and a wide range over a busy month
    // returns everything in it. `rawPayload` in particular is the full gateway
    // request per transaction and is not part of the statement response.
    const transactions = await this.prisma.client.providerTransaction.findMany({
      where: {
        provider: PaymentProvider.PAYME,
        createdTime: { gte: new Date(from), lte: new Date(to) },
      },
      orderBy: { createdTime: 'asc' },
      select: {
        id: true,
        providerTransactionId: true,
        orderId: true,
        amountCents: true,
        state: true,
        reason: true,
        createdTime: true,
        performedTime: true,
        canceledTime: true,
      },
    });

    return {
      transactions: transactions.map((transaction) => ({
        id: transaction.providerTransactionId,
        time: transaction.createdTime.getTime(),
        amount: transaction.amountCents,
        // `orderId` is already on the row — joining the order to read its `id`
        // would fetch a whole record to learn something we hold.
        account: { [this.accountField]: transaction.orderId },
        create_time: transaction.createdTime.getTime(),
        perform_time: transaction.performedTime?.getTime() ?? 0,
        cancel_time: transaction.canceledTime?.getTime() ?? 0,
        transaction: transaction.id,
        state: this.toPaymeState(transaction.state),
        reason: transaction.reason ?? null,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Result shapes
  // ---------------------------------------------------------------------------

  private createResult(transaction: ProviderTransaction) {
    return {
      create_time: transaction.createdTime.getTime(),
      transaction: transaction.id,
      state: this.toPaymeState(transaction.state),
    };
  }

  private performResult(transaction: ProviderTransaction) {
    return {
      transaction: transaction.id,
      perform_time: transaction.performedTime?.getTime() ?? 0,
      state: this.toPaymeState(transaction.state),
    };
  }

  private cancelResult(transaction: ProviderTransaction) {
    return {
      transaction: transaction.id,
      cancel_time: transaction.canceledTime?.getTime() ?? 0,
      state: this.toPaymeState(transaction.state),
    };
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  private readTransactionId(params: Record<string, unknown>): string {
    const id = params.id;
    if (typeof id !== 'string' || !id.trim()) {
      throw new PaymeError(PaymeErrorCode.INVALID_PARAMS);
    }
    return id;
  }

  private readOrderId(params: Record<string, unknown>): string {
    const account = params.account;
    if (typeof account !== 'object' || account === null) {
      throw new PaymeError(PaymeErrorCode.ORDER_NOT_FOUND, this.accountField);
    }

    const value = (account as Record<string, unknown>)[this.accountField];
    if (typeof value !== 'string' || !value.trim()) {
      throw new PaymeError(PaymeErrorCode.ORDER_NOT_FOUND, this.accountField);
    }
    return value;
  }

  private readAmount(params: Record<string, unknown>): number {
    const amount = paymeAmountToMinorUnits(params.amount);
    if (amount === null) {
      throw new PaymeError(PaymeErrorCode.INVALID_AMOUNT);
    }
    return amount;
  }

  private readTime(params: Record<string, unknown>): number | null {
    return typeof params.time === 'number' && Number.isFinite(params.time)
      ? params.time
      : null;
  }

  private hasTimedOut(transaction: ProviderTransaction, now = new Date()): boolean {
    return (
      now.getTime() - transaction.createdTime.getTime() >
      PAYME_TRANSACTION_TIMEOUT_MS
    );
  }

  private toPaymeState(state: ProviderTransactionState): number {
    switch (state) {
      case ProviderTransactionState.CREATED:
        return PaymeTransactionState.CREATED;
      case ProviderTransactionState.PERFORMED:
        return PaymeTransactionState.PERFORMED;
      case ProviderTransactionState.CANCELED:
        return PaymeTransactionState.CANCELED;
      case ProviderTransactionState.REVERSED:
        return PaymeTransactionState.CANCELED_AFTER_PERFORM;
      default:
        return PaymeTransactionState.CREATED;
    }
  }
}

export { PaymentOrderStatus };

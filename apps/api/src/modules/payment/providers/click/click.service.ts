import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentOrderStatus,
  PaymentProvider,
  ProviderTransactionState,
} from '@legaltech/database';
import { PaymentService } from '../../payment.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import {
  CLICK_ACTION_COMPLETE,
  CLICK_ACTION_PREPARE,
  parseClickAmountToMinorUnits,
  verifyClickSignature,
} from './click-signature';
import { ClickError, clickResponse, type ClickResponse } from './click-errors';
import type { ClickCallbackDto } from './click.dto';

/**
 * CLICK SHOP-API handler.
 *
 * Two callbacks, in order: Prepare reserves the order, Complete captures it.
 * CLICK will retry either one on any timeout or non-2xx, so both are written to
 * be safe to run repeatedly.
 *
 * Every path returns HTTP 200 with a code in the body. Returning a 4xx makes
 * CLICK consider the callback undelivered and retry it indefinitely, which
 * turns a rejected signature into a permanent retry loop.
 */
@Injectable()
export class ClickService {
  private readonly logger = new Logger(ClickService.name);

  constructor(
    private readonly payments: PaymentService,
    private readonly idempotency: IdempotencyService,
    private readonly config: ConfigService,
  ) {}

  private get secretKey(): string {
    return this.config.get<string>('CLICK_SECRET_KEY', '');
  }

  private get serviceId(): string {
    return this.config.get<string>('CLICK_SERVICE_ID', '');
  }

  async handlePrepare(dto: ClickCallbackDto): Promise<ClickResponse> {
    return this.runIdempotently(`click:prepare:${dto.click_trans_id}`, dto, () =>
      this.prepare(dto),
    );
  }

  async handleComplete(dto: ClickCallbackDto): Promise<ClickResponse> {
    return this.runIdempotently(`click:complete:${dto.click_trans_id}`, dto, () =>
      this.complete(dto),
    );
  }

  /**
   * Runs a handler once per CLICK transaction, replaying the stored response on
   * a retry.
   *
   * The conflict branch matters more than it looks. `IdempotencyService` throws
   * when the same key arrives with a *different* body — two contradictory
   * Completes for one `click_trans_id`, say — and that exception would
   * otherwise surface as an HTTP 409. CLICK treats any non-2xx as an
   * undelivered callback and retries it indefinitely, so letting it escape
   * would turn one malformed request into a permanent retry loop. It is
   * reported in-band instead, like every other refusal in this protocol.
   */
  private async runIdempotently(
    key: string,
    dto: ClickCallbackDto,
    work: () => Promise<ClickResponse>,
  ): Promise<ClickResponse> {
    try {
      const { body } = await this.idempotency.execute(key, dto, async () => ({
        statusCode: 200,
        body: await work(),
      }));
      return body;
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.warn(
          `CLICK transaction ${dto.click_trans_id} replayed with a different payload`,
        );
        return clickResponse(
          dto.click_trans_id,
          dto.merchant_trans_id,
          ClickError.ERROR_IN_REQUEST,
        );
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Prepare
  // ---------------------------------------------------------------------------

  private async prepare(dto: ClickCallbackDto): Promise<ClickResponse> {
    const orderId = dto.merchant_trans_id;

    const rejection = this.verify(dto, CLICK_ACTION_PREPARE);
    if (rejection !== null) {
      return clickResponse(dto.click_trans_id, orderId, rejection);
    }

    const amountCents = parseClickAmountToMinorUnits(dto.amount);
    if (amountCents === null) {
      return clickResponse(dto.click_trans_id, orderId, ClickError.INCORRECT_AMOUNT);
    }

    const order = await this.payments.findOrder(orderId);
    if (!order) {
      return clickResponse(dto.click_trans_id, orderId, ClickError.ORDER_NOT_FOUND);
    }

    // Reported before the amount check: "already paid" is the more actionable
    // answer for an order CLICK is re-preparing after a successful capture.
    if (order.status === PaymentOrderStatus.PAID) {
      return clickResponse(dto.click_trans_id, orderId, ClickError.ALREADY_PAID);
    }
    if (order.status !== PaymentOrderStatus.PENDING) {
      return clickResponse(
        dto.click_trans_id,
        orderId,
        ClickError.TRANSACTION_CANCELLED,
      );
    }

    if (order.amountCents !== amountCents) {
      this.logger.warn(
        `CLICK amount mismatch on order ${orderId}: expected ${order.amountCents}, got ${amountCents}`,
      );
      return clickResponse(dto.click_trans_id, orderId, ClickError.INCORRECT_AMOUNT);
    }

    const { transaction } = await this.payments.createOrGetTransaction({
      provider: PaymentProvider.CLICK,
      providerTransactionId: String(dto.click_trans_id),
      orderId: order.id,
      amountCents,
      rawPayload: { ...dto },
    });

    if (
      transaction.state === ProviderTransactionState.CANCELED ||
      transaction.state === ProviderTransactionState.REVERSED
    ) {
      return clickResponse(
        dto.click_trans_id,
        orderId,
        ClickError.TRANSACTION_CANCELLED,
      );
    }

    return clickResponse(dto.click_trans_id, orderId, ClickError.SUCCESS, {
      // CLICK echoes this back on Complete. The gateway's own transaction id is
      // used so the two callbacks are linked without a second identifier to
      // keep in sync.
      merchant_prepare_id: Number(dto.click_trans_id),
    });
  }

  // ---------------------------------------------------------------------------
  // Complete
  // ---------------------------------------------------------------------------

  private async complete(dto: ClickCallbackDto): Promise<ClickResponse> {
    const orderId = dto.merchant_trans_id;

    const rejection = this.verify(dto, CLICK_ACTION_COMPLETE);
    if (rejection !== null) {
      return clickResponse(dto.click_trans_id, orderId, rejection);
    }

    const amountCents = parseClickAmountToMinorUnits(dto.amount);
    if (amountCents === null) {
      return clickResponse(dto.click_trans_id, orderId, ClickError.INCORRECT_AMOUNT);
    }

    const transaction = await this.payments.findProviderTransaction(
      PaymentProvider.CLICK,
      String(dto.click_trans_id),
    );

    // Complete without a preceding Prepare: CLICK expects this specific code
    // rather than a generic failure.
    if (!transaction) {
      return clickResponse(
        dto.click_trans_id,
        orderId,
        ClickError.TRANSACTION_NOT_FOUND,
      );
    }

    if (
      transaction.state === ProviderTransactionState.CANCELED ||
      transaction.state === ProviderTransactionState.REVERSED
    ) {
      return clickResponse(
        dto.click_trans_id,
        orderId,
        ClickError.TRANSACTION_CANCELLED,
      );
    }

    if (transaction.amountCents !== amountCents) {
      return clickResponse(dto.click_trans_id, orderId, ClickError.INCORRECT_AMOUNT);
    }

    // CLICK signals a user-side failure by sending a negative `error`. The
    // transaction must be cancelled rather than captured.
    if (Number(dto.error) < 0) {
      await this.payments.cancel({
        provider: PaymentProvider.CLICK,
        providerTransactionId: String(dto.click_trans_id),
        reason: Number(dto.error),
      });
      return clickResponse(
        dto.click_trans_id,
        orderId,
        ClickError.TRANSACTION_CANCELLED,
      );
    }

    const result = await this.payments.capture({
      provider: PaymentProvider.CLICK,
      providerTransactionId: String(dto.click_trans_id),
    });

    if (!result) {
      return clickResponse(
        dto.click_trans_id,
        orderId,
        ClickError.TRANSACTION_NOT_FOUND,
      );
    }

    // `captured === false` here means an earlier delivery already performed it.
    // That is still a success from CLICK's side — the transaction is performed —
    // and reporting anything else would make it retry a completed payment.
    return clickResponse(dto.click_trans_id, orderId, ClickError.SUCCESS, {
      merchant_confirm_id: Number(dto.click_trans_id),
    });
  }

  // ---------------------------------------------------------------------------
  // Verification
  // ---------------------------------------------------------------------------

  /** Returns a CLICK error code, or null when the request is acceptable. */
  private verify(dto: ClickCallbackDto, expectedAction: number): number | null {
    if (String(dto.action) !== String(expectedAction)) {
      return ClickError.ACTION_NOT_FOUND;
    }

    if (this.serviceId && String(dto.service_id) !== this.serviceId) {
      this.logger.warn(
        `CLICK callback for unknown service_id ${dto.service_id}`,
      );
      return ClickError.SIGN_CHECK_FAILED;
    }

    if (!this.secretKey) {
      // Refusing is the only safe answer: with no key every signature would
      // "pass" and the endpoint would accept forged payment confirmations.
      this.logger.error('CLICK_SECRET_KEY is not configured; rejecting callback');
      return ClickError.SIGN_CHECK_FAILED;
    }

    if (!verifyClickSignature(dto, this.secretKey)) {
      this.logger.warn(
        `CLICK signature rejected for transaction ${dto.click_trans_id}`,
      );
      return ClickError.SIGN_CHECK_FAILED;
    }

    if (!dto.merchant_trans_id) {
      return ClickError.ORDER_NOT_FOUND;
    }

    return null;
  }
}

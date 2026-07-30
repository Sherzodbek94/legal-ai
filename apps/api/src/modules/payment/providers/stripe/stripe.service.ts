import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider } from '@legaltech/database';
import { PaymentService } from '../../payment.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { verifyStripeSignature } from './stripe-signature';

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export type StripeHandlerResult =
  | { received: true; handled: boolean; reason?: string }
  | { received: false; reason: string };

/**
 * Stripe webhook processing.
 *
 * Stripe guarantees at-least-once delivery and explicitly warns that events can
 * arrive out of order and more than once. Both are handled the same way as the
 * other gateways: the event id is the idempotency key, and the capture path is
 * guarded so a second delivery has no effect.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(
    private readonly payments: PaymentService,
    private readonly idempotency: IdempotencyService,
    private readonly config: ConfigService,
  ) {}

  private get webhookSecret(): string {
    return this.config.get<string>('STRIPE_WEBHOOK_SECRET', '');
  }

  /**
   * @param rawBody the exact posted bytes. Parsing and re-serialising the JSON
   * changes the bytes and breaks every signature check.
   */
  async handleWebhook(
    rawBody: Buffer | string | undefined,
    signatureHeader: string | undefined,
  ): Promise<StripeHandlerResult> {
    if (!this.webhookSecret) {
      this.logger.error('STRIPE_WEBHOOK_SECRET is not configured; rejecting webhook');
      return { received: false, reason: 'not_configured' };
    }
    if (!rawBody) {
      // Almost always a missing raw-body configuration rather than a bad
      // request — see `rawBody: true` in main.ts.
      this.logger.error('Stripe webhook received with no raw body available');
      return { received: false, reason: 'missing_body' };
    }

    const verification = verifyStripeSignature(
      rawBody,
      signatureHeader,
      this.webhookSecret,
    );

    if (!verification.valid) {
      this.logger.warn(`Stripe signature rejected: ${verification.reason}`);
      return { received: false, reason: verification.reason };
    }

    let event: StripeEvent;
    try {
      event = JSON.parse(
        Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody,
      );
    } catch {
      return { received: false, reason: 'invalid_json' };
    }

    if (!event?.id || !event?.type) {
      return { received: false, reason: 'invalid_event' };
    }

    const { body } = await this.idempotency.execute(
      `stripe:${event.id}`,
      { id: event.id, type: event.type },
      async () => ({ statusCode: 200, body: await this.dispatch(event) }),
    );

    return body;
  }

  private async dispatch(event: StripeEvent): Promise<StripeHandlerResult> {
    const object = event.data?.object ?? {};

    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'checkout.session.completed': {
        const orderId = this.readOrderId(object);
        if (!orderId) {
          // Not one of ours — a webhook endpoint shared with another product,
          // or an event created outside this flow. Acknowledged so Stripe stops
          // retrying, but nothing is settled.
          return { received: true, handled: false, reason: 'no_order_reference' };
        }
        return this.capture(orderId, object, event);
      }

      case 'payment_intent.payment_failed':
      case 'charge.refunded': {
        const providerTransactionId = this.readTransactionId(object, event);
        const result = await this.payments.cancel({
          provider: PaymentProvider.STRIPE,
          providerTransactionId,
        });
        return { received: true, handled: Boolean(result) };
      }

      default:
        // Acknowledge everything. A non-2xx makes Stripe retry an event we were
        // never going to act on, for days.
        return { received: true, handled: false, reason: 'unhandled_event_type' };
    }
  }

  private async capture(
    orderId: string,
    object: Record<string, unknown>,
    event: StripeEvent,
  ): Promise<StripeHandlerResult> {
    const order = await this.payments.findOrder(orderId);
    if (!order) {
      return { received: true, handled: false, reason: 'order_not_found' };
    }

    const amount = this.readAmount(object);
    if (amount !== null && amount !== order.amountCents) {
      // Never settle an amount that disagrees with the order. Stripe is the
      // authority on what was charged, so a mismatch means the order and the
      // session diverged and a human needs to look.
      this.logger.error(
        `Stripe amount mismatch on order ${orderId}: order ${order.amountCents}, event ${amount}`,
      );
      return { received: true, handled: false, reason: 'amount_mismatch' };
    }

    const providerTransactionId = this.readTransactionId(object, event);

    await this.payments.createOrGetTransaction({
      provider: PaymentProvider.STRIPE,
      providerTransactionId,
      orderId: order.id,
      amountCents: order.amountCents,
      rawPayload: { eventId: event.id, type: event.type },
    });

    const result = await this.payments.capture({
      provider: PaymentProvider.STRIPE,
      providerTransactionId,
    });

    return { received: true, handled: Boolean(result) };
  }

  /** Our order id travels in metadata, which is the only field we control. */
  private readOrderId(object: Record<string, unknown>): string | null {
    const metadata = object.metadata;
    if (typeof metadata !== 'object' || metadata === null) return null;

    const value = (metadata as Record<string, unknown>).orderId;
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private readTransactionId(
    object: Record<string, unknown>,
    event: StripeEvent,
  ): string {
    const paymentIntent = object.payment_intent ?? object.id;
    return typeof paymentIntent === 'string' ? paymentIntent : event.id;
  }

  private readAmount(object: Record<string, unknown>): number | null {
    for (const field of ['amount_received', 'amount_total', 'amount']) {
      const value = object[field];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  }
}

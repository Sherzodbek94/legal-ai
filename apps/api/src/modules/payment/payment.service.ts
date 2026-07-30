import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  PaymentOrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ProviderTransactionState,
  SubscriptionStatus,
  type PaymentOrder,
  type ProviderTransaction,
} from '@legaltech/database';
import { PrismaService } from '../../prisma/prisma.service';
import { addMonthsUtc } from '../billing/limits/billing-period';

export interface SettlementResult {
  order: PaymentOrder;
  transaction: ProviderTransaction;
  /** True when this call is what actually captured the money. */
  captured: boolean;
}

/**
 * Shared settlement logic behind all four gateways.
 *
 * The gateway adapters differ in wire format and almost nothing else: each one
 * eventually says "transaction X of amount Y against order Z has been paid".
 * Keeping that final step in one place means the money-moving code — the part
 * where a mistake bills someone twice — exists once and is tested once, rather
 * than being reimplemented four times with four different bugs.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds a payable order.
   *
   * Returns null for anything a gateway must not be allowed to pay: unknown,
   * already settled, cancelled, or past its deadline. The caller maps that to
   * whichever protocol code its gateway expects.
   */
  async findPayableOrder(
    orderId: string,
    now = new Date(),
  ): Promise<PaymentOrder | null> {
    const order = await this.prisma.client.paymentOrder.findUnique({
      where: { id: orderId },
    });

    if (!order) return null;
    if (order.status !== PaymentOrderStatus.PENDING) return null;
    if (order.expiresAt && order.expiresAt <= now) return null;

    return order;
  }

  /** Any order, in whatever state — for status queries that must report it. */
  async findOrder(orderId: string): Promise<PaymentOrder | null> {
    return this.prisma.client.paymentOrder.findUnique({
      where: { id: orderId },
    });
  }

  async findProviderTransaction(
    provider: PaymentProvider,
    providerTransactionId: string,
  ): Promise<ProviderTransaction | null> {
    return this.prisma.client.providerTransaction.findUnique({
      where: {
        provider_providerTransactionId: { provider, providerTransactionId },
      },
    });
  }

  /**
   * Registers a gateway transaction against an order, or returns the existing
   * one if the gateway is retrying.
   *
   * This is the first of the two double-billing defences. Every gateway here
   * retries aggressively on a timeout or a non-2xx, and a naive handler creates
   * a second transaction each time. The unique `(provider, providerTransactionId)`
   * index makes that structurally impossible: the insert either wins or raises
   * P2002, and losing means someone else already registered it.
   */
  async createOrGetTransaction(params: {
    provider: PaymentProvider;
    providerTransactionId: string;
    orderId: string;
    amountCents: number;
    rawPayload?: Prisma.InputJsonValue;
    createdTime?: Date;
  }): Promise<{ transaction: ProviderTransaction; created: boolean }> {
    const existing = await this.findProviderTransaction(
      params.provider,
      params.providerTransactionId,
    );
    if (existing) return { transaction: existing, created: false };

    try {
      const transaction = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.providerTransaction.create({
          data: {
            provider: params.provider,
            providerTransactionId: params.providerTransactionId,
            orderId: params.orderId,
            amountCents: params.amountCents,
            state: ProviderTransactionState.CREATED,
            createdTime: params.createdTime ?? new Date(),
            rawPayload: params.rawPayload,
          },
        });

        // Claim the order for this gateway so a second gateway cannot also be
        // mid-payment against it.
        await tx.paymentOrder.update({
          where: { id: params.orderId },
          data: { provider: params.provider },
        });

        return created;
      });

      return { transaction, created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Lost the race with a concurrent delivery of the same webhook. The
        // winner's row is the answer.
        const winner = await this.findProviderTransaction(
          params.provider,
          params.providerTransactionId,
        );
        if (winner) return { transaction: winner, created: false };
      }
      throw error;
    }
  }

  /**
   * Captures a transaction and marks its order paid.
   *
   * Everything here is one transaction, guarded so it can run twice safely:
   *
   *   * the transaction state moves CREATED -> PERFORMED only if it is still
   *     CREATED, via a conditional `updateMany`;
   *   * the order moves PENDING -> PAID only if it is still PENDING;
   *   * the ledger entry and the subscription activation ride along.
   *
   * If a retry arrives after the first call committed, the guarded updates
   * match zero rows and `captured` comes back false — the caller still returns
   * a success response to the gateway, because from its side the transaction
   * genuinely is performed. That combination is what makes the endpoint
   * idempotent rather than merely non-crashing.
   */
  async capture(params: {
    provider: PaymentProvider;
    providerTransactionId: string;
    performedAt?: Date;
  }): Promise<SettlementResult | null> {
    const performedAt = params.performedAt ?? new Date();

    return this.prisma.client.$transaction(async (tx) => {
      const transaction = await tx.providerTransaction.findUnique({
        where: {
          provider_providerTransactionId: {
            provider: params.provider,
            providerTransactionId: params.providerTransactionId,
          },
        },
      });

      if (!transaction) return null;

      const claimed = await tx.providerTransaction.updateMany({
        where: {
          id: transaction.id,
          state: ProviderTransactionState.CREATED,
        },
        data: {
          state: ProviderTransactionState.PERFORMED,
          performedTime: performedAt,
        },
      });

      const order = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: transaction.orderId },
      });

      // Already captured by an earlier delivery: report the settled state
      // without writing a second ledger entry.
      if (claimed.count === 0) {
        const current = await tx.providerTransaction.findUniqueOrThrow({
          where: { id: transaction.id },
        });
        return { order, transaction: current, captured: false };
      }

      const paidOrder = await tx.paymentOrder.update({
        where: { id: order.id },
        data: { status: PaymentOrderStatus.PAID, paidAt: performedAt },
      });

      await tx.paymentTransaction.create({
        data: {
          companyId: order.companyId,
          subscriptionId: order.subscriptionId,
          orderId: order.id,
          provider: params.provider,
          providerTransactionId: `${params.provider}:${params.providerTransactionId}`,
          amountCents: order.amountCents,
          currency: order.currency,
          status: PaymentStatus.SUCCEEDED,
          description: order.description ?? 'Payment',
          processedAt: performedAt,
        },
      });

      if (order.subscriptionId && order.plan) {
        await this.activateSubscription(tx, order, performedAt);
      }

      await tx.auditLog.create({
        data: {
          companyId: order.companyId,
          action: AuditAction.CREATE,
          entityType: 'PaymentOrder',
          entityId: order.id,
          metadata: {
            event: 'PAYMENT_CAPTURED',
            provider: params.provider,
            providerTransactionId: params.providerTransactionId,
            amountCents: order.amountCents,
          },
        },
      });

      const performed = await tx.providerTransaction.findUniqueOrThrow({
        where: { id: transaction.id },
      });

      this.logger.log(
        `Captured ${params.provider} ${params.providerTransactionId} for order ${order.id} (${order.amountCents} ${order.currency})`,
      );

      return { order: paidOrder, transaction: performed, captured: true };
    });
  }

  /**
   * Cancels or reverses a transaction.
   *
   * The resulting state depends on whether money had moved: cancelling a
   * created-but-unperformed transaction is a no-op for the customer, while
   * cancelling a performed one is a refund and has to be recorded as a
   * separate ledger entry rather than by editing the original.
   */
  async cancel(params: {
    provider: PaymentProvider;
    providerTransactionId: string;
    reason?: number;
    canceledAt?: Date;
  }): Promise<SettlementResult | null> {
    const canceledAt = params.canceledAt ?? new Date();

    return this.prisma.client.$transaction(async (tx) => {
      const transaction = await tx.providerTransaction.findUnique({
        where: {
          provider_providerTransactionId: {
            provider: params.provider,
            providerTransactionId: params.providerTransactionId,
          },
        },
      });

      if (!transaction) return null;

      const order = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: transaction.orderId },
      });

      // Already cancelled: idempotent, report the existing state.
      if (
        transaction.state === ProviderTransactionState.CANCELED ||
        transaction.state === ProviderTransactionState.REVERSED
      ) {
        return { order, transaction, captured: false };
      }

      const wasPerformed =
        transaction.state === ProviderTransactionState.PERFORMED;

      const nextState = wasPerformed
        ? ProviderTransactionState.REVERSED
        : ProviderTransactionState.CANCELED;

      await tx.providerTransaction.update({
        where: { id: transaction.id },
        data: {
          state: nextState,
          canceledTime: canceledAt,
          reason: params.reason ?? null,
        },
      });

      await tx.paymentOrder.update({
        where: { id: order.id },
        data: {
          status: PaymentOrderStatus.CANCELED,
          // A reversed order was paid; clearing paidAt would erase that it ever
          // was, which the ledger and the refund entry both contradict.
          ...(wasPerformed ? {} : { paidAt: null }),
        },
      });

      if (wasPerformed) {
        // Correction as a new row: the ledger is append-only, so a refund is
        // recorded beside the original charge rather than replacing it.
        await tx.paymentTransaction.create({
          data: {
            companyId: order.companyId,
            subscriptionId: order.subscriptionId,
            orderId: order.id,
            provider: params.provider,
            providerTransactionId: `${params.provider}:${params.providerTransactionId}:refund`,
            amountCents: order.amountCents,
            currency: order.currency,
            status: PaymentStatus.REFUNDED,
            description: `Refund for ${order.description ?? 'payment'}`,
            processedAt: canceledAt,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          companyId: order.companyId,
          action: AuditAction.UPDATE,
          entityType: 'PaymentOrder',
          entityId: order.id,
          metadata: {
            event: wasPerformed ? 'PAYMENT_REVERSED' : 'PAYMENT_CANCELED',
            provider: params.provider,
            providerTransactionId: params.providerTransactionId,
            reason: params.reason ?? null,
          },
        },
      });

      const updated = await tx.providerTransaction.findUniqueOrThrow({
        where: { id: transaction.id },
      });

      return { order, transaction: updated, captured: false };
    });
  }

  /**
   * Starts or extends the subscription an order bought.
   *
   * Runs inside the capture transaction so a customer is never charged without
   * their plan changing — the two facts commit together or not at all.
   */
  private async activateSubscription(
    tx: Prisma.TransactionClient,
    order: PaymentOrder,
    paidAt: Date,
  ): Promise<void> {
    if (!order.subscriptionId || !order.plan) return;

    const subscription = await tx.subscription.findUnique({
      where: { id: order.subscriptionId },
    });
    if (!subscription) return;

    // Extend from the existing period end when it is still in the future, so
    // paying early adds time rather than discarding what is left.
    const base =
      subscription.currentPeriodEnd && subscription.currentPeriodEnd > paidAt
        ? subscription.currentPeriodEnd
        : paidAt;

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        plan: order.plan,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: paidAt,
        currentPeriodEnd: addMonthsUtc(base, 1),
        graceEndsAt: null,
        renewalAttempts: 0,
        lastRenewalError: null,
      },
    });
  }

  /** Marks pending orders past their deadline, so a gateway cannot pay them. */
  async expireStaleOrders(now = new Date()): Promise<number> {
    const { count } = await this.prisma.client.paymentOrder.updateMany({
      where: {
        status: PaymentOrderStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: PaymentOrderStatus.EXPIRED },
    });

    if (count > 0) this.logger.log(`Expired ${count} stale payment order(s)`);
    return count;
  }
}

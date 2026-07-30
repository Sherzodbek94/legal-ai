import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentOrderStatus,
  SubscriptionPlan,
  type PaymentOrder,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { getPlan } from '../../billing/plans/plan-catalog';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class PaymentOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * How long a customer has to complete a payment.
   *
   * Under Payme's own 12-hour transaction timeout, so our order can never
   * outlive the gateway transaction pointing at it. The reverse would leave an
   * order payable that Payme has already written off.
   */
  private get ttlMs(): number {
    return this.config.get<number>('PAYMENT_ORDER_TTL_MS', 6 * 60 * 60 * 1000);
  }

  /**
   * Creates the order a gateway will be pointed at.
   *
   * Amount comes from the plan catalogue, never from the request: a
   * client-supplied price is a client-supplied discount.
   */
  async create(dto: CreateOrderDto, user: AuthenticatedUser): Promise<PaymentOrder> {
    const companyId = user.companyId!;
    const definition = getPlan(dto.plan);

    if (dto.plan === SubscriptionPlan.FREE) {
      throw new ConflictException('The Free plan does not require payment');
    }

    const subscription = await this.prisma.client.subscription.findFirst({
      where: { companyId, deletedAt: null },
      select: { id: true },
    });

    return this.prisma.client.paymentOrder.create({
      data: {
        companyId,
        subscriptionId: subscription?.id,
        plan: dto.plan,
        amountCents: definition.monthlyPriceCents,
        currency: definition.currency,
        description: `${definition.name} subscription`,
        status: PaymentOrderStatus.PENDING,
        expiresAt: new Date(Date.now() + this.ttlMs),
      },
    });
  }

  /** Tenant-scoped: an order id from another company must not resolve. */
  async findOne(id: string, companyId: string): Promise<PaymentOrder> {
    const order = await this.prisma.client.paymentOrder.findFirst({
      where: { id, companyId },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async list(companyId: string, take = 50) {
    return this.prisma.client.paymentOrder.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 100),
      select: {
        id: true,
        plan: true,
        amountCents: true,
        currency: true,
        status: true,
        provider: true,
        description: true,
        expiresAt: true,
        paidAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Cancels an unpaid order.
   *
   * Guarded on PENDING so it cannot race a gateway capture landing at the same
   * moment — if the payment won, this matches zero rows and reports the
   * conflict rather than marking a paid order cancelled.
   */
  async cancel(id: string, companyId: string): Promise<void> {
    const { count } = await this.prisma.client.paymentOrder.updateMany({
      where: { id, companyId, status: PaymentOrderStatus.PENDING },
      data: { status: PaymentOrderStatus.CANCELED },
    });

    if (count === 0) {
      throw new ConflictException(
        'Order is not pending and can no longer be cancelled',
      );
    }
  }
}

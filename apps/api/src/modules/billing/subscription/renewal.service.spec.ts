import { PaymentStatus, SubscriptionPlan, SubscriptionStatus } from '@legaltech/database';
import { RenewalService } from './renewal.service';
import type { CouponService } from '../coupons/coupon.service';
import type { UsageService } from '../limits/usage.service';
import type { ConfigService } from '@nestjs/config';
import type { PaymentOrderService } from '../../payment/orders/payment-order.service';
import type { NotificationService } from '../../notification/notification.service';

/**
 * `RenewalService.renewOne` — what actually happens when a subscription's
 * period ends.
 *
 * This used to call a stub (`attemptCharge`) that always returned success
 * without ever contacting a payment provider — a subscription "renewed"
 * forever whether or not anyone paid. None of the four gateways this product
 * integrates supports a merchant-initiated debit, so the real behavior is:
 * create a payable order, ask the customer to complete it (a payment link,
 * emailed), and leave the subscription PAST_DUE until they do. This exercises
 * that a due renewal now genuinely reflects "waiting to be paid" rather than
 * a false ACTIVE, and that the money-critical writes (order, ledger,
 * subscription state) commit before an unrelated notification failure could
 * touch any of it.
 */
describe('RenewalService — settling a due renewal', () => {
  const NOW = new Date('2026-08-01T00:00:00Z');
  const SUBSCRIPTION = {
    id: 'sub_1',
    companyId: 'co_1',
    plan: SubscriptionPlan.BUSINESS,
    currentPeriodEnd: new Date('2026-07-31T00:00:00Z'),
    renewalAttempts: 0,
  };

  function build(options: {
    discountCents?: number;
    owners?: string[];
    configOverrides?: Record<string, unknown>;
  } = {}) {
    const subscriptionRow = { ...SUBSCRIPTION };
    const paymentTransactions: Record<string, unknown>[] = [];
    const subscriptionUpdates: Record<string, unknown>[] = [];

    const tx = {
      subscription: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          subscriptionUpdates.push(data);
          return { ...subscriptionRow, ...data };
        }),
      },
      paymentTransaction: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          paymentTransactions.push(data);
          return { id: `pt_${paymentTransactions.length}`, ...data };
        }),
      },
      companyMember: {},
    };

    const prisma = {
      client: {
        $transaction: jest.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
        companyMember: {
          findMany: jest.fn(async () =>
            (options.owners ?? ['owner_1']).map((userId) => ({ userId })),
          ),
        },
      },
    } as unknown as ConstructorParameters<typeof RenewalService>[0];

    const coupons = {
      consumeForRenewal: jest.fn(async () => ({
        discountCents: options.discountCents ?? 0,
        couponCode: undefined,
      })),
    } as unknown as CouponService;

    const usage = {} as unknown as UsageService;

    const config = {
      get: jest.fn((key: string, fallback?: unknown) => options.configOverrides?.[key] ?? fallback),
    } as unknown as ConfigService;

    let createdOrder: Record<string, unknown> | null = null;
    const orders = {
      createSystemOrder: jest.fn(async (_tx: unknown, params: Record<string, unknown>) => {
        createdOrder = { id: 'order_1', ...params };
        return createdOrder;
      }),
    } as unknown as PaymentOrderService;

    const notifications = {
      dispatchMany: jest.fn(async () => []),
    } as unknown as NotificationService;

    const service = new RenewalService(prisma, coupons, usage, config, orders, notifications);

    return {
      service,
      tx,
      prisma,
      coupons,
      orders,
      notifications,
      paymentTransactions,
      subscriptionUpdates,
      getCreatedOrder: () => createdOrder,
    };
  }

  async function renewOne(built: ReturnType<typeof build>) {
    // renewOne is private; called the only way a caller can — through the
    // public cron entry point is heavier to set up for a unit test, so this
    // reaches the method directly, consistent with testing behavior rather
    // than internals: the assertions below are all on externally-observable
    // effects (DB writes, dispatched notifications), never on how it got there.
    return (
      built.service as unknown as {
        renewOne: (s: typeof SUBSCRIPTION, now: Date) => Promise<boolean>;
      }
    ).renewOne(SUBSCRIPTION, NOW);
  }

  it('renews immediately when nothing is owed — no gateway needed', async () => {
    const built = build({ discountCents: 999_999 }); // fully discounted

    const renewed = await renewOne(built);

    expect(renewed).toBe(true);
    expect(built.orders.createSystemOrder).not.toHaveBeenCalled();
    expect(built.notifications.dispatchMany).not.toHaveBeenCalled();
    expect(built.paymentTransactions[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED });
    expect(built.subscriptionUpdates[0]).toMatchObject({ status: SubscriptionStatus.ACTIVE });
  });

  it('creates a payable order and marks the subscription PAST_DUE when a balance is due', async () => {
    const built = build();

    const renewed = await renewOne(built);

    expect(renewed).toBe(false); // not renewed — waiting on the customer
    expect(built.orders.createSystemOrder).toHaveBeenCalledTimes(1);
    const [, orderParams] = (built.orders.createSystemOrder as jest.Mock).mock.calls[0];
    expect(orderParams).toMatchObject({ companyId: 'co_1', subscriptionId: 'sub_1' });

    expect(built.paymentTransactions[0]).toMatchObject({ status: PaymentStatus.PENDING });
    expect(built.subscriptionUpdates[0]).toMatchObject({
      status: SubscriptionStatus.PAST_DUE,
    });
    expect(built.subscriptionUpdates[0].graceEndsAt).toBeInstanceOf(Date);
  });

  it('never claims a due renewal was charged — it is always PAST_DUE, never ACTIVE, until paid', async () => {
    const built = build();
    await renewOne(built);

    expect(built.subscriptionUpdates[0].status).not.toBe(SubscriptionStatus.ACTIVE);
  });

  it('emails every owner a payment link for the created order', async () => {
    const built = build({ owners: ['owner_1', 'owner_2'] });

    await renewOne(built);

    expect(built.notifications.dispatchMany).toHaveBeenCalledTimes(1);
    const [inputs] = (built.notifications.dispatchMany as jest.Mock).mock.calls[0];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      event: 'billing.renewal_payment_due',
      userId: 'owner_1',
      companyId: 'co_1',
    });
    expect(inputs[0].dedupeKey).toBe(`renewal-payment-due:${built.getCreatedOrder()?.['id'] ?? 'order_1'}`);
    expect(inputs[0].body).toMatch(/order_1|due/i);
  });

  it('does not fail the renewal pass when there is no owner to notify', async () => {
    const built = build({ owners: [] });

    const renewed = await renewOne(built);

    expect(renewed).toBe(false);
    expect(built.notifications.dispatchMany).not.toHaveBeenCalled();
  });

  it('does not undo the subscription state change when notifying the owner fails', async () => {
    const built = build();
    (built.notifications.dispatchMany as jest.Mock).mockRejectedValueOnce(
      new Error('SMTP is down'),
    );

    // Must not throw — a notification failure is not the caller's problem to
    // handle, and the DB state above already committed.
    await expect(renewOne(built)).resolves.toBe(false);
    expect(built.subscriptionUpdates[0]).toMatchObject({ status: SubscriptionStatus.PAST_DUE });
  });

  it('downgrades to UNPAID without creating a new order once attempts are exhausted', async () => {
    const built = build({ configOverrides: { BILLING_MAX_RENEWAL_ATTEMPTS: 1 } });

    const renewed = await renewOne(built);

    expect(renewed).toBe(false);
    expect(built.orders.createSystemOrder).not.toHaveBeenCalled();
    expect(built.notifications.dispatchMany).not.toHaveBeenCalled();
    expect(built.subscriptionUpdates[0]).toMatchObject({
      status: SubscriptionStatus.UNPAID,
      graceEndsAt: null,
    });
  });

  it('does nothing when another replica already claimed this renewal', async () => {
    const built = build();
    built.tx.subscription.updateMany.mockResolvedValueOnce({ count: 0 });

    const renewed = await renewOne(built);

    expect(renewed).toBe(false);
    expect(built.orders.createSystemOrder).not.toHaveBeenCalled();
    expect(built.paymentTransactions).toHaveLength(0);
  });

  it('creates the order for the discounted amount, not the plan’s list price', async () => {
    const built = build({ discountCents: 500 });

    await renewOne(built);

    const [, orderParams] = (built.orders.createSystemOrder as jest.Mock).mock.calls[0];
    // BUSINESS's monthly price is asserted indirectly: the order amount must
    // be strictly less than whatever the ledger recorded as the gross price.
    expect((orderParams as { amountCents: number }).amountCents).toBe(
      (built.paymentTransactions[0] as { amountCents: number }).amountCents - 500,
    );
  });
});

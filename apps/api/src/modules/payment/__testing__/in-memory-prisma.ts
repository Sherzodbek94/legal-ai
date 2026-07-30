/**
 * An in-memory stand-in for the Prisma models the payment module touches.
 *
 * The gateway handlers are almost entirely about *state transitions* — has this
 * transaction already been performed, is this order still payable, did a retry
 * change anything — and mocking individual Prisma calls with `jest.fn()` tests
 * the mock rather than the logic. This keeps real rows in memory so a webhook
 * delivered twice genuinely hits the second-delivery path.
 *
 * It implements only the query shapes the module actually uses. Anything else
 * throws loudly rather than returning undefined, so a new query in the service
 * fails the test instead of silently passing against a stub that answers `null`
 * to everything.
 */
import {
  PaymentOrderStatus,
  PaymentProvider,
  Prisma,
  ProviderTransactionState,
  type PaymentOrder,
  type ProviderTransaction,
} from '@legaltech/database';

let sequence = 0;
const nextId = (prefix: string) => `${prefix}_${++sequence}`;

/**
 * A genuine `PrismaClientKnownRequestError`, not a look-alike.
 *
 * The services branch on `error instanceof Prisma.PrismaClientKnownRequestError`
 * before reading the code, so a hand-rolled error with a `.code` of 'P2002'
 * would skip that branch entirely and the tests would pass against a path
 * production never takes.
 */
export function uniqueConstraintError(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'in-memory',
    meta: { target },
  });
}

interface Tables {
  paymentOrder: PaymentOrder[];
  providerTransaction: ProviderTransaction[];
  paymentTransaction: Record<string, unknown>[];
  subscription: Record<string, unknown>[];
  auditLog: Record<string, unknown>[];
  idempotencyRecord: Record<string, unknown>[];
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;

    const value = row[key];

    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>;

      if ('in' in operators) {
        if (!(operators.in as unknown[]).includes(value)) return false;
        continue;
      }
      if ('not' in operators) {
        if (value === operators.not) return false;
        continue;
      }
      if ('lte' in operators) {
        if (!(value instanceof Date) || value > (operators.lte as Date)) return false;
        continue;
      }
      if ('gte' in operators) {
        if (!(value instanceof Date) || value < (operators.gte as Date)) return false;
        continue;
      }
      throw new Error(`in-memory prisma: unsupported operator ${JSON.stringify(condition)}`);
    }

    if (value instanceof Date && condition instanceof Date) {
      if (value.getTime() !== condition.getTime()) return false;
      continue;
    }

    if (value !== condition) return false;
  }
  return true;
}

export class InMemoryPrisma {
  readonly tables: Tables = {
    paymentOrder: [],
    providerTransaction: [],
    paymentTransaction: [],
    subscription: [],
    auditLog: [],
    idempotencyRecord: [],
  };

  /** Stands in for `PrismaService.client`. */
  readonly client = {
    paymentOrder: this.model<PaymentOrder>('paymentOrder', 'order'),
    providerTransaction: this.providerTransactionModel(),
    paymentTransaction: this.model<Record<string, unknown>>('paymentTransaction', 'txn'),
    subscription: this.model<Record<string, unknown>>('subscription', 'sub'),
    auditLog: this.model<Record<string, unknown>>('auditLog', 'audit'),
    idempotencyRecord: this.idempotencyModel(),

    /**
     * Interactive transactions run the callback against the same store.
     *
     * No rollback: these tests assert committed outcomes and retry behaviour,
     * not partial-failure recovery. Anything that depends on a rollback would
     * need a real database to mean anything.
     */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(this.client),
  };

  seedOrder(overrides: Partial<PaymentOrder> = {}): PaymentOrder {
    const order = {
      id: overrides.id ?? nextId('order'),
      companyId: 'co_1',
      subscriptionId: null,
      plan: null,
      amountCents: 4900,
      currency: 'usd',
      status: PaymentOrderStatus.PENDING,
      description: 'Pro subscription',
      provider: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      paidAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as PaymentOrder;

    this.tables.paymentOrder.push(order);
    return order;
  }

  seedTransaction(
    overrides: Partial<ProviderTransaction> & {
      provider: PaymentProvider;
      providerTransactionId: string;
      orderId: string;
    },
  ): ProviderTransaction {
    const transaction = {
      id: overrides.id ?? nextId('ptxn'),
      amountCents: 4900,
      state: ProviderTransactionState.CREATED,
      reason: null,
      createdTime: new Date(),
      performedTime: null,
      canceledTime: null,
      rawPayload: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as ProviderTransaction;

    this.tables.providerTransaction.push(transaction);
    return transaction;
  }

  reset(): void {
    for (const key of Object.keys(this.tables) as (keyof Tables)[]) {
      this.tables[key].length = 0;
    }
  }

  // ---------------------------------------------------------------------------

  private model<T extends Record<string, unknown>>(
    table: keyof Tables,
    idPrefix: string,
  ) {
    const rows = () => this.tables[table] as unknown as T[];

    return {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        rows().find((row) => matches(row, where)) ?? null,

      findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
        const found = rows().find((row) => matches(row, where));
        if (!found) throw new Error(`${String(table)} not found`);
        return found;
      },

      findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        rows().find((row) => matches(row, where ?? {})) ?? null,

      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        rows().filter((row) => matches(row, where ?? {})),

      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: (data.id as string) ?? nextId(idPrefix),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as unknown as T;
        rows().push(row);
        return row;
      },

      update: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = rows().find((candidate) => matches(candidate, where));
        if (!row) throw new Error(`${String(table)} not found for update`);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },

      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const targets = rows().filter((row) => matches(row, where));
        for (const row of targets) {
          Object.assign(row, data, { updatedAt: new Date() });
        }
        return { count: targets.length };
      },

      deleteMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const all = rows();
        const keep = all.filter((row) => !matches(row, where ?? {}));
        const removed = all.length - keep.length;
        all.length = 0;
        all.push(...keep);
        return { count: removed };
      },

      count: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        rows().filter((row) => matches(row, where ?? {})).length,
    };
  }

  /** Adds the compound-unique lookup and constraint the service relies on. */
  private providerTransactionModel() {
    const base = this.model<ProviderTransaction>('providerTransaction', 'ptxn');
    const rows = () => this.tables.providerTransaction;

    const resolve = (where: Record<string, unknown>) => {
      const compound = where.provider_providerTransactionId as
        | { provider: PaymentProvider; providerTransactionId: string }
        | undefined;

      return compound
        ? (row: ProviderTransaction) =>
            row.provider === compound.provider &&
            row.providerTransactionId === compound.providerTransactionId
        : (row: ProviderTransaction) =>
            matches(row as unknown as Record<string, unknown>, where);
    };

    return {
      ...base,

      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        rows().find(resolve(where)) ?? null,

      findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
        const found = rows().find(resolve(where));
        if (!found) throw new Error('providerTransaction not found');
        return found;
      },

      create: async ({ data }: { data: Record<string, unknown> }) => {
        const duplicate = rows().some(
          (row) =>
            row.provider === data.provider &&
            row.providerTransactionId === data.providerTransactionId,
        );
        // The real defence against double-billing, reproduced faithfully: a
        // second insert for the same gateway transaction must fail.
        if (duplicate) {
          throw uniqueConstraintError(['provider', 'providerTransactionId']);
        }
        return base.create({ data });
      },
    };
  }

  private idempotencyModel() {
    const base = this.model<Record<string, unknown>>('idempotencyRecord', 'idem');
    const rows = () => this.tables.idempotencyRecord;

    return {
      ...base,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (rows().some((row) => row.key === data.key)) {
          throw uniqueConstraintError(['key']);
        }
        return base.create({ data });
      },
    };
  }
}

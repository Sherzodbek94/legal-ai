import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentService } from './payment.service';
import { IdempotencyService } from './idempotency/idempotency.service';

/**
 * Housekeeping for the payment tables.
 *
 * Both jobs are idempotent and bounded by a WHERE clause, so running them on
 * several replicas at once is harmless — the second run simply matches nothing.
 */
@Injectable()
export class PaymentMaintenanceService {
  private readonly logger = new Logger(PaymentMaintenanceService.name);

  constructor(
    private readonly payments: PaymentService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Closes orders nobody paid.
   *
   * Every ten minutes rather than nightly: an order that stays PENDING past its
   * deadline is still payable by a gateway callback, and the window between
   * expiry and cleanup is exactly when a stale checkout session lands.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'payments:expire-orders' })
  async expireOrders(): Promise<number> {
    return this.payments.expireStaleOrders();
  }

  /** Drops replay records the gateways have long stopped retrying against. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'payments:prune-idempotency' })
  async pruneIdempotencyRecords(): Promise<number> {
    const pruned = await this.idempotency.prune();
    if (pruned > 0) this.logger.log(`Pruned ${pruned} idempotency record(s)`);
    return pruned;
  }
}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentOrderService } from './orders/payment-order.service';
import { IdempotencyService } from './idempotency/idempotency.service';
import { PaymentMaintenanceService } from './payment-maintenance.service';
import { ClickController } from './providers/click/click.controller';
import { ClickService } from './providers/click/click.service';
import { PaymeController } from './providers/payme/payme.controller';
import { PaymeService } from './providers/payme/payme.service';
import { UzumController } from './providers/uzum/uzum.controller';
import { UzumService } from './providers/uzum/uzum.service';
import { StripeController } from './providers/stripe/stripe.controller';
import { StripeService } from './providers/stripe/stripe.service';

/**
 * Payment gateways.
 *
 * Four adapters over one settlement path. Each controller speaks its gateway's
 * wire protocol and nothing else; everything that moves money — registering a
 * transaction, capturing it, activating the subscription — goes through
 * PaymentService, so the double-billing defences exist in one place rather than
 * four.
 */
@Module({
  imports: [ConfigModule],
  controllers: [
    PaymentController,
    ClickController,
    PaymeController,
    UzumController,
    StripeController,
  ],
  providers: [
    PaymentService,
    PaymentOrderService,
    IdempotencyService,
    PaymentMaintenanceService,
    ClickService,
    PaymeService,
    UzumService,
    StripeService,
  ],
  exports: [PaymentService, PaymentOrderService, IdempotencyService],
})
export class PaymentModule {}

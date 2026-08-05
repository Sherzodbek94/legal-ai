import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentModule } from '../payment/payment.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { SubscriptionService } from './subscription/subscription.service';
import { RenewalService } from './subscription/renewal.service';
import { CouponService } from './coupons/coupon.service';
import { UsageService } from './limits/usage.service';
import { PlanLimitGuard } from './limits/plan-limit.guard';
import { QuotaRefundInterceptor } from './limits/quota-refund.interceptor';

/**
 * Subscription and Limits System.
 *
 * Global because PlanLimitGuard is applied on routes in other modules — the AI
 * engine and document generation both meter against a plan — and those modules
 * should not each have to import billing to decorate a handler.
 *
 * RenewalService registers cron handlers via @Cron; ScheduleModule.forRoot() in
 * AppModule is what actually starts them.
 */
@Global()
@Module({
  imports: [ConfigModule, PaymentModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    SubscriptionService,
    RenewalService,
    CouponService,
    UsageService,
    PlanLimitGuard,
    QuotaRefundInterceptor,
  ],
  exports: [
    BillingService,
    SubscriptionService,
    CouponService,
    UsageService,
    PlanLimitGuard,
    QuotaRefundInterceptor,
  ],
})
export class BillingModule {}

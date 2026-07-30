import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { WinstonModule } from 'nest-winston';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { winstonConfig } from './common/logger/winston.config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { CompanyModule } from './modules/company/company.module';
import { TemplateModule } from './modules/template/template.module';
import { DocumentModule } from './modules/document/document.module';
import { AiModule } from './modules/ai/ai.module';
import { AiEngineModule } from './modules/ai-engine/ai-engine.module';
import { BillingModule } from './modules/billing/billing.module';
import { PaymentModule } from './modules/payment/payment.module';
import { AdminModule } from './modules/admin/admin.module';
import { OcrSearchModule } from './modules/ocr-search/ocr-search.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsInterceptor } from './modules/health/metrics.interceptor';
import { ImpersonationGuard } from './modules/admin/impersonation/impersonation.guard';
import { PlanLimitGuard } from './modules/billing/limits/plan-limit.guard';
import { QuotaRefundInterceptor } from './modules/billing/limits/quota-refund.interceptor';
import { NotificationModule } from './modules/notification/notification.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    WinstonModule.forRoot(winstonConfig),
    // Starts the @Cron handlers registered by RenewalService.
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: 'default',
          ttl: config.get<number>('THROTTLE_TTL', 60000),
          limit: config.get<number>('THROTTLE_LIMIT', 100),
        },
      ],
    }),
    PrismaModule,
    RedisModule,
    // Before the feature modules: its shutdown hook must be registered early so
    // readiness starts failing before anything else begins tearing down.
    HealthModule,
    StorageModule,
    AuthModule,
    CompanyModule,
    TemplateModule,
    DocumentModule,
    AiModule,
    AiEngineModule,
    BillingModule,
    PaymentModule,
    AdminModule,
    OcrSearchModule,
    NotificationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Guard order is registration order: shed abusive load first, then
    // authenticate, then authorize. Authentication is deny-by-default —
    // routes must opt out with @Public().
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Blocks money-moving and credential-changing routes while impersonating.
    // Ahead of PlanLimitGuard so a forbidden action never consumes quota.
    {
      provide: APP_GUARD,
      useClass: ImpersonationGuard,
    },
    // Last guard: quota is a property of an authenticated, authorised tenant,
    // so there is nothing to meter until the two above have run.
    {
      provide: APP_GUARD,
      useClass: PlanLimitGuard,
    },
    // Outermost interceptor, so its timer spans everything below it — including
    // the time the quota interceptor spends. Measuring only the handler would
    // under-report what a client actually waited for.
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
    // Refunds quota reserved by PlanLimitGuard when the handler throws.
    // Registered globally rather than per-route because a forgotten refund is
    // invisible until a customer notices their allowance was wrong.
    {
      provide: APP_INTERCEPTOR,
      useClass: QuotaRefundInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}

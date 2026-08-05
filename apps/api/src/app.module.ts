import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { WinstonModule } from 'nest-winston';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { winstonConfig } from './common/logger/winston.config';
import { numericConfig } from './config/numeric-config';
import { validateEnv } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { CompanyModule } from './modules/company/company.module';
import { CounterpartyModule } from './modules/counterparty/counterparty.module';
import { LegalCorpusModule } from './modules/legal-corpus/legal-corpus.module';
import { ChatModule } from './modules/chat/chat.module';
import { TemplateModule } from './modules/template/template.module';
import { DocumentModule } from './modules/document/document.module';
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
      /**
       * The repository root `.env` first, then a local one.
       *
       * Without this the API only ever finds `apps/api/.env`: `@nestjs/config`
       * resolves a bare `.env` against the process CWD, and both `npm run dev`
       * (through Turborepo) and `node dist/main` run with the CWD set to
       * `apps/api`. The root `.env` this repo actually documents was never
       * read, so a correctly configured checkout still died at boot with
       * "JWT_ACCESS_SECRET is not configured".
       *
       * Order matters — earlier files win — so a developer can still drop an
       * `apps/api/.env` to override a single value locally without editing the
       * shared one. In production nothing is read from a file at all: the
       * Kubernetes deployment injects real values as environment variables,
       * which take precedence over both.
       */
      envFilePath: [join(__dirname, '../../../.env'), '.env'],
      // Turns the numeric settings into actual numbers — see numericConfig.
      load: [numericConfig],
      // Refuses to boot on a broken environment — see envValidation for what
      // counts as broken and why each rule is worth a failed startup.
      validate: validateEnv,
    }),
    WinstonModule.forRoot(winstonConfig),
    // Starts the @Cron handlers registered by RenewalService.
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('THROTTLE_TTL', 60000),
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],
        /**
         * Off under test.
         *
         * The e2e suite drives the real application over HTTP and signs in
         * repeatedly — every tenant-isolation case creates two companies and
         * logs both in. Against the production limits (`@Throttle` caps login
         * at 5/minute, deliberately, because it guards a password) the suite
         * rate-limits *itself*: 29 of 47 cases failed on `429 Too Many
         * Requests` rather than on anything they were written to check.
         *
         * Raising `THROTTLE_LIMIT` would not have helped — the per-route
         * `@Throttle` decorators override the global figure — so the skip has
         * to happen at the guard.
         *
         * Two ways in, both refused outright in production:
         *
         *   NODE_ENV=test         set by `test/global-setup.ts`.
         *   THROTTLE_DISABLED     an explicit local switch, for the Playwright
         *                         suite — it drives the *dev* server over HTTP,
         *                         where NODE_ENV is `development`, and hits the
         *                         same 429 wall.
         *
         * The `NODE_ENV !== 'production'` guard is what makes the second one
         * safe: a stray `THROTTLE_DISABLED=true` in a production environment
         * cannot switch off rate limiting on a password endpoint.
         *
         * The throttler's own behaviour is covered separately by unit tests
         * that assert the guard's decisions directly.
         */
        skipIf: () => {
          if (process.env.NODE_ENV === 'production') return false;
          return (
            process.env.NODE_ENV === 'test' ||
            process.env.THROTTLE_DISABLED === 'true'
          );
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    // Before the feature modules: its shutdown hook must be registered early so
    // readiness starts failing before anything else begins tearing down.
    HealthModule,
    StorageModule,
    AuthModule,
    CompanyModule,
    CounterpartyModule,
    TemplateModule,
    DocumentModule,
    AiEngineModule,
    BillingModule,
    PaymentModule,
    AdminModule,
    OcrSearchModule,
    LegalCorpusModule,
    ChatModule,
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

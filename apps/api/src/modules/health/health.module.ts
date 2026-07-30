import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController, MetricsController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { ShutdownService } from './shutdown.service';
import { MetricsService } from './metrics.service';
import { MetricsInterceptor } from './metrics.interceptor';

/**
 * Health, metrics, and shutdown coordination.
 *
 * Global because `MetricsService` is injected by the interceptor registered in
 * AppModule, and because other modules should be able to increment a business
 * counter without importing this one.
 *
 * TerminusModule is configured with a short logger — its default logs every
 * successful check, which at one probe every ten seconds per pod is a great deal
 * of noise for information already visible in the metrics.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    TerminusModule.forRoot({
      // Only failures are logged. A passing probe is the normal case and does
      // not need a line in the log for each of them.
      logger: false,
      errorLogStyle: 'pretty',
      // Terminus's own shutdown timeout. Left at the default; the real drain is
      // coordinated by ShutdownService, which runs as an application shutdown
      // hook rather than inside Terminus.
      gracefulShutdownTimeoutMs: 1000,
    }),
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    PrismaHealthIndicator,
    RedisHealthIndicator,
    ShutdownService,
    MetricsService,
    MetricsInterceptor,
  ],
  exports: [MetricsService, ShutdownService, MetricsInterceptor],
})
export class HealthModule {}

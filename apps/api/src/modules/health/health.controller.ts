import {
  Controller,
  Get,
  Header,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  type HealthCheckResult,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaHealthIndicator } from './indicators/prisma.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { ShutdownService } from './shutdown.service';
import { MetricsService } from './metrics.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Health and metrics endpoints.
 *
 * All are `@Public()` — a probe has no credentials and a scrape happens before
 * anything is signed in — and all are `@SkipThrottle()`, because the kubelet
 * probes several times a minute per pod and Prometheus scrapes every 15 seconds.
 * Rate-limiting them would eventually mark healthy pods unready and cause exactly
 * the outage the probes exist to prevent.
 *
 * These routes are excluded from the global `api` prefix (see main.ts) so the
 * kubelet reaches them at `/health/live` directly on the pod, without the
 * ingress path in between.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly shutdown: ShutdownService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Liveness — "is this process wedged?"
   *
   * DELIBERATELY DOES NOT CHECK POSTGRES OR REDIS. This is the single most
   * important decision in this file.
   *
   * A liveness probe failing means Kubernetes RESTARTS the pod. If it checked the
   * database, a thirty-second Postgres failover would fail liveness on every
   * replica simultaneously, restart all of them, and turn a recoverable
   * dependency blip into a full outage — with a thundering herd of cold pods
   * reconnecting the moment the database came back. Restarting a process never
   * fixes a database, so the check must not be able to ask for it.
   *
   * What it does check is what a restart CAN fix: a process that has run out of
   * heap and is spending its time in GC.
   */
  @Public()
  @SkipThrottle()
  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([
      // Generous, and intentionally so: this is a "the process is broken beyond
      // recovery" threshold, not a capacity alarm. Chromium and Tesseract both
      // hold hundreds of megabytes legitimately, and the container's own memory
      // limit is the real backstop.
      () => this.memory.checkHeap('heap', 1_536 * 1024 * 1024),
    ]);
  }

  /**
   * Readiness — "can this pod serve a request right now?"
   *
   * Failing removes the pod from the Service endpoints without restarting it,
   * which is the correct response to a dependency being unavailable: stop
   * sending it traffic, keep it alive, let it recover.
   *
   * Returns 503 immediately once shutdown begins, which is what drains the pod
   * during a rolling deploy — see ShutdownService.
   */
  @Public()
  @SkipThrottle()
  @Get('ready')
  @HealthCheck()
  async ready(): Promise<HealthCheckResult> {
    if (this.shutdown.isShuttingDown()) {
      this.metrics.ready.set(0);

      // Thrown rather than returned so the response is a 503 with no dependency
      // detail. During a drain the dependencies are usually still fine, and
      // reporting them as healthy alongside a 503 reads as a contradiction in
      // the probe logs.
      throw new ServiceUnavailableException({
        status: 'shutting_down',
        drainingForSeconds: this.shutdown.drainingFor(),
      });
    }

    try {
      const result = await this.health.check([
        () => this.prisma.check('postgres'),
        () => this.redis.check('redis'),
      ]);

      this.metrics.ready.set(1);
      this.metrics.dependencyUp.set({ dependency: 'postgres' }, 1);
      this.metrics.dependencyUp.set({ dependency: 'redis' }, 1);

      return result;
    } catch (error) {
      this.metrics.ready.set(0);

      // Terminus throws a ServiceUnavailableException carrying the per-indicator
      // results; reading them lets the gauge attribute the failure to the right
      // dependency rather than just recording that something was down.
      const details = (error as { response?: { details?: Record<string, { status?: string }> } })
        ?.response?.details;

      if (details) {
        for (const [dependency, detail] of Object.entries(details)) {
          this.metrics.dependencyUp.set(
            { dependency },
            detail?.status === 'up' ? 1 : 0,
          );
        }
      }

      throw error;
    }
  }

  /**
   * Aggregate health, for humans and for uptime monitors.
   *
   * Kept at `/health` because that is what the existing Deployment manifests and
   * the Docker HEALTHCHECK point at. Behaves like readiness.
   */
  @Public()
  @SkipThrottle()
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prisma.check('postgres'),
      () => this.redis.check('redis'),
      () => this.memory.checkHeap('heap', 1_536 * 1024 * 1024),
    ]);
  }
}

/**
 * Prometheus scrape endpoint.
 *
 * A separate controller because it lives at `/metrics`, not under `/health`.
 *
 * NOT EXPOSED PUBLICLY: the ingress routes only `/`, `/api`, and `/socket.io`, so
 * `/metrics` is reachable only from inside the cluster. That is the intended
 * boundary — the payload names every route, reports request volumes, and would
 * tell an outsider a great deal about the shape of the system. If an ingress rule
 * for it is ever added, it needs authentication in front.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @SkipThrottle()
  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}

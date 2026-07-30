/**
 * Health endpoint behaviour.
 *
 * The property under test is the liveness/readiness split. Getting it backwards
 * does not fail loudly — it produces a service that restarts every pod when the
 * database hiccups, or one that keeps receiving traffic while it shuts down. Both
 * only appear under the conditions they make worse.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  HealthCheckService,
  HealthIndicatorService,
  MemoryHealthIndicator,
  TerminusModule,
} from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { ShutdownService } from './shutdown.service';
import { MetricsService } from './metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

function makeConfig(values: Record<string, unknown> = {}) {
  return {
    get: <T>(key: string, fallback?: T) => (values[key] as T) ?? fallback,
    getOrThrow: <T>(key: string) => values[key] as T,
  } as unknown as ConfigService;
}

describe('health endpoints', () => {
  let controller: HealthController;
  let shutdown: ShutdownService;
  let metrics: MetricsService;

  let postgresUp = true;
  let redisUp = true;

  beforeEach(async () => {
    postgresUp = true;
    redisUp = true;

    const prisma = {
      client: {
        $queryRaw: jest.fn(() =>
          postgresUp
            ? Promise.resolve([{ '?column?': 1 }])
            : Promise.reject(new Error('connection refused')),
        ),
      },
    } as unknown as PrismaService;

    const redis = {
      client: {
        ping: jest.fn(() =>
          redisUp ? Promise.resolve('PONG') : Promise.reject(new Error('ECONNREFUSED')),
        ),
        status: 'ready',
      },
    } as unknown as RedisService;

    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
      providers: [
        PrismaHealthIndicator,
        RedisHealthIndicator,
        ShutdownService,
        MetricsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: makeConfig() },
      ],
    }).compile();

    controller = moduleRef.get(HealthController);
    shutdown = moduleRef.get(ShutdownService);
    metrics = moduleRef.get(MetricsService);
    metrics.onModuleInit();
  });

  // ---------------------------------------------------------------------------
  // Liveness
  // ---------------------------------------------------------------------------

  describe('liveness', () => {
    it('passes when the process is healthy', async () => {
      const result = await controller.live();
      expect(result.status).toBe('ok');
    });

    it('passes even when Postgres is down', async () => {
      // THE critical property. Liveness failing restarts the pod, and restarting
      // a process cannot fix a database — it would restart every replica at once
      // and turn a recoverable blip into an outage.
      postgresUp = false;

      const result = await controller.live();
      expect(result.status).toBe('ok');
    });

    it('passes even when Redis is down', async () => {
      redisUp = false;

      const result = await controller.live();
      expect(result.status).toBe('ok');
    });

    it('does not query any dependency', async () => {
      const prisma = (controller as unknown as { prisma: PrismaHealthIndicator })
        .prisma;
      const spy = jest.spyOn(prisma, 'check');

      await controller.live();

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Readiness
  // ---------------------------------------------------------------------------

  describe('readiness', () => {
    it('passes when every dependency is reachable', async () => {
      const result = await controller.ready();

      expect(result.status).toBe('ok');
      expect(result.details.postgres.status).toBe('up');
      expect(result.details.redis.status).toBe('up');
    });

    it('fails when Postgres is unreachable', async () => {
      // Removes the pod from the Service without restarting it, which is the
      // correct response: stop sending traffic, let it recover.
      postgresUp = false;

      await expect(controller.ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('fails when Redis is unreachable', async () => {
      // Redis is not optional: without it nobody can log in, so a pod that
      // cannot reach it should not receive traffic.
      redisUp = false;

      await expect(controller.ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('reports response times, so a slow dependency is visible', async () => {
      const result = await controller.ready();
      expect(result.details.postgres.responseTimeMs).toEqual(expect.any(Number));
    });

    it('sets the readiness gauge on success', async () => {
      await controller.ready();

      const scraped = await metrics.scrape();
      expect(scraped).toMatch(/app_ready\{[^}]*\}\s+1/);
    });

    it('clears the readiness gauge on failure', async () => {
      postgresUp = false;
      await controller.ready().catch(() => undefined);

      const scraped = await metrics.scrape();
      expect(scraped).toMatch(/app_ready\{[^}]*\}\s+0/);
    });

    it('attributes a failure to the dependency that caused it', async () => {
      redisUp = false;
      await controller.ready().catch(() => undefined);

      const scraped = await metrics.scrape();
      // Postgres up, Redis down — the gauge has to distinguish them or the alert
      // cannot say which one to look at.
      expect(scraped).toMatch(/app_dependency_up\{[^}]*dependency="redis"[^}]*\}\s+0/);
      expect(scraped).toMatch(
        /app_dependency_up\{[^}]*dependency="postgres"[^}]*\}\s+1/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Draining
  // ---------------------------------------------------------------------------

  describe('during shutdown', () => {
    it('fails readiness immediately once SIGTERM arrives', async () => {
      // This is what drains the pod: readiness fails, the kubelet removes it from
      // the Service endpoints, and no new traffic is routed to it.
      void shutdown.onApplicationShutdown('SIGTERM');

      await expect(controller.ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('keeps liveness passing while draining', async () => {
      // The other half of the pair. If liveness also failed, Kubernetes would
      // kill the pod mid-drain and every in-flight export would truncate —
      // exactly what the graceful shutdown exists to prevent.
      void shutdown.onApplicationShutdown('SIGTERM');

      const result = await controller.live();
      expect(result.status).toBe('ok');
    });

    it('reports how long it has been draining', async () => {
      void shutdown.onApplicationShutdown('SIGTERM');

      const error = await controller.ready().catch((caught) => caught);
      expect(error.getResponse()).toMatchObject({
        status: 'shutting_down',
        drainingForSeconds: expect.any(Number),
      });
    });

    it('does not check dependencies while draining', async () => {
      // Dependencies are usually still fine during a drain; reporting them as
      // healthy alongside a 503 reads as a contradiction in the probe logs.
      void shutdown.onApplicationShutdown('SIGTERM');

      const prisma = (controller as unknown as { prisma: PrismaHealthIndicator })
        .prisma;
      const spy = jest.spyOn(prisma, 'check');

      await controller.ready().catch(() => undefined);

      expect(spy).not.toHaveBeenCalled();
    });
  });
});

describe('ShutdownService', () => {
  it('starts not shutting down', () => {
    const service = new ShutdownService(makeConfig());
    expect(service.isShuttingDown()).toBe(false);
    expect(service.drainingFor()).toBeNull();
  });

  it('flips the flag synchronously, before the drain completes', () => {
    // The flag has to be set immediately: readiness must begin failing while the
    // drain is still in progress, not after it.
    const service = new ShutdownService(makeConfig({ SHUTDOWN_DRAIN_SECONDS: 0 }));

    void service.onApplicationShutdown('SIGTERM');

    expect(service.isShuttingDown()).toBe(true);
  });

  it('is idempotent across repeated signals', async () => {
    const service = new ShutdownService(makeConfig({ SHUTDOWN_DRAIN_SECONDS: 0 }));

    await service.onApplicationShutdown('SIGTERM');
    const firstElapsed = service.drainingFor();

    await service.onApplicationShutdown('SIGINT');

    // A second signal must not restart the drain clock.
    expect(service.drainingFor()).toBe(firstElapsed);
  });

  it('waits for the configured drain window', async () => {
    const service = new ShutdownService(makeConfig({ SHUTDOWN_DRAIN_SECONDS: 0.2 }));

    const startedAt = Date.now();
    await service.onApplicationShutdown('SIGTERM');

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
  });

  it('defaults the drain window to match the preStop sleep in production', () => {
    // Both are 15s; they have to agree or the pod either drops traffic or waits
    // out its grace period on every deploy.
    expect(
      new ShutdownService(makeConfig({ NODE_ENV: 'production' })).drainSeconds,
    ).toBe(15);
  });

  it('does not drain outside production', () => {
    // There is no load balancer locally to notice the endpoint going away, so a
    // 15-second pause on every Ctrl-C or hot reload is friction with no benefit.
    expect(new ShutdownService(makeConfig()).drainSeconds).toBe(0);
    expect(
      new ShutdownService(makeConfig({ NODE_ENV: 'test' })).drainSeconds,
    ).toBe(0);
  });

  it('always honours an explicit override', () => {
    expect(
      new ShutdownService(
        makeConfig({ NODE_ENV: 'development', SHUTDOWN_DRAIN_SECONDS: 5 }),
      ).drainSeconds,
    ).toBe(5);
  });
});

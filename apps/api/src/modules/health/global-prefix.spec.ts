/**
 * Global prefix and probe-path exclusions.
 *
 * The Ingress routes `/api` to this service and passes the path through
 * unmodified, so the application must be mounted under `/api` or every request
 * arrives at a controller that is not there. That failure is invisible in local
 * development — where the browser talks to `localhost:4000` with no ingress in
 * between — and presents in the cluster as a 404 for the entire API.
 *
 * The probe and scrape paths must NOT be prefixed: the kubelet and Prometheus
 * reach the pod directly on port 4000, and the Deployment manifests reference
 * `/health/live`, `/health/ready`, and `/metrics` verbatim.
 */
import { Controller, Get, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController, MetricsController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { ShutdownService } from './shutdown.service';
import { MetricsService } from './metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

/** Stands in for a normal feature controller, which must be prefixed. */
@Controller('documents')
class SampleController {
  @Get()
  list() {
    return { items: [] };
  }
}

describe('global prefix', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const prisma = {
      client: { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) },
    } as unknown as PrismaService;

    const redis = {
      client: { ping: jest.fn().mockResolvedValue('PONG'), status: 'ready' },
    } as unknown as RedisService;

    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController, MetricsController, SampleController],
      providers: [
        PrismaHealthIndicator,
        RedisHealthIndicator,
        ShutdownService,
        MetricsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        {
          provide: ConfigService,
          useValue: {
            get: <T>(_key: string, fallback?: T) => fallback,
            getOrThrow: () => '',
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    // Exactly the configuration main.ts applies.
    app.setGlobalPrefix('api', {
      exclude: ['health', 'health/live', 'health/ready', 'metrics'],
    });

    // `app.init()` runs the lifecycle hooks, so MetricsService initialises
    // itself — calling it explicitly here would be the duplicate registration
    // its guard now catches.
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('feature routes', () => {
    it('are served under /api, which is what the Ingress forwards', async () => {
      await request(app.getHttpServer()).get('/api/documents').expect(200);
    });

    it('are NOT served unprefixed', async () => {
      // The bug this file exists for: without the prefix the ingress path
      // `/api/documents` would 404 while `/documents` worked, so every
      // environment behind an ingress would be broken and local dev would not.
      await request(app.getHttpServer()).get('/documents').expect(404);
    });
  });

  describe('probe paths', () => {
    it('serves /health/live unprefixed', async () => {
      // The kubelet reaches the pod directly on port 4000; there is no ingress to
      // add a prefix.
      await request(app.getHttpServer()).get('/health/live').expect(200);
    });

    it('serves /health/ready unprefixed', async () => {
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    });

    it('serves the aggregate /health unprefixed', async () => {
      // Referenced by the Docker HEALTHCHECK and by the startup probe.
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('does not also expose probes under the prefix', async () => {
      // Not harmful, but it would mean two paths reporting health and only one
      // being monitored.
      await request(app.getHttpServer()).get('/api/health/live').expect(404);
    });
  });

  describe('metrics', () => {
    it('serves /metrics unprefixed for Prometheus', async () => {
      const response = await request(app.getHttpServer()).get('/metrics').expect(200);

      // Prometheus exposition format.
      expect(response.text).toContain('# HELP');
      expect(response.text).toContain('# TYPE');
    });

    it('exposes the readiness gauge', async () => {
      const response = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(response.text).toContain('app_ready');
    });

    it('exposes default Node metrics under the configured prefix', async () => {
      const response = await request(app.getHttpServer()).get('/metrics').expect(200);
      // Event-loop lag is the leading indicator for this service: OCR blocks the
      // loop synchronously.
      expect(response.text).toContain('legaltech_nodejs_eventloop_lag');
      expect(response.text).toContain('legaltech_nodejs_heap_size_used_bytes');
    });

    it('is not exposed under the API prefix', async () => {
      // The ingress routes /api; keeping metrics off that path is what stops the
      // scrape endpoint being reachable from the internet.
      await request(app.getHttpServer()).get('/api/metrics').expect(404);
    });
  });
});

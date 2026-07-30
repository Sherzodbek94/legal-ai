import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WinstonModule } from 'nest-winston';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { winstonConfig } from './common/logger/winston.config';

async function bootstrap() {
  // Typed as the Express application so `set('trust proxy', …)` is available.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
    // Retains the untouched request bytes on `req.rawBody`. Stripe signs the
    // exact payload it posted, and the parsed-then-re-serialised body differs
    // in key order and whitespace — without this every webhook fails
    // verification. See StripeController.
    rawBody: true,
  });

  /**
   * Serves the application under `/api`.
   *
   * The Ingress routes `/api` to this service and passes the path through
   * unmodified, so without a matching prefix every request arrives as
   * `/api/auth/login` at a controller mounted on `/auth/login` — a 404 for the
   * entire API, in the cluster only, which local development would never reveal.
   *
   * Health and metrics are excluded. The kubelet probes the pod directly on port
   * 4000 with no ingress in between, and Prometheus scrapes the same way, so both
   * need to stay at the paths the manifests reference.
   */
  app.setGlobalPrefix('api', {
    exclude: ['health', 'health/live', 'health/ready', 'metrics'],
  });

  // Required so JwtStrategy and the auth controller can read HTTPOnly cookies.
  app.use(cookieParser());

  // Trust the reverse proxy (see infra/nginx) so `req.ip` reflects the real
  // client rather than the proxy — throttling and audit logs depend on it.
  app.set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown properties outright rather than silently dropping them.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Credentialed CORS requires an explicit origin allowlist — `*` is rejected
  // by browsers when cookies are in play.
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({ origin: origins, credentials: true });

  /**
   * Runs OnModuleDestroy / OnApplicationShutdown on SIGTERM.
   *
   * This is what makes a Kubernetes rolling deploy actually zero-downtime.
   * Without it the process is killed outright, and everything with a lifecycle
   * hook leaks or truncates: Chromium stays resident, in-flight PDF streams cut
   * mid-download, BullMQ workers abandon jobs without releasing their locks (so
   * they stall until the visibility timeout), and Prisma drops its pool without
   * draining. The pod terminates either way — the difference is whether the work
   * in flight survives.
   */
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  new Logger('Bootstrap').log(`API running on http://localhost:${port}`);
}

bootstrap();

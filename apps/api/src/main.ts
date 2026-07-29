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

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  new Logger('Bootstrap').log(`API running on http://localhost:${port}`);
}

bootstrap();

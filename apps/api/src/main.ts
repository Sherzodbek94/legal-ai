import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WinstonModule } from 'nest-winston';
import { AppModule } from './app.module';
import { winstonConfig } from './common/logger/winston.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
  });
  app.enableCors();

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  new Logger('Bootstrap').log(`API running on http://localhost:${port}`);
}

bootstrap();

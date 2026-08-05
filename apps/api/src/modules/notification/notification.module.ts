import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { PreferenceService } from './preference.service';
import { NotificationGateway } from './gateway/notification.gateway';
import { EmailService } from './providers/email.service';
import { EskizSmsService } from './providers/eskiz-sms.service';
import { TelegramService } from './providers/telegram.service';
import {
  EmailProcessor,
  SmsProcessor,
  TelegramProcessor,
} from './queues/channel.processors';
import { QUEUE_NAMES } from './queues/queue.constants';
import { AuthModule } from '../auth/auth.module';

/**
 * Notification engine.
 *
 * Global because almost every other module needs to notify someone — approvals,
 * billing, OCR, and admin locking all raise events — and having each of them import
 * this module to call one method is ceremony without benefit. Same reasoning as
 * BillingModule and AdminModule.
 *
 * BullMQ takes its own Redis connection rather than reusing `RedisService.client`:
 * BullMQ requires `maxRetriesPerRequest: null` on its connection (it manages
 * blocking commands itself and will refuse to start otherwise), and forcing that
 * setting onto the shared application client would change the failure behaviour of
 * every other Redis user in the process.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    HttpModule.register({ timeout: 15_000, maxRedirects: 0 }),
    // JwtService, for authenticating websocket handshakes against the same secret
    // the REST API uses.
    AuthModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL', 'redis://localhost:6379'),
          // Required by BullMQ; see the note above.
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
        defaultJobOptions: {
          // Belt and braces against Redis filling up: per-job options set the real
          // policy, but a job added without them still gets cleaned up.
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 24 * 3600 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EMAIL },
      { name: QUEUE_NAMES.SMS },
      { name: QUEUE_NAMES.TELEGRAM },
    ),
  ],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    PreferenceService,
    NotificationGateway,
    EmailService,
    EskizSmsService,
    TelegramService,
    EmailProcessor,
    SmsProcessor,
    TelegramProcessor,
  ],
  // EskizSmsService is exported for AuthModule's OtpService, which sends the
  // sign-in code directly rather than through the notification queue — a login
  // code that arrives after a retry backoff is a code that has already expired.
  // Exported rather than imported the other way round because NotificationModule
  // already imports AuthModule for the websocket handshake, and this module is
  // @Global, so the export reaches AuthModule without a forwardRef cycle.
  exports: [
    NotificationService,
    PreferenceService,
    NotificationGateway,
    EskizSmsService,
  ],
})
export class NotificationModule {}

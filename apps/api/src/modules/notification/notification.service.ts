import { Injectable, Logger } from '@nestjs/common';

export interface NotificationPayload {
  userId: string;
  message: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  async send(payload: NotificationPayload) {
    this.logger.log(`Notification queued for user ${payload.userId}`);
    return { queued: true, ...payload };
  }
}

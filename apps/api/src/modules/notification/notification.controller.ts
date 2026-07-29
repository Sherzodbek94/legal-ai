import { Body, Controller, Post } from '@nestjs/common';
import { NotificationPayload, NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post()
  send(@Body() payload: NotificationPayload) {
    return this.notificationService.send(payload);
  }
}

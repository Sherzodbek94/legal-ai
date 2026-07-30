import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { NotificationService } from './notification.service';
import { PreferenceService } from './preference.service';
import {
  ListNotificationsQuery,
  UpdatePreferencesDto,
} from './dto/notification.dto';
import { configurableEvents } from './events/notification-events';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly preferences: PreferenceService,
  ) {}

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  /**
   * The signed-in user's inbox.
   *
   * Always scoped to the caller from their token — there is no `userId` parameter,
   * because an endpoint that accepts one is an endpoint someone will eventually
   * call with a different one.
   */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsQuery,
  ) {
    return this.notifications.listForUser(user.id, {
      unreadOnly: query.unreadOnly,
      take: query.take,
      cursor: query.cursor,
    });
  }

  /** Badge count. Called on every page load, so it is a single indexed count. */
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.notifications.countUnread(user.id) };
  }

  // ---------------------------------------------------------------------------
  // Preferences
  //
  // Declared before `:id/read` so `preferences` is not captured as an id — Nest
  // matches routes in declaration order.
  // ---------------------------------------------------------------------------

  @Get('preferences')
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.getForUser(user.id);
  }

  @Patch('preferences')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.preferences.update(user.id, dto);
  }

  /**
   * Events a user may configure.
   *
   * Mandatory events are excluded: offering a toggle that does nothing is worse
   * than offering none, because the user believes they have opted out.
   */
  @Get('events')
  events() {
    return configurableEvents().map((event) => ({
      key: event.key,
      description: event.description,
      channels: event.channels,
      urgency: event.urgency,
    }));
  }

  /**
   * Starts linking a Telegram account.
   *
   * A bot cannot message a chat that has not messaged it first, so the user has to
   * open the conversation. The returned token is single-use and short-lived — it
   * binds whichever Telegram account presents it to this user, which makes it a
   * bearer credential.
   */
  @Post('telegram/link')
  @HttpCode(HttpStatus.OK)
  linkTelegram(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.createTelegramLinkToken(user.id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.notifications.markAllRead(user.id) };
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markRead(id, user.id);
  }
}

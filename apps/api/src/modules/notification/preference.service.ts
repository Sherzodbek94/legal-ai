import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { NotificationChannel } from '@legaltech/database';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { normalizeUzbekPhone } from './providers/devsms.service';
import type { UpdatePreferencesDto } from './dto/notification.dto';

@Injectable()
export class PreferenceService {
  private readonly logger = new Logger(PreferenceService.name);

  /** Long enough to walk to Telegram and send a message, short enough to be safe. */
  private static readonly LINK_TTL_SECONDS = 15 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The user's settings, with defaults filled in.
   *
   * A user who has never opened the settings screen has no row, and that must read
   * as "the defaults" rather than "everything off" — otherwise the feature is
   * silently disabled for every account until someone visits a page they have no
   * reason to visit.
   */
  async getForUser(userId: string) {
    const [preference, user] = await Promise.all([
      this.prisma.client.notificationPreference.findUnique({ where: { userId } }),
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { email: true },
      }),
    ]);

    return {
      enabledChannels: preference?.enabledChannels ?? [
        NotificationChannel.IN_APP,
        NotificationChannel.EMAIL,
      ],
      email: preference?.email ?? user?.email ?? null,
      phone: preference?.phone ?? null,
      telegramLinked: Boolean(preference?.telegramChatId),
      quietHoursStart: preference?.quietHoursStart ?? null,
      quietHoursEnd: preference?.quietHoursEnd ?? null,
      timezone: preference?.timezone ?? 'Asia/Tashkent',
    };
  }

  async update(userId: string, dto: UpdatePreferencesDto) {
    const phone = dto.phone === undefined ? undefined : normalizePhoneOrThrow(dto.phone);

    // Both or neither. A window with only one end is not a window, and storing
    // half of one would silently disable the rule while the UI shows it as set.
    const hasStart = dto.quietHoursStart !== undefined && dto.quietHoursStart !== null;
    const hasEnd = dto.quietHoursEnd !== undefined && dto.quietHoursEnd !== null;
    if (hasStart !== hasEnd && (hasStart || hasEnd)) {
      throw new BadRequestException(
        'Quiet hours need both a start and an end, or neither',
      );
    }

    if (dto.timezone && !isValidTimezone(dto.timezone)) {
      throw new BadRequestException(`"${dto.timezone}" is not a known IANA timezone`);
    }

    const data = {
      // IN_APP is filtered out: it is the user's own inbox and is not opt-out, so
      // storing it as a preference would imply otherwise.
      ...(dto.enabledChannels
        ? {
            enabledChannels: dto.enabledChannels.filter(
              (channel) => channel !== NotificationChannel.IN_APP,
            ),
          }
        : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(dto.quietHoursStart !== undefined
        ? { quietHoursStart: dto.quietHoursStart }
        : {}),
      ...(dto.quietHoursEnd !== undefined ? { quietHoursEnd: dto.quietHoursEnd } : {}),
      ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
    };

    await this.prisma.client.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        enabledChannels: data.enabledChannels ?? [NotificationChannel.EMAIL],
        ...data,
      },
      update: data,
    });

    return this.getForUser(userId);
  }

  /**
   * Issues a one-time token for linking Telegram.
   *
   * Held in Redis rather than the database: it is short-lived, single-use, and its
   * whole purpose is to expire. Storing it in Postgres would mean a cleanup job for
   * rows that Redis discards for free.
   *
   * The token is a bearer credential — whoever presents it to the bot gets bound to
   * this account — so it is 32 bytes of CSPRNG output, not a guessable code.
   */
  async createTelegramLinkToken(userId: string) {
    const token = randomBytes(24).toString('base64url');

    await this.redis.client.set(
      `telegram:link:${token}`,
      userId,
      'EX',
      PreferenceService.LINK_TTL_SECONDS,
    );

    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME', '');

    return {
      token,
      expiresInSeconds: PreferenceService.LINK_TTL_SECONDS,
      // Telegram's deep link passes the token as the /start payload, so the bot
      // receives it without the user having to type anything.
      deepLink: botUsername
        ? `https://t.me/${botUsername}?start=${token}`
        : null,
      instructions: botUsername
        ? `Open the link and press Start. The code expires in ${PreferenceService.LINK_TTL_SECONDS / 60} minutes.`
        : 'TELEGRAM_BOT_USERNAME is not configured; ask an administrator to finish Telegram setup.',
    };
  }

  /**
   * Completes the link, called by the bot's webhook handler.
   *
   * The token is deleted before the write, and `GETDEL` makes read-and-delete
   * atomic — two bots processing the same `/start` payload cannot both consume it.
   */
  async completeTelegramLink(token: string, chatId: string): Promise<boolean> {
    const userId = await this.redis.client.getdel(`telegram:link:${token}`);
    if (!userId) return false;

    await this.prisma.client.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.TELEGRAM],
        telegramChatId: chatId,
      },
      update: {
        telegramChatId: chatId,
        // Linking is an opt-in gesture; enabling the channel is the point of it.
        enabledChannels: { push: NotificationChannel.TELEGRAM },
      },
    });

    this.logger.log(`Linked Telegram chat to user ${userId}`);
    return true;
  }

  async unlinkTelegram(userId: string): Promise<void> {
    await this.prisma.client.notificationPreference.updateMany({
      where: { userId },
      data: { telegramChatId: null },
    });
  }
}

function normalizePhoneOrThrow(phone: string | null): string | null {
  if (phone === null || phone === '') return null;

  const normalized = normalizeUzbekPhone(phone);
  if (!normalized) {
    // Rejected at save time rather than at send time: a bad number stored now is a
    // notification silently lost weeks later.
    throw new BadRequestException(
      'Enter a valid Uzbekistan mobile number, e.g. +998 90 123 45 67',
    );
  }
  return `+${normalized}`;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

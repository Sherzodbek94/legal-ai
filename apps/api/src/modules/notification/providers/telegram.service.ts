import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  DeliveryError,
  classifyHttpStatus,
} from './delivery-error';

interface TelegramResponse {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * Telegram Bot API dispatcher.
 *
 * Telegram cannot initiate a conversation — a bot may only message a chat that
 * has messaged it first. So `telegramChatId` is populated when the user starts the
 * bot, and its absence is a normal state rather than a misconfiguration; the
 * router treats it as NO_DESTINATION and skips the channel.
 *
 * Two of its failure modes are permanent and look transient if you only read the
 * HTTP status: 403 with "bot was blocked by the user", and 400 with "chat not
 * found". Both mean the chat id will never work again, and retrying costs five
 * attempts to learn nothing.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get token(): string {
    return this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
  }

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  async send(
    chatId: string,
    title: string,
    body: string,
  ): Promise<{ providerMessageId?: string }> {
    if (!this.isConfigured()) {
      throw new DeliveryError(
        'TELEGRAM_BOT_TOKEN is not configured',
        'misconfigured',
      );
    }

    try {
      const response = await firstValueFrom(
        this.http.post<TelegramResponse>(
          `https://api.telegram.org/bot${this.token}/sendMessage`,
          {
            chat_id: chatId,
            text: formatMessage(title, body),
            parse_mode: 'HTML',
            // Legal notifications carry deep links; a preview card of the app's
            // login page adds nothing and looks like spam.
            link_preview_options: { is_disabled: true },
          },
          { timeout: 15_000 },
        ),
      );

      if (!response.data.ok) {
        throw new DeliveryError(
          `Telegram rejected the message: ${response.data.description ?? 'unknown reason'}`,
          classifyTelegramError(response.data.error_code, response.data.description),
          response.data.error_code,
          response.data.parameters?.retry_after
            ? response.data.parameters.retry_after * 1000
            : undefined,
        );
      }

      return {
        providerMessageId: response.data.result?.message_id
          ? String(response.data.result.message_id)
          : undefined,
      };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;

      const axiosError = error as AxiosError<TelegramResponse>;
      const status = axiosError.response?.status;
      const description = axiosError.response?.data?.description;

      throw new DeliveryError(
        `Telegram request failed${status ? ` (HTTP ${status})` : ''}: ${
          description ?? axiosError.message ?? 'unknown error'
        }`,
        classifyTelegramError(status, description),
        status,
        // Telegram supplies its own backoff on 429; honouring it beats guessing.
        axiosError.response?.data?.parameters?.retry_after
          ? axiosError.response.data.parameters.retry_after * 1000
          : undefined,
      );
    }
  }

  /**
   * Confirms the bot token works, at boot.
   *
   * A wrong token otherwise surfaces as every Telegram notification failing
   * individually, hours later, in a queue nobody is watching.
   */
  async verifyToken(): Promise<{ ok: boolean; username?: string }> {
    if (!this.isConfigured()) return { ok: false };

    try {
      const response = await firstValueFrom(
        this.http.get<{ ok: boolean; result?: { username?: string } }>(
          `https://api.telegram.org/bot${this.token}/getMe`,
          { timeout: 10_000 },
        ),
      );
      return {
        ok: response.data.ok,
        username: response.data.result?.username,
      };
    } catch {
      return { ok: false };
    }
  }
}

/**
 * Classifies a Bot API error.
 *
 * The description string carries information the status code does not: a 403 from
 * a blocked bot is permanent, while a 403 from a transient authorisation glitch is
 * not, and only the text distinguishes them.
 */
export function classifyTelegramError(
  code: number | undefined,
  description: string | undefined,
): 'transient' | 'permanent' | 'misconfigured' {
  const text = (description ?? '').toLowerCase();

  // The chat id is dead. No number of retries revives it.
  if (
    text.includes('bot was blocked') ||
    text.includes('user is deactivated') ||
    text.includes('chat not found') ||
    text.includes('bot was kicked')
  ) {
    return 'permanent';
  }

  // A bad token is our problem, not the recipient's.
  if (text.includes('unauthorized') || code === 401) return 'misconfigured';

  if (code === 429) return 'transient';

  return classifyHttpStatus(code);
}

/**
 * Formats a notification for Telegram.
 *
 * HTML rather than Markdown: Telegram's MarkdownV2 requires escaping a long list
 * of characters, and legal text is full of them — parentheses, hyphens, periods,
 * and `#` all appear in ordinary clause references. HTML needs three escapes and
 * is far harder to break.
 */
export function formatMessage(title: string, body: string): string {
  return `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

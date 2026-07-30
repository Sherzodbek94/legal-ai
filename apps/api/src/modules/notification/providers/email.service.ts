import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import nodemailer, { type Transporter } from 'nodemailer';
import {
  DeliveryError,
  classifyHttpStatus,
  parseRetryAfter,
} from './delivery-error';

export type EmailTransport = 'resend' | 'smtp' | 'none';

/**
 * Email delivery over either Resend or SMTP.
 *
 * Both are supported because they suit different deployments: Resend is the better
 * default (no connection pool to manage, deliverability handled), while SMTP is
 * what a self-hosted or on-premise installation has — and for a legal product sold
 * in a jurisdiction with data-residency expectations, "send it through our own
 * mail server" is a requirement rather than a preference.
 *
 * The transport is chosen from configuration, and the two paths share nothing but
 * this interface, so a failure in one cannot affect the other.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private transporter?: Transporter;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  /**
   * Resend wins when both are configured.
   *
   * Deliberate: an operator who has set a Resend key has opted into the managed
   * path, and silently preferring leftover SMTP settings from an earlier
   * deployment would send mail from an address they no longer monitor.
   */
  get transport(): EmailTransport {
    if (this.config.get<string>('RESEND_API_KEY')) return 'resend';
    if (this.config.get<string>('SMTP_HOST')) return 'smtp';
    return 'none';
  }

  isConfigured(): boolean {
    return this.transport !== 'none';
  }

  private get from(): string {
    return this.config.get<string>(
      'EMAIL_FROM',
      'LegalTech <no-reply@localhost>',
    );
  }

  async send(
    to: string,
    subject: string,
    body: string,
  ): Promise<{ providerMessageId?: string }> {
    switch (this.transport) {
      case 'resend':
        return this.sendViaResend(to, subject, body);
      case 'smtp':
        return this.sendViaSmtp(to, subject, body);
      default:
        throw new DeliveryError(
          'No email transport configured; set RESEND_API_KEY or SMTP_HOST',
          'misconfigured',
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Resend
  // ---------------------------------------------------------------------------

  /**
   * Called over Resend's REST API rather than through their SDK.
   *
   * One less dependency, and it keeps the retry classification in our hands — the
   * SDK retries internally on its own schedule, which would fight with BullMQ's
   * backoff and make the real number of attempts per notification unpredictable.
   */
  private async sendViaResend(
    to: string,
    subject: string,
    body: string,
  ): Promise<{ providerMessageId?: string }> {
    try {
      const response = await firstValueFrom(
        this.http.post<{ id?: string }>(
          'https://api.resend.com/emails',
          {
            from: this.from,
            to: [to],
            subject,
            text: body,
            html: toHtml(subject, body),
          },
          {
            headers: {
              Authorization: `Bearer ${this.config.getOrThrow<string>('RESEND_API_KEY')}`,
              'Content-Type': 'application/json',
            },
            timeout: 15_000,
          },
        ),
      );

      return { providerMessageId: response.data?.id };
    } catch (error) {
      const axiosError = error as AxiosError<{ message?: string }>;
      const status = axiosError.response?.status;

      throw new DeliveryError(
        `Resend request failed${status ? ` (HTTP ${status})` : ''}: ${
          axiosError.response?.data?.message ?? axiosError.message ?? 'unknown error'
        }`,
        classifyHttpStatus(status),
        status,
        parseRetryAfter(
          axiosError.response?.headers?.['retry-after'] as string | undefined,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // SMTP
  // ---------------------------------------------------------------------------

  /**
   * The transporter is created once and reused.
   *
   * nodemailer pools connections, and establishing a TLS session per email is both
   * slow and the fastest way to get an IP rate-limited by a mail provider.
   */
  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const port = this.config.get<number>('SMTP_PORT', 587);

    this.transporter = nodemailer.createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port,
      // Implicit TLS on 465; STARTTLS everywhere else. Getting this backwards
      // fails with a timeout rather than a clear error, which is why it is derived
      // from the port instead of being a separate setting to get wrong.
      secure: port === 465,
      auth: this.config.get<string>('SMTP_USER')
        ? {
            user: this.config.getOrThrow<string>('SMTP_USER'),
            pass: this.config.getOrThrow<string>('SMTP_PASSWORD'),
          }
        : undefined,
      pool: true,
      maxConnections: this.config.get<number>('SMTP_MAX_CONNECTIONS', 5),
      connectionTimeout: 15_000,
    });

    return this.transporter;
  }

  private async sendViaSmtp(
    to: string,
    subject: string,
    body: string,
  ): Promise<{ providerMessageId?: string }> {
    try {
      const info = await this.getTransporter().sendMail({
        from: this.from,
        to,
        subject,
        text: body,
        html: toHtml(subject, body),
      });

      return { providerMessageId: info.messageId };
    } catch (error) {
      throw new DeliveryError(
        `SMTP send failed: ${(error as Error)?.message ?? 'unknown error'}`,
        classifySmtpError(error),
        (error as { responseCode?: number })?.responseCode,
      );
    }
  }

  /** Verifies the transport at boot, so a bad configuration surfaces early. */
  async verify(): Promise<{ ok: boolean; transport: EmailTransport }> {
    if (this.transport === 'none') return { ok: false, transport: 'none' };
    if (this.transport === 'resend') {
      // No cheap health endpoint; the key is validated on first send.
      return { ok: true, transport: 'resend' };
    }

    try {
      await this.getTransporter().verify();
      return { ok: true, transport: 'smtp' };
    } catch (error) {
      this.logger.error(
        `SMTP verification failed: ${(error as Error)?.message ?? 'unknown error'}`,
      );
      return { ok: false, transport: 'smtp' };
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter?.close();
  }
}

/**
 * Classifies an SMTP failure by its response code.
 *
 * SMTP is explicit about this in a way HTTP is not: 4xx is "try again later" by
 * definition and 5xx is a permanent rejection. A 550 (no such mailbox) retried
 * five times is five deliverability complaints against the sending domain.
 */
export function classifySmtpError(
  error: unknown,
): 'transient' | 'permanent' | 'misconfigured' {
  const code = (error as { responseCode?: number })?.responseCode;
  const message = ((error as Error)?.message ?? '').toLowerCase();

  if (message.includes('invalid login') || message.includes('authentication')) {
    return 'misconfigured';
  }

  if (code === undefined) {
    // Connection-level: DNS, timeout, refused. Worth another attempt.
    return 'transient';
  }

  if (code >= 500) return 'permanent';
  if (code >= 400) return 'transient';
  return 'transient';
}

/**
 * Minimal HTML body.
 *
 * Inline styles only, and no external resources: every mail client strips
 * stylesheets, and a remote image makes the message look like tracking to spam
 * filters. Text content is escaped — notification bodies carry document titles and
 * party names that users control.
 */
export function toHtml(subject: string, body: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const paragraphs = body
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 12px;line-height:1.5">${escape(paragraph).replace(/\n/g, '<br />')}</p>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#111">
<h1 style="margin:0 0 16px;font-size:18px">${escape(subject)}</h1>
${paragraphs}
<hr style="margin:24px 0;border:none;border-top:1px solid #ddd" />
<p style="margin:0;font-size:12px;color:#666">
  This is an automated notification. Manage your preferences in the application.
</p>
</body></html>`;
}

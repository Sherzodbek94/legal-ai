import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { TooManyRequestsException } from '../../../common/exceptions/too-many-requests.exception';
import { RedisService } from '../../../redis/redis.service';

export interface OtpChallenge {
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Seconds the caller must wait before requesting another code. */
  resendAfter: number;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  private get codeLength(): number {
    return this.config.get<number>('OTP_CODE_LENGTH', 6);
  }

  private get ttlSeconds(): number {
    return this.config.get<number>('OTP_TTL_SECONDS', 300);
  }

  private get resendCooldownSeconds(): number {
    return this.config.get<number>('OTP_RESEND_COOLDOWN_SECONDS', 60);
  }

  private get maxAttempts(): number {
    return this.config.get<number>('OTP_MAX_ATTEMPTS', 5);
  }

  private get maxSendsPerHour(): number {
    return this.config.get<number>('OTP_MAX_SENDS_PER_HOUR', 5);
  }

  /**
   * Phone numbers are keyed by digest rather than in the clear: Redis keys show
   * up in logs, `MONITOR`, and crash dumps, and a phone number is personal data.
   */
  private keyFor(prefix: string, phone: string): string {
    const digest = createHash('sha256')
      .update(this.normalizePhone(phone))
      .digest('hex');
    return `otp:${prefix}:${digest}`;
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/[^\d+]/g, '');
  }

  private hashCode(code: string, phone: string): string {
    // Bind the digest to the phone number so a code captured for one number
    // cannot be replayed against another.
    return createHash('sha256')
      .update(`${this.normalizePhone(phone)}:${code}`)
      .digest('hex');
  }

  /** Cryptographically uniform code — `Math.random()` is not acceptable here. */
  private generateCode(): string {
    const max = 10 ** this.codeLength;
    return randomInt(0, max).toString().padStart(this.codeLength, '0');
  }

  async requestOtp(phone: string): Promise<OtpChallenge> {
    const cooldownKey = this.keyFor('cooldown', phone);
    const quotaKey = this.keyFor('quota', phone);
    const codeKey = this.keyFor('code', phone);

    if (await this.redis.client.exists(cooldownKey)) {
      const ttl = await this.redis.client.ttl(cooldownKey);
      throw new TooManyRequestsException(
        `Please wait ${Math.max(ttl, 1)}s before requesting another code`,
      );
    }

    // Hourly send quota, so an attacker cannot use us to bill SMS against a
    // victim's number ("SMS pumping").
    const sends = await this.redis.client.incr(quotaKey);
    if (sends === 1) {
      await this.redis.client.expire(quotaKey, 3600);
    }
    if (sends > this.maxSendsPerHour) {
      throw new TooManyRequestsException('Too many codes requested. Try again later.');
    }

    const code = this.generateCode();

    await this.redis.client
      .multi()
      .hset(codeKey, {
        hash: this.hashCode(code, phone),
        attempts: '0',
      })
      .expire(codeKey, this.ttlSeconds)
      .set(cooldownKey, '1', 'EX', this.resendCooldownSeconds)
      .exec();

    await this.deliver(phone, code);

    return {
      expiresIn: this.ttlSeconds,
      resendAfter: this.resendCooldownSeconds,
    };
  }

  /**
   * Verifies a code and consumes the challenge on success.
   *
   * Returns a boolean rather than throwing on mismatch so the caller controls
   * the response, but always burns an attempt first.
   */
  async verifyOtp(phone: string, code: string): Promise<boolean> {
    const codeKey = this.keyFor('code', phone);
    const stored = await this.redis.client.hgetall(codeKey);

    if (!stored?.hash) {
      throw new BadRequestException('No active code for this number');
    }

    const attempts = await this.redis.client.hincrby(codeKey, 'attempts', 1);
    if (attempts > this.maxAttempts) {
      // Burn the challenge outright — otherwise the attempt counter just
      // resets the attacker's budget on the next request.
      await this.redis.client.del(codeKey);
      throw new TooManyRequestsException('Too many incorrect attempts');
    }

    const expected = Buffer.from(stored.hash, 'utf8');
    const actual = Buffer.from(this.hashCode(code, phone), 'utf8');

    // Equal-length digests, so timingSafeEqual is safe to call directly.
    const matches =
      expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!matches) {
      return false;
    }

    await this.redis.client.del(codeKey);
    return true;
  }

  /**
   * Hands the code to the SMS provider.
   *
   * NOT IMPLEMENTED — no gateway is wired up yet. In non-production the code is
   * logged so the flow is testable; in production this throws rather than
   * silently reporting success for a message that was never sent.
   */
  private async deliver(phone: string, code: string): Promise<void> {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error(
        'No SMS provider configured: refusing to issue an OTP that cannot be delivered',
      );
    }

    this.logger.debug(
      `[dev] OTP for ${this.normalizePhone(phone).slice(-4).padStart(8, '*')}: ${code}`,
    );
  }
}

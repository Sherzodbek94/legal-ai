import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisService } from '../../../redis/redis.service';

/**
 * Redis reachability.
 *
 * Redis is not optional for this service: OTP challenges, the OneID CSRF state,
 * the Socket.IO adapter, and every BullMQ queue depend on it. A pod that cannot
 * reach Redis can still serve reads, but it cannot log anyone in — so it belongs
 * out of the load balancer rather than half-working.
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async check(key = 'redis', timeoutMs = 2000) {
    const check = this.indicator.check(key);
    const startedAt = Date.now();

    try {
      // PING rather than a read/write round trip: it exercises the connection
      // without touching a key, so a health check can never be the thing that
      // evicts real data or trips a memory limit.
      const response = await Promise.race([
        this.redis.client.ping(),
        rejectAfter(timeoutMs, 'Redis check timed out'),
      ]);

      if (response !== 'PONG') {
        return check.down({
          responseTimeMs: Date.now() - startedAt,
          message: `Unexpected PING response: ${String(response)}`,
        });
      }

      return check.up({
        responseTimeMs: Date.now() - startedAt,
        // ioredis reports its own view of the connection. `ready` is the only
        // status that can serve commands; `connecting` and `reconnecting` will
        // queue them, which under load is indistinguishable from a hang.
        status_: this.redis.client.status,
      });
    } catch (error) {
      return check.down({
        responseTimeMs: Date.now() - startedAt,
        message: (error as Error)?.message ?? 'unknown error',
      });
    }
  }
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

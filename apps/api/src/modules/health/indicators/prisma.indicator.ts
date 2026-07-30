import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * PostgreSQL reachability.
 *
 * `SELECT 1` rather than a table read: it proves the connection is up and the
 * pool can hand one out, without depending on any schema object. A health check
 * that queries a real table starts failing during a migration that briefly locks
 * it, which would take every pod out of the load balancer mid-deploy.
 */
@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async check(key = 'postgres', timeoutMs = 3000) {
    const check = this.indicator.check(key);
    const startedAt = Date.now();

    try {
      // Raced against a timeout because a saturated pool does not reject — it
      // queues. Without this the readiness probe would hang until its own HTTP
      // timeout, which is a slower and less informative failure.
      await Promise.race([
        this.prisma.client.$queryRaw`SELECT 1`,
        rejectAfter(timeoutMs, 'PostgreSQL check timed out'),
      ]);

      return check.up({ responseTimeMs: Date.now() - startedAt });
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
    // Never hold the event loop open on account of a health check.
    timer.unref?.();
  });
}

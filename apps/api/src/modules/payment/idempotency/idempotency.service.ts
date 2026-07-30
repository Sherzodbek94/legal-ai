import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Replay cache for gateway callbacks.
 *
 * The unique index on `provider_transactions` already stops a retry from
 * charging twice. This layer solves the other half of the problem: gateways
 * compare the *body* of a retry against the body of the original and treat any
 * difference as a protocol error, so a replay has to return byte-identical
 * output — not merely avoid doing harm.
 *
 * It also covers the callbacks that never reach a transaction at all. A
 * rejected signature or an unknown order produces no row anywhere, and without
 * a cache each retry re-runs the same lookups and re-derives the same refusal.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  /**
   * Gateways stop retrying long before this. Keeping keys much longer would
   * mean an order legitimately re-paid weeks later — a new transaction with a
   * recycled id — silently replays a stale response.
   */
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  static hashRequest(payload: unknown): string {
    return createHash('sha256').update(canonicalJson(payload)).digest('hex');
  }

  /**
   * Runs `work` at most once per key.
   *
   * A second call with the same key returns the stored response without
   * touching `work`. A second call with the same key but *different* content is
   * rejected outright: that is not a retry, it is either a bug or an attempt to
   * ride a key that already passed verification.
   */
  async execute<T>(
    key: string,
    request: unknown,
    work: () => Promise<{ statusCode: number; body: T }>,
  ): Promise<{ statusCode: number; body: T; replayed: boolean }> {
    const requestHash = IdempotencyService.hashRequest(request);

    const existing = await this.prisma.client.idempotencyRecord.findUnique({
      where: { key },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        this.logger.warn(
          `Idempotency key ${key} reused with a different request body`,
        );
        throw new ConflictException(
          'Idempotency key reused with a different request',
        );
      }

      return {
        statusCode: existing.statusCode,
        body: existing.response as T,
        replayed: true,
      };
    }

    const result = await work();

    try {
      await this.prisma.client.idempotencyRecord.create({
        data: {
          key,
          requestHash,
          statusCode: result.statusCode,
          response: result.body as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + IdempotencyService.TTL_MS),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Two deliveries arrived together and both ran `work`. The protective
        // constraints inside `work` mean only one of them had an effect; return
        // whichever response was stored so both callers see the same thing.
        const winner = await this.prisma.client.idempotencyRecord.findUnique({
          where: { key },
        });
        if (winner) {
          return {
            statusCode: winner.statusCode,
            body: winner.response as T,
            replayed: true,
          };
        }
      }
      // A cache write failure must not fail a callback whose work succeeded —
      // the gateway would retry a payment that has already been captured.
      this.logger.error(
        `Failed to store idempotency record ${key}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
    }

    return { ...result, replayed: false };
  }

  /** Drops expired records; gateways have long stopped retrying by then. */
  async prune(now = new Date()): Promise<number> {
    const { count } = await this.prisma.client.idempotencyRecord.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return count;
  }
}

/** Stable serialisation so key order in the payload cannot change the hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);

  return `{${entries.join(',')}}`;
}

import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Tracks whether the process is shutting down.
 *
 * This exists to solve one specific problem in a rolling deploy: the moment a pod
 * receives SIGTERM it must stop being sent NEW traffic, while continuing to serve
 * the requests already in flight. Kubernetes has no direct signal for "drain" —
 * the only lever is the readiness probe.
 *
 * So on SIGTERM:
 *   * readiness starts failing immediately  → kubelet removes the pod from the
 *     Service endpoints, and no new requests are routed to it;
 *   * liveness keeps succeeding             → the kubelet does NOT restart it
 *     while it finishes draining.
 *
 * Getting that pair backwards is the classic mistake. If liveness also failed on
 * SIGTERM, Kubernetes would kill the pod mid-drain and every in-flight PDF export
 * would truncate — which is precisely the outcome the graceful shutdown was
 * added to prevent.
 */
@Injectable()
export class ShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name);

  private shuttingDown = false;
  private shutdownStartedAt?: Date;

  constructor(private readonly config: ConfigService) {}

  /**
   * How long to keep reporting unready before the process actually stops
   * accepting work.
   *
   * Must be shorter than the Deployment's `terminationGracePeriodSeconds` (90s)
   * and should roughly match the preStop sleep (15s), which covers the window
   * where kube-proxy on other nodes has not yet observed the endpoint removal.
   *
   * Defaults to zero outside production. Draining only means anything behind a
   * load balancer that has to notice the endpoint going away — locally there is
   * no such thing, and a 15-second pause on every Ctrl-C or hot reload is pure
   * friction. Same reason it is zero in tests: `app.close()` would otherwise
   * exceed Jest's hook timeout.
   */
  get drainSeconds(): number {
    const isProduction =
      this.config.get<string>('NODE_ENV', 'development') === 'production';

    return this.config.get<number>(
      'SHUTDOWN_DRAIN_SECONDS',
      isProduction ? 15 : 0,
    );
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Seconds since SIGTERM, for the readiness payload and for logs. */
  drainingFor(): number | null {
    if (!this.shutdownStartedAt) return null;
    return Math.floor((Date.now() - this.shutdownStartedAt.getTime()) / 1000);
  }

  /**
   * Called by Nest on SIGTERM/SIGINT, before module destruction.
   *
   * The flag is set first and awaited afterwards, so readiness has already begun
   * failing by the time any module's `onModuleDestroy` starts tearing down the
   * connections those requests depend on.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.shuttingDown) return;

    this.shuttingDown = true;
    this.shutdownStartedAt = new Date();

    this.logger.log(
      `Received ${signal ?? 'shutdown'}; reporting unready and draining for ${this.drainSeconds}s`,
    );

    // Held open deliberately. Without this pause Nest proceeds straight to
    // destroying modules — closing the Prisma pool and the Redis connection —
    // while requests routed just before the endpoint removal are still being
    // served, and those fail with connection errors rather than completing.
    await new Promise((resolve) =>
      setTimeout(resolve, this.drainSeconds * 1000),
    );

    this.logger.log('Drain window elapsed; continuing shutdown');
  }
}

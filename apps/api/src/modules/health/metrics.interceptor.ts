import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
import type { Request, Response } from 'express';
import { MetricsService, normalizeRoute } from './metrics.service';

/**
 * Records timing and status for every HTTP request.
 *
 * Registered globally. Instrumenting per controller guarantees that the one
 * endpoint nobody remembered to annotate is the one that turns out to be slow.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { route?: { path?: string } }>();
    const response = http.getResponse<Response>();

    // The scrape endpoint is excluded from its own metrics. Including it means
    // every scrape increments a counter, so request rate becomes a function of
    // how often you look at it.
    const rawPath = request.originalUrl ?? request.url ?? '/';
    if (rawPath.startsWith('/metrics')) return next.handle();

    const startedAt = process.hrtime.bigint();
    this.metrics.httpInFlight.inc();

    return next.handle().pipe(
      // `finalize` rather than `tap`: it runs on success, on error, AND on
      // unsubscribe — which is what happens when a client disconnects mid-
      // download. With `tap` those requests would increment the in-flight gauge
      // and never decrement it, and the gauge would climb until it looked like a
      // leak.
      finalize(() => {
        this.metrics.httpInFlight.dec();

        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

        // Read after the handler has run: `req.route` is only populated once
        // Express has matched a route.
        const route = normalizeRoute(request.route?.path, rawPath);
        const labels = {
          method: request.method,
          route,
          status: String(response.statusCode),
        };

        this.metrics.httpDuration.observe(labels, seconds);
        this.metrics.httpRequests.inc(labels);
      }),
    );
  }
}

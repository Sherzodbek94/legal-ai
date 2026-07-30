import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { UsageService } from './usage.service';
import {
  QUOTA_RESERVATION,
  type RequestWithReservation,
} from './plan-limit.guard';

/**
 * Returns quota that PlanLimitGuard reserved for work that then failed.
 *
 * Without this, an AI provider outage costs the customer real allowance: the
 * guard consumed a document from their monthly quota, the generation 503'd, and
 * they have nothing to show for it. Refunding on any thrown error means quota
 * tracks successful work, which is what customers believe they are buying.
 *
 * Registered globally in AppModule so it cannot be forgotten on a route that
 * consumes quota — a missing refund is invisible until a customer complains.
 */
@Injectable()
export class QuotaRefundInterceptor implements NestInterceptor {
  constructor(private readonly usage: UsageService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithReservation>();

    return next.handle().pipe(
      catchError((error) => {
        const reservation = request?.[QUOTA_RESERVATION];

        if (reservation) {
          // Fire and forget: the caller is already receiving an error, and a
          // failed refund must not replace it with a different one. Failures
          // are logged inside UsageService.release.
          void this.usage.release(reservation);
          delete request[QUOTA_RESERVATION];
        }

        return throwError(() => error);
      }),
    );
  }
}

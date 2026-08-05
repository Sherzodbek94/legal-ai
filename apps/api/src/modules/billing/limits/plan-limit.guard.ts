import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@legaltech/database';
import { UsageService, type QuotaReservation } from './usage.service';
import {
  FEATURE_KEY,
  QUOTA_KEY,
  type QuotaRequirement,
} from './plan-limit.decorator';
import { effectivePlan, hasFeature } from './quota-policy';
import { quotaRefusal } from './quota-refusal';
import type { PlanDefinition } from '../plans/plan-catalog';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

/** Where the guard stashes what it reserved, for the interceptor to release. */
export const QUOTA_RESERVATION = Symbol('billing:reservation');

export interface RequestWithReservation {
  user?: AuthenticatedUser;
  [QUOTA_RESERVATION]?: QuotaReservation;
}

/**
 * Blocks a request when the caller's plan does not cover it.
 *
 * Runs *after* JwtAuthGuard and RolesGuard (registration order in AppModule):
 * quota is a property of an identified tenant, so there is nothing to check
 * until authentication has produced one.
 *
 * The guard both checks and consumes. Checking alone would leave a gap between
 * the decision and the work — long enough, on a slow AI generation, for a
 * handful of parallel requests to each pass a check that only one of them
 * should have. Consuming up front closes that, and the paired interceptor
 * refunds when the handler fails.
 */
@Injectable()
export class PlanLimitGuard implements CanActivate {
  private readonly logger = new Logger(PlanLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly usage: UsageService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const quota = this.reflector.getAllAndOverride<QuotaRequirement | undefined>(
      QUOTA_KEY,
      [context.getHandler(), context.getClass()],
    );
    const feature = this.reflector.getAllAndOverride<
      keyof PlanDefinition['features'] | undefined
    >(FEATURE_KEY, [context.getHandler(), context.getClass()]);

    // Undecorated route: nothing to meter.
    if (!quota && !feature) return true;

    const request = context.switchToHttp().getRequest<RequestWithReservation>();
    const user = request.user;

    if (!user?.companyId) {
      // Defence in depth: a metered route must never be reachable without a
      // tenant, even if guard ordering changes.
      throw new ForbiddenException(
        'A company context is required for this operation',
      );
    }

    // Platform operators are not customers and have no plan to bill against.
    // Metering them would attribute internal work to a tenant's allowance.
    if (user.role === UserRole.SUPER_ADMIN) return true;

    if (feature) {
      await this.assertFeature(user.companyId, feature);
    }

    if (quota) {
      await this.reserveQuota(request, user.companyId, quota);
    }

    return true;
  }

  private async assertFeature(
    companyId: string,
    feature: keyof PlanDefinition['features'],
  ): Promise<void> {
    const subscription = await this.usage.getSubscription(companyId);
    const plan = effectivePlan(subscription);

    if (hasFeature(plan, feature)) return;

    throw new ForbiddenException({
      message: 'Your plan does not include this feature.',
      reason: 'FEATURE_NOT_IN_PLAN',
      feature,
      plan,
    });
  }

  private async reserveQuota(
    request: RequestWithReservation,
    companyId: string,
    quota: QuotaRequirement,
  ): Promise<void> {
    const decision = await this.usage.reserve(
      companyId,
      quota.metric,
      quota.amount,
    );

    if (!decision.allowed) {
      this.logger.log(
        `Blocked ${quota.metric} for company ${companyId}: ${decision.reason}`,
      );

      // Built by the shared helper so a service reserving quota on its own
      // refuses in exactly the same shape the client already handles.
      throw quotaRefusal(quota.metric, decision);
    }

    if (decision.reservation) {
      request[QUOTA_RESERVATION] = decision.reservation;
    }
  }
}

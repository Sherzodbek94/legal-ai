import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NO_IMPERSONATION_KEY } from './no-impersonation.decorator';
import type { DeniedCapability } from './impersonation-policy';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

/**
 * Refuses routes marked @NoImpersonation() when the caller is impersonating.
 *
 * Registered globally in AppModule. A guard that has to be remembered per
 * controller is a guard that will be missing from the one route where it
 * mattered.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  private readonly logger = new Logger(ImpersonationGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const capability = this.reflector.getAllAndOverride<
      DeniedCapability | undefined
    >(NO_IMPERSONATION_KEY, [context.getHandler(), context.getClass()]);

    if (!capability) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request?.user;

    if (!user?.impersonation) return true;

    // Logged at warn: an operator hitting this is either confused about what
    // impersonation is for, or probing. Both are worth seeing.
    this.logger.warn(
      `Blocked ${capability} during impersonation session ${user.impersonation.sessionId} ` +
        `(operator ${user.impersonation.impersonatorId} acting as ${user.id})`,
    );

    throw new ForbiddenException({
      message:
        'This action is not available while impersonating a user. End the session and act as yourself.',
      reason: 'BLOCKED_DURING_IMPERSONATION',
      capability,
    });
  }
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, type AllowedRole } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../interfaces/jwt-payload.interface';

/** Platform role that bypasses tenant-level role checks. */
const SUPER_ADMIN = 'SUPER_ADMIN';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      AllowedRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    // No @Roles metadata (or an empty list) means the route imposes no role
    // restriction of its own. Authentication is still enforced separately by
    // JwtAuthGuard.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request?.user;

    // Defense in depth: a role-restricted route must never be reachable
    // without an authenticated principal, even if guard ordering changes.
    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (user.role === SUPER_ADMIN) {
      return true;
    }

    // A user satisfies the requirement via either their tenant role or their
    // platform role, so @Roles can express both kinds of restriction.
    // Widened explicitly: control flow has already narrowed `user.role` to
    // exclude SUPER_ADMIN, which would otherwise narrow the array element type
    // and reject a SUPER_ADMIN comparison below.
    const candidates: Array<AllowedRole | undefined> = [
      user.companyRole,
      user.role,
    ];
    const heldRoles = candidates.filter((role): role is AllowedRole =>
      Boolean(role),
    );

    const permitted = requiredRoles.some((role) => heldRoles.includes(role));

    if (!permitted) {
      // Deliberately does not name the required roles — that would disclose
      // the authorization model to an unprivileged caller.
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}

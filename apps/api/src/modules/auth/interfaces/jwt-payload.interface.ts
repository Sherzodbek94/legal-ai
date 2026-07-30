import type { CompanyMemberRole, UserRole } from '@legaltech/database';

/** Claims carried by the short-lived access token. */
export interface JwtPayload {
  /** User id (RFC 7519 `sub`). */
  sub: string;
  email: string;
  /** Platform-wide role. */
  role: UserRole;
  /** Active tenant, when the session is scoped to one. */
  companyId?: string;
  /** Role within the active tenant. */
  companyRole?: CompanyMemberRole;
  /** Token id, so a single access token can be traced in audit logs. */
  jti?: string;

  // --- Impersonation ---------------------------------------------------------
  /**
   * Present only on an impersonation token.
   *
   * Named after the RFC 8693 `act` (actor) claim: `sub` stays the user being
   * acted *for*, so every authorisation check keeps working unchanged, while
   * `act` records who is actually driving. Overloading `sub` with the operator
   * instead would silently grant them the target's permissions with none of the
   * attribution.
   */
  act?: {
    /** The SUPER_ADMIN performing the impersonation. */
    sub: string;
    email: string;
  };
  /** Id of the ImpersonationSession row this token is bound to. */
  impersonationId?: string;
}

/** Shape attached to `request.user` once JwtStrategy has validated a request. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  companyId?: string;
  companyRole?: CompanyMemberRole;

  /**
   * Set when the request is being made through an impersonation session.
   *
   * Everything downstream should treat this as "a real user, plus a caveat":
   * permissions come from the impersonated user, but anything irreversible or
   * financial is refused — see ImpersonationGuard.
   */
  impersonation?: {
    sessionId: string;
    impersonatorId: string;
    impersonatorEmail: string;
  };
}

/** Whether a request is running under an impersonation session. */
export function isImpersonated(user: AuthenticatedUser | undefined): boolean {
  return Boolean(user?.impersonation);
}

/**
 * The identity that should be recorded against an action.
 *
 * Audit entries written during an impersonation must name the operator, not the
 * customer whose account they are sitting in — otherwise the trail shows a user
 * doing things they never did.
 */
export function actingUserId(user: AuthenticatedUser): string {
  return user.impersonation?.impersonatorId ?? user.id;
}

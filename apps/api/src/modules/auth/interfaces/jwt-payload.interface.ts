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
}

/** Shape attached to `request.user` once JwtStrategy has validated a request. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  companyId?: string;
  companyRole?: CompanyMemberRole;
}

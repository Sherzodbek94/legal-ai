import { SetMetadata } from '@nestjs/common';
import type { CompanyMemberRole, UserRole } from '@legaltech/database';

export const ROLES_KEY = 'roles';

/**
 * Roles permitted to reach the decorated handler or controller.
 *
 * Accepts tenant roles (`CompanyMemberRole`) and platform roles (`UserRole`).
 * `SUPER_ADMIN` always passes — see RolesGuard.
 */
export type AllowedRole = CompanyMemberRole | UserRole;

export const Roles = (...roles: AllowedRole[]) => SetMetadata(ROLES_KEY, roles);

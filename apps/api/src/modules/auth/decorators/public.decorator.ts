import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of JWT authentication.
 *
 * Authentication is deny-by-default (JwtAuthGuard is registered globally), so
 * every unauthenticated endpoint must declare itself explicitly.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Cookie names for the token pair. */
export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * The refresh cookie is scoped to the auth routes so it is not attached to
 * ordinary API calls — it only travels where it is actually redeemed.
 */
export const REFRESH_COOKIE_PATH = '/auth';

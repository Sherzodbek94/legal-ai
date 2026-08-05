import { NextResponse, type NextRequest } from 'next/server';

/**
 * Must match `ACCESS_TOKEN_COOKIE` in apps/api/src/modules/auth/constants.ts.
 * Not imported directly: that file pulls in NestJS decorators the Edge
 * runtime cannot bundle.
 */
const ACCESS_TOKEN_COOKIE = 'access_token';

/**
 * `/` is the public landing page, not the dashboard (that's `/dashboard`) —
 * matched exactly, not as a prefix, so this doesn't accidentally cover every
 * route.
 */
const PUBLIC_PATHS = ['/login', '/register', '/invitations'];

function isPublic(pathname: string): boolean {
  if (pathname === '/') return true;
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Redirects an anonymous request to `/login` before it reaches a page.
 *
 * This only checks for the cookie's *presence*, not whether the token inside
 * it still verifies — that requires calling the API, and the middleware
 * runs on the Edge runtime on every request, which is the wrong place to pay
 * for it. An expired-but-present cookie still reaches the page; `getSession()`
 * there calls `/auth/me`, gets nothing back, and the dashboard layout falls
 * through to the same redirect. This layer exists to skip the round trip for
 * the overwhelmingly common case — no cookie at all — not to replace that check.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  if (request.cookies.has(ACCESS_TOKEN_COOKIE)) {
    return NextResponse.next();
  }

  const url = new URL('/login', request.url);
  url.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own static assets, the favicon, and public files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)'],
};

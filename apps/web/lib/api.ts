import { cookies } from 'next/headers';
import { apiBaseUrl } from './api-config';

/**
 * Server-side API access for admin pages.
 *
 * Auth lives in an HTTPOnly cookie the browser holds, which a server component's
 * `fetch` does not send by itself — it has no browser context. The cookie header
 * is forwarded explicitly, so the API applies exactly the same authorisation it
 * would to a direct request and the page cannot see anything the signed-in user
 * could not.
 *
 * `next/headers` makes this module server-only. Client components must import
 * `apiBaseUrl` from `./api-config` instead — importing it from here drags
 * `next/headers` into the browser bundle and fails the build.
 */

const API_URL = apiBaseUrl;

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

/**
 * Fetches from the API as the current user.
 *
 * Returns a result rather than throwing. An admin dashboard is a page of
 * independent panels, and one failing endpoint should render as one broken panel
 * rather than an error screen where the other five would have been useful.
 */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: { cookie: cookies().toString() },
      // Never cached: these are live operational figures, and a stale MRR or a
      // stale lock state is worse than a slow one.
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: await readError(response),
      };
    }

    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    // The API being unreachable is an operational fact worth showing, not a
    // stack trace worth rendering.
    return {
      ok: false,
      status: 0,
      message:
        error instanceof Error ? error.message : 'Could not reach the API',
    };
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.join(', ');
  } catch {
    // Non-JSON error body; fall through to the status text.
  }
  return response.statusText || `Request failed with status ${response.status}`;
}


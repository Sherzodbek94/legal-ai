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

/** A field-level validation issue, as returned by the variable validator. */
export interface ApiIssue {
  key: string;
  message: string;
}

export type ApiWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; issues?: ApiIssue[] };

/**
 * Writes to the API as the current user, from a Server Action.
 *
 * Server-side rather than a browser `fetch` for the same reason the reads are:
 * the session cookie is HTTPOnly and SameSite-scoped, so posting from the
 * browser to a different origin would need CORS credentials and a relaxed
 * cookie policy — weakening the CSRF posture to save a hop.
 *
 * Carries `issues` through separately from `message`. A rejected generation
 * names the fields that failed, and collapsing that to one string means the
 * form can only say "something was wrong".
 */
export async function apiPost<T>(
  path: string,
  body: unknown,
): Promise<ApiWriteResult<T>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        cookie: cookies().toString(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    if (!response.ok) {
      const parsed = await readErrorBody(response);
      return {
        ok: false,
        status: response.status,
        message: parsed.message,
        issues: parsed.issues,
      };
    }

    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message:
        error instanceof Error ? error.message : 'Could not reach the API',
    };
  }
}

async function readError(response: Response): Promise<string> {
  return (await readErrorBody(response)).message;
}

async function readErrorBody(
  response: Response,
): Promise<{ message: string; issues?: ApiIssue[] }> {
  const fallback =
    response.statusText || `Request failed with status ${response.status}`;

  try {
    const body = (await response.json()) as Record<string, unknown>;

    /*
     * The payload is nested one level deeper than it looks.
     *
     * `AllExceptionsFilter` builds its response as
     * `{ statusCode, path, method, message: exception.getResponse() }` — and
     * `getResponse()` is already the full object a handler threw. So a
     * validation failure arrives as:
     *
     *   { statusCode: 422, message: { message: "Invalid variable values",
     *                                 issues: [{ key, message }] } }
     *
     * Reading `body.issues` finds nothing, and `body.message` is an object
     * rather than a string — which is why every field-level rejection used to
     * render as the bare status text "Unprocessable Entity", with the per-field
     * reasons the API had gone to the trouble of returning thrown away.
     *
     * Both shapes are accepted: ValidationPipe failures and anything thrown
     * with a plain string still arrive flat.
     */
    const inner =
      body.message !== null && typeof body.message === 'object'
        ? (body.message as Record<string, unknown>)
        : body;

    const raw = inner.message ?? body.message;
    const message =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.join(', ')
          : fallback;

    const rawIssues = inner.issues ?? body.issues;
    const issues = Array.isArray(rawIssues)
      ? (rawIssues.filter(
          (issue): issue is ApiIssue =>
            typeof issue === 'object' &&
            issue !== null &&
            typeof (issue as ApiIssue).key === 'string' &&
            typeof (issue as ApiIssue).message === 'string',
        ) as ApiIssue[])
      : undefined;

    return { message, issues };
  } catch {
    // Non-JSON error body; fall through to the status text.
    return { message: fallback };
  }
}


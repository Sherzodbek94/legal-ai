/**
 * Turns an API error response into a sentence a user can act on.
 *
 * The payload is nested one level deeper than it looks. `AllExceptionsFilter`
 * builds `{ statusCode, path, method, message: exception.getResponse() }`, and
 * `getResponse()` is already the full object the handler threw — so a
 * ValidationPipe rejection arrives as:
 *
 *   { statusCode: 400, message: { message: ["slug must be longer than…"],
 *                                 error: "Bad Request" } }
 *
 * Reading `body.message` alone yields an object, which renders as nothing
 * useful. Getting this wrong is why an invalid company slug showed up as a
 * silent no-op instead of naming the field.
 *
 * The server-side `apiGet`/`apiPost` helpers in `lib/api.ts` do the same
 * unwrapping; this is the client-fetch counterpart, for the forms that must
 * talk to the API's own origin to receive its cookies.
 */
export async function readApiError(
  response: Response,
  fallback: string,
): Promise<string> {
  const parsed = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object') return fallback;

  const body = parsed as Record<string, unknown>;
  const inner =
    body.message !== null && typeof body.message === 'object'
      ? (body.message as Record<string, unknown>)
      : body;

  const raw = inner.message ?? body.message;

  if (typeof raw === 'string') return raw;
  // ValidationPipe returns one string per failed constraint.
  if (Array.isArray(raw)) return raw.filter(Boolean).join(' ');

  return fallback;
}

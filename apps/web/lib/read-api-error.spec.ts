/**
 * Unwrapping an API error into something a user can act on.
 *
 * The payload is nested one level deeper than it looks: `AllExceptionsFilter`
 * puts the thrown response object inside `message`, so reading `body.message`
 * alone yields an object that renders as nothing. That is why an invalid
 * company slug once surfaced as a silent no-op instead of naming the field —
 * every case below is a shape that has to survive that.
 */
import { readApiError } from './read-api-error';

/** A `Response` stand-in: only `json()` is read. */
function response(body: unknown): Response {
  return {
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  } as unknown as Response;
}

const FALLBACK = 'Something went wrong';

describe('readApiError', () => {
  it('reads a nested ValidationPipe message array', () => {
    // The shape that matters most — this is what a rejected form actually
    // returns.
    const message = readApiError(
      response({
        statusCode: 400,
        path: '/api/companies',
        message: {
          message: ['slug must be longer than 3 characters', 'name should not be empty'],
          error: 'Bad Request',
        },
      }),
      FALLBACK,
    );

    return expect(message).resolves.toBe(
      'slug must be longer than 3 characters name should not be empty',
    );
  });

  it('reads a nested single-string message', async () => {
    expect(
      await readApiError(
        response({ statusCode: 409, message: { message: 'Slug already taken' } }),
        FALLBACK,
      ),
    ).toBe('Slug already taken');
  });

  it('reads a flat string message', async () => {
    // Not everything routes through the filter's nesting.
    expect(
      await readApiError(response({ statusCode: 401, message: 'Unauthorized' }), FALLBACK),
    ).toBe('Unauthorized');
  });

  it('drops empty entries from a message array', async () => {
    expect(
      await readApiError(response({ message: { message: ['first', '', null] } }), FALLBACK),
    ).toBe('first');
  });

  it('falls back when the body is not JSON', async () => {
    // A 502 from the ingress is HTML. Throwing here would replace a readable
    // error with a stack trace.
    expect(await readApiError(response(undefined), FALLBACK)).toBe(FALLBACK);
  });

  it.each([null, 'a bare string', 42])('falls back on a %p body', async (body) => {
    expect(await readApiError(response(body), FALLBACK)).toBe(FALLBACK);
  });

  it('falls back when no message field is present at all', async () => {
    expect(await readApiError(response({ statusCode: 500 }), FALLBACK)).toBe(FALLBACK);
  });

  it('falls back when the message is an unreadable shape', async () => {
    // An object where a string was expected must not render as
    // "[object Object]" in front of a user.
    expect(
      await readApiError(response({ message: { message: { nested: 'deeper' } } }), FALLBACK),
    ).toBe(FALLBACK);
  });
});

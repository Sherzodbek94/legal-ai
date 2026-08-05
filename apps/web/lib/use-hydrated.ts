'use client';

import { useEffect, useState } from 'react';

/**
 * True once React has taken over the server-rendered markup.
 *
 * Used to hold a submit button inert until then. A `<form>` whose only
 * handler is `onSubmit` still submits *natively* if the button is pressed
 * before hydration: the browser does a GET to the current URL, the page
 * reloads, and everything typed is silently lost. It shows up as a bare `?`
 * appended to the address and an empty form — which is exactly how the
 * onboarding step failed in the browser suite, and would fail the same way
 * for a real person on a slow connection who types quickly.
 *
 * Only worth it on forms that exist purely to call `fetch`. A form backed by
 * a server action degrades correctly without JavaScript and should not be
 * disabled.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

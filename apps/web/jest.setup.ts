import '@testing-library/jest-dom';

/**
 * jsdom implements neither of these, and both are reached by components under
 * test rather than by the tests themselves — a missing implementation would
 * surface as an unrelated TypeError deep inside a click handler.
 */

// Radix primitives measure and observe their triggers.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

/**
 * Full-page navigation cannot be observed under jsdom.
 *
 * Components sign the user in by assigning `window.location.href`, and jsdom
 * answers that with a "Not implemented: navigation" error logged from inside
 * the submit handler. There is no seam to intercept it: `window.location` is
 * non-configurable so the object cannot be swapped, and `Location` is an
 * exotic object whose own `[[DefineOwnProperty]]` and `[[Delete]]` both refuse
 * — so `href` cannot be shadowed, spied on, or restored either.
 *
 * The consequence for tests: everything up to the redirect is assertable, the
 * destination is not. `silenceNavigation()` below keeps the log readable; a
 * test that needs to assert *where* a sign-in lands belongs in the Playwright
 * suite, which drives a real browser.
 */
export function silenceNavigation(): void {
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('Not implemented: navigation')) return;
    // Anything else is a real error and must still be visible.
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  });
}

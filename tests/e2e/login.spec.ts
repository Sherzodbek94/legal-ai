/**
 * The login form, in a real browser.
 *
 * Every other spec in this suite signs in by copying a cookie directly (see
 * fixtures.ts) precisely because there was no form to drive. This is the one
 * spec that exercises the form itself: the fetch-and-redirect flow, the error
 * states, and the middleware that sends an anonymous visitor here in the
 * first place.
 */
import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './fixtures';

// `exact: true` throughout: Playwright matches an accessible name by substring
// by default, and the form now sits above a "Sign in with SMS code" button, so
// a bare 'Sign in' resolves to two elements and fails strict mode.

test.describe('login', () => {
  test('redirects an anonymous visitor to the login page', async ({ page }) => {
    await page.goto('/documents');
    await expect(page).toHaveURL(/\/login\?next=%2Fdocuments/);
  });

  test('signs in with valid credentials and lands on the dashboard', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill(ACCOUNTS.owner.email);
    await page.getByLabel('Password').fill(ACCOUNTS.owner.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('returns to the originally requested page after signing in', async ({ page }) => {
    await page.goto('/documents');
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel('Email').fill(ACCOUNTS.owner.email);
    await page.getByLabel('Password').fill(ACCOUNTS.owner.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(/\/documents/);
  });

  test('shows an error for the wrong password without redirecting', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill(ACCOUNTS.owner.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Scoped to the form. A bare `getByRole('alert')` also matches Next.js's
    // own `__next-route-announcer__`, which is an empty live region on every
    // page — strict mode then fails on two matches rather than on the message.
    await expect(
      page.getByRole('alert').filter({ hasText: /password/i }),
    ).toHaveText(/incorrect email or password/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test('sends an already-authenticated visitor straight through', async ({ page, context }) => {
    // Signs in once via the form, then proves a second visit to /login does
    // not show it again.
    await page.goto('/login');
    await page.getByLabel('Email').fill(ACCOUNTS.owner.email);
    await page.getByLabel('Password').fill(ACCOUNTS.owner.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/dashboard');

    await page.goto('/login');
    await expect(page).toHaveURL('/dashboard');

    await context.close();
  });
});

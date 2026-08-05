/**
 * Registration and company onboarding, in a real browser.
 *
 * Until this flow existed, no user — registered by password or by OneID —
 * could ever become the owner of a company through the running API:
 * `POST /companies` required a role only an existing member could hold, and
 * `CompanyService.create()` never wrote the membership row even for a caller
 * who had one. This exercises the actual path end to end: create an account,
 * land on onboarding because the session has no company yet, submit the
 * company form, and land on a working dashboard.
 */
import { test, expect } from '@playwright/test';

test.describe('registration', () => {
  test('creates an account, onboards a company, and reaches the dashboard', async ({
    page,
  }) => {
    const unique = Date.now();
    const email = `new-owner-${unique}@example.uz`;

    await page.goto('/register');
    await page.getByLabel('Your name').fill('Dilnoza Yusupova');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-strong-password-123');
    await page.getByRole('button', { name: 'Create account' }).click();

    // No company yet — must land on onboarding, not the dashboard.
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(
      page.getByRole('heading', { name: 'Set up your company' }),
    ).toBeVisible();

    await page.getByLabel('Company name').fill(`New Firm ${unique}`);
    // The slug field auto-fills from the name; left as-is.
    await page.getByRole('button', { name: 'Create workspace' }).click();

    await expect(page).toHaveURL('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('refuses to register the same email twice', async ({ page }) => {
    const unique = Date.now();
    const email = `dup-${unique}@example.uz`;

    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-strong-password-123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/onboarding/);

    // Signs the fresh account out, then tries to register the same email again.
    await page.context().clearCookies();
    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-different-password-456');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Scoped: a bare getByRole('alert') also matches Next.js's own empty
    // '__next-route-announcer__' live region, and strict mode then fails on
    // two matches rather than on the message.
    await expect(
      page.getByRole('alert').filter({ hasText: /already exists/i }),
    ).toHaveText(/already exists/i);
    await expect(page).toHaveURL(/\/register/);
  });

  test('a second onboarding attempt is refused once a company already exists', async ({
    page,
  }) => {
    const unique = Date.now();
    const email = `owner-twice-${unique}@example.uz`;

    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-strong-password-123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/onboarding/);

    await page.getByLabel('Company name').fill(`Owned Once ${unique}`);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL('/dashboard');

    // Visiting /onboarding again with a company already in the session must
    // not offer the form a second time — the API refuses a second company
    // for one account, and the page itself should not even get there.
    await page.goto('/onboarding');
    await expect(page).toHaveURL('/dashboard');
  });
});

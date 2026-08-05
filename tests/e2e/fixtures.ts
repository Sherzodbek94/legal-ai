/**
 * Shared fixtures for the browser suite.
 *
 * Sign-in happens through the API rather than by driving a login form, because
 * the product has no login page yet — the dashboard exists, the auth screens do
 * not. Setting the cookie directly is honest about that: it tests everything
 * *behind* the login wall without pretending a form is there.
 *
 * When the login UI lands, `signIn` becomes a form interaction and every test
 * below keeps working unchanged.
 */
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';

/** Accounts created by `npm run db:seed`. */
export const ACCOUNTS = {
  owner: { email: 'owner@acme-legal.uz', password: 'DemoPassw0rd!' },
  attorney: { email: 'attorney@acme-legal.uz', password: 'DemoPassw0rd!' },
  admin: { email: 'admin@legaltech.uz', password: 'DemoPassw0rd!' },
} as const;

export type AccountName = keyof typeof ACCOUNTS;

interface Fixtures {
  /** A page already authenticated as the seeded company owner. */
  ownerPage: Page;
  /** A page authenticated as the platform administrator. */
  adminPage: Page;
  /** Signs a page in as any seeded account. */
  signIn: (page: Page, account: AccountName) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  signIn: async ({ playwright }, use) => {
    await use(async (page, account) => {
      const { email, password } = ACCOUNTS[account];

      const context: APIRequestContext = await playwright.request.newContext({
        baseURL: API_URL,
      });

      const response = await context.post('/api/auth/login', {
        data: { email, password },
      });

      if (!response.ok()) {
        throw new Error(
          `Could not sign in as ${email} (${response.status()}). ` +
            'Has the database been seeded? Run: npm run db:seed',
        );
      }

      // The API sets HTTPOnly cookies on its own origin. They are copied onto the
      // browser context so the web app's server components — which forward the
      // cookie header — can authenticate.
      const state = await context.storageState();
      await page.context().addCookies(
        state.cookies.map((cookie) => ({
          ...cookie,
          // The seeded cookies are scoped to the API host; the browser needs them
          // for the web host too, since server components forward them onward.
          domain: 'localhost',
        })),
      );

      await context.dispose();
    });
  },

  ownerPage: async ({ page, signIn }, use) => {
    await signIn(page, 'owner');
    await use(page);
  },

  adminPage: async ({ page, signIn }, use) => {
    await signIn(page, 'admin');
    await use(page);
  },
});

export { expect };

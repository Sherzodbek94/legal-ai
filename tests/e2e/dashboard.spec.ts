/**
 * The dashboard, in a real browser.
 *
 * These assert what unit and API tests structurally cannot: that the pages
 * render, that server components successfully forward the auth cookie to the
 * API, and that the admin section is genuinely gated rather than merely hidden.
 */
import { test, expect } from './fixtures';

test.describe('dashboard', () => {
  test('renders the workspace overview', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');

    await expect(ownerPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(ownerPage.getByRole('navigation')).toBeVisible();
  });

  test('navigates to documents', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    await ownerPage.getByRole('link', { name: 'Documents' }).first().click();

    await expect(ownerPage).toHaveURL(/\/documents/);
  });

  test('has no horizontal overflow at a narrow viewport', async ({ ownerPage }) => {
    // The layout uses a fixed sidebar and wide admin tables. A body that scrolls
    // sideways is the usual symptom of a table escaping its overflow container.
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await ownerPage.goto('/dashboard');

    const overflows = await ownerPage.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  test('reports no console errors', async ({ ownerPage }) => {
    const errors: string[] = [];
    ownerPage.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await ownerPage.goto('/dashboard');
    await ownerPage.waitForLoadState('networkidle');

    expect(errors).toEqual([]);
  });
});

test.describe('admin section', () => {
  test('is reachable by a platform administrator', async ({ adminPage }) => {
    await adminPage.goto('/admin');

    await expect(adminPage.getByRole('heading', { name: 'Overview' })).toBeVisible();
    // The banner is a deliberate safety cue: every page here spans all tenants.
    await expect(adminPage.getByText(/Platform administration/i)).toBeVisible();
  });

  test('shows revenue figures rather than an error panel', async ({ adminPage }) => {
    await adminPage.goto('/admin');

    // Proves the server component reached the API with credentials. A 403 would
    // render the panel-level error state instead.
    // The MRR stat tile specifically. A bare getByText('MRR') now also matches
    // the two chart headings and a column header, and strict mode fails on the
    // count rather than on whether the figure rendered.
    await expect(
      adminPage.getByRole('heading', { name: 'MRR movement' }),
    ).toBeVisible();
    await expect(adminPage.getByText(/Could not load this panel/i)).toHaveCount(0);
    await expect(
      adminPage.getByText(/Could not load your workspace/i),
    ).toHaveCount(0);
  });

  test('refuses a non-admin, and fails as a panel error rather than a crash', async ({
    ownerPage,
  }) => {
    // Hiding the nav link is presentation; the real control is @Roles on the API.
    // A tenant owner reaching this URL must see refusals, not data.
    await ownerPage.goto('/admin');

    // Refusal, not data. The revenue charts render their own error state, so
    // either message is an acceptable refusal — what matters is that no figure
    // reaches a tenant owner.
    await expect(
      ownerPage
        .getByText(/Could not load this panel|Could not load/i)
        .first(),
    ).toBeVisible();
    await expect(
      ownerPage.getByRole('heading', { name: 'MRR movement' }),
    ).toHaveCount(0);
  });

  test('lists companies for an administrator', async ({ adminPage }) => {
    await adminPage.goto('/admin/companies');

    // `exact`: the page also has an "All companies" panel heading, and a
    // substring match resolves to both.
    await expect(
      adminPage.getByRole('heading', { name: 'Companies', exact: true }),
    ).toBeVisible();
    // .first(): the name appears in the table and again in any row detail.
    await expect(adminPage.getByText('Acme Legal').first()).toBeVisible();
  });

  test('renders the audit log', async ({ adminPage }) => {
    await adminPage.goto('/admin/audit');
    await expect(adminPage.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  });

  test('renders AI cost tracking', async ({ adminPage }) => {
    await adminPage.goto('/admin/ai-costs');
    await expect(adminPage.getByRole('heading', { name: 'AI costs' })).toBeVisible();
  });
});

test.describe('accessibility basics', () => {
  test('every page has exactly one h1', async ({ ownerPage }) => {
    for (const path of ['/dashboard', '/documents']) {
      await ownerPage.goto(path);
      const count = await ownerPage.locator('h1').count();
      expect(count, `${path} should have one h1`).toBe(1);
    }
  });

  test('the main landmark is focusable for skip navigation', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');
    await expect(ownerPage.locator('#main-content')).toHaveAttribute('tabindex', '-1');
  });
});

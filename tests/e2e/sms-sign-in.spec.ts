/**
 * SMS one-time-code sign-in, in a real browser.
 *
 * The code itself is only ever stored hashed (see OtpService), so this spec
 * stops at the point a code has been sent — everything past that is covered by
 * the API-level tests, which can mint a challenge directly. What is worth
 * driving through a browser is the part that only exists here: the phone field
 * and the step transition.
 */
import { test, expect } from '@playwright/test';

const openPhoneStep = async (page: import('@playwright/test').Page) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /^sign in with sms code$/i }).click();
  return page.getByLabel('Phone number');
};

test.describe('SMS sign-in', () => {
  test('offers SMS as an alternative to the password form', async ({ page }) => {
    await page.goto('/login');

    await expect(
      page.getByRole('button', { name: /^sign in with sms code$/i }),
    ).toBeVisible();
  });

  test('formats a national number as it is typed', async ({ page }) => {
    const field = await openPhoneStep(page);

    await field.fill('');
    await field.pressSequentially('915557788');

    await expect(field).toHaveValue('91 555 77 88');
  });

  test('strips the country code from a pasted international number', async ({
    page,
  }) => {
    const field = await openPhoneStep(page);

    // The regression this guards: when +998 lived inside the field, the
    // formatter could not tell its own prefix from the one being typed, and
    // 998915557788 became "+998 99 891 55 57" — a different number, silently.
    await field.fill('998915557788');

    await expect(field).toHaveValue('91 555 77 88');
  });

  test('will not send until the number is complete', async ({ page }) => {
    const field = await openPhoneStep(page);
    const send = page.getByRole('button', { name: /^send code$/i });

    await field.fill('9155');
    await expect(send).toBeDisabled();

    await field.fill('915557788');
    await expect(send).toBeEnabled();
  });

  test('moves to the code step and shows the number it was sent to', async ({
    page,
  }) => {
    const field = await openPhoneStep(page);

    // A number no other spec signs in with, so a leftover cooldown from a
    // parallel run cannot make this one fail.
    await field.fill('900001122');
    await page.getByRole('button', { name: /^send code$/i }).click();

    await expect(page.getByText('+998 90 000 11 22')).toBeVisible();
    await expect(page.getByLabel('Six-digit code')).toBeFocused();
    await expect(page.getByRole('button', { name: /resend in \d+s/i })).toBeVisible();
  });

  test('returns to the password form from the phone step', async ({ page }) => {
    await openPhoneStep(page);

    await page.getByRole('button', { name: /^back$/i }).click();

    await expect(page.getByLabel('Password')).toBeVisible();
  });
});

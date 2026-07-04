const { test, expect } = require('@playwright/test');
const { gotoApp, loginWithPassword } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

// LIVE: hits the real AGS backend through the dev-server proxy. Skips cleanly
// when no test credentials are configured (see .env.test.example).
const creds = testCreds();

test.describe('Live AGS auth', () => {
  test.skip(!creds, 'Set TEST_USER_1_* in .env.test to run live auth tests');

  test('password login signs the user in and loads their profile', async ({ page }) => {
    await gotoApp(page, { offline: false });
    await loginWithPassword(page, creds.user1.identifier, creds.user1.password);

    await expect(page.locator('#ags-signedin-info')).toBeVisible();
    await expect(page.locator('#ags-signedin-name')).toHaveText(/.+/);

    // A real access token is present once signed in.
    const token = await page.evaluate(() => window.agsGetToken && window.agsGetToken());
    expect(token, 'an AGS access token should be available').toBeTruthy();

    // Signed-in-only entry points appear.
    await expect(page.locator('#btn-achievements')).toBeVisible();
    await expect(page.locator('#btn-play-random')).toBeVisible();
  });

  test('logout returns the app to the signed-out state', async ({ page }) => {
    await gotoApp(page, { offline: false });
    await loginWithPassword(page, creds.user1.identifier, creds.user1.password);
    await expect(page.locator('#ags-signedin-info')).toBeVisible();

    await page.locator('.btn-signout').click(); // triggers logout() + reload
    await expect(page.locator('#ags-signin-btn')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#ags-signedin-info')).toBeHidden();
  });

  test('required AGS agreements are accepted and visible in agreement history', async ({ page }) => {
    await gotoApp(page, { offline: false });
    await loginWithPassword(page, creds.user1.identifier, creds.user1.password);

    await page.getByRole('button', { name: 'Privacy & Support' }).click();
    await expect(page.locator('#privacy-center-modal')).toBeVisible();

    const history = page.locator('#ags-accepted-legal-list');
    await expect(history).toContainText('Privacy Policy', { timeout: 20_000 });
    await expect(history).toContainText('Terms of Use');
    await expect(history).toContainText('Community Standards');
    await expect(history.getByText(/Version 1\.0/)).toHaveCount(3);
  });
});

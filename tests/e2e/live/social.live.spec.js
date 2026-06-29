const { test, expect } = require('@playwright/test');
const { gotoApp, loginWithPassword } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

const creds = testCreds();

test.describe('Live friends & achievements', () => {
  test.skip(!creds, 'Set TEST_USER_1_* in .env.test to run live social tests');

  test.beforeEach(async ({ page }) => {
    await gotoApp(page, { offline: false });
    await loginWithPassword(page, creds.user1.identifier, creds.user1.password);
    await expect(page.locator('#ags-signedin-info')).toBeVisible();
  });

  test('friends list loads from AGS without error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.evaluate(() => window.agsRefreshFriends && window.agsRefreshFriends());
    await page.waitForTimeout(3000);
    // The friends container exists and the live refresh did not throw.
    await expect(page.locator('#ags-friends-list')).toBeAttached();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('achievements modal opens and renders cards from AGS', async ({ page }) => {
    await page.locator('#btn-achievements').click();
    await expect(page.locator('#achievements-modal')).toBeVisible();
    // Achievement definitions come from AGS; the grid should populate.
    await expect(page.locator('#achievements-grid > *').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('#achievements-modal').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#achievements-modal')).toBeHidden();
  });
});

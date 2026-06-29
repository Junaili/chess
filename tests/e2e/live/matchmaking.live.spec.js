const { test, expect } = require('@playwright/test');
const { gotoApp, loginWithPassword } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

const creds = testCreds();

test.describe('Live matchmaking ticket lifecycle', () => {
  test.skip(!creds, 'Set TEST_USER_1_* in .env.test to run live matchmaking tests');

  test('Play vs Random creates a ticket and cancel tears it down', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await gotoApp(page, { offline: false });
    await loginWithPassword(page, creds.user1.identifier, creds.user1.password);
    await expect(page.locator('#btn-play-random')).toBeVisible();

    await page.locator('#btn-play-random').click();
    await expect(page.locator('#screen-waiting')).toBeVisible();

    // Let the matchmaking client create the ticket and run a poll cycle or two
    // against live AGS (POLL_INTERVAL is 2s).
    await page.waitForTimeout(5000);

    await page.locator('#btn-waiting-cancel').click(); // deletes the ticket
    await expect(page.locator('#screen-home')).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

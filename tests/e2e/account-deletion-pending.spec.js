const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Pending-deletion visibility during the AGS grace period. Apple reviewers
// exercise exactly this path: request deletion, sign back in, and expect to see
// what is happening plus a way to change their mind.

async function stubStatus(page, payload, status = 200) {
  await page.route('**/account/deletion', route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cancelled: true, pending: false }) });
  });
}

async function renderStatus(page, payload) {
  await page.evaluate(() => {
    document.getElementById('screen-home')?.classList.add('signed-in');
    window.agsSetCurrentUserIdForTesting?.('deleting-user');
  });
  await stubStatus(page, payload);
  await page.evaluate(() => window.agsRefreshDeletionStatus());
}

test.describe('Pending account deletion', () => {
  test('with no deletion scheduled, the Delete Account row stays available', async ({ page }) => {
    await gotoApp(page);
    await renderStatus(page, { pending: false });

    await expect(page.locator('#account-deletion-request')).not.toHaveCSS('display', 'none');
    await expect(page.locator('#account-deletion-pending')).toHaveCSS('display', 'none');
  });

  test('a scheduled deletion replaces the request row with a dated notice', async ({ page }) => {
    await gotoApp(page);
    await renderStatus(page, { pending: true, status: 'Pending', executionDate: '2099-09-02T00:00:00Z' });

    await expect(page.locator('#account-deletion-pending')).not.toHaveCSS('display', 'none');
    await expect(page.locator('#account-deletion-request')).toHaveCSS('display', 'none');
    const detail = page.locator('#account-deletion-pending-detail');
    await expect(detail).toContainText('scheduled for deletion');
    await expect(detail).toContainText('2099');
    // Never leak the zero-time or a broken date to the player.
    await expect(detail).not.toContainText('0001');
    await expect(detail).not.toContainText('NaN');
  });

  test('cancelling restores the Delete Account row and confirms the account is safe', async ({ page }) => {
    await gotoApp(page);
    await renderStatus(page, { pending: true, status: 'Pending', executionDate: '2099-09-02T00:00:00Z' });

    // Invoke what the button is wired to rather than clicking: the row lives on
    // the profile screen, which this harness never navigates to. The wiring
    // itself is asserted separately below.
    await page.evaluate(() => window.agsCancelAccountDeletion());

    await expect(page.locator('#account-deletion-request')).not.toHaveCSS('display', 'none');
    await expect(page.locator('#account-deletion-pending')).toHaveCSS('display', 'none');
    await expect(page.locator('#profile-safety-message')).toContainText('cancelled');
  });

  test('the Keep my account button is wired to the cancel handler', async ({ page }) => {
    await gotoApp(page);
    const wiring = await page.locator('#btn-cancel-deletion').getAttribute('data-click');
    expect(wiring).toContain('agsCancelAccountDeletion');
    // And the handler it names is actually exposed.
    expect(await page.evaluate(() => typeof window.agsCancelAccountDeletion)).toBe('function');
  });

  // The Delete Account path is an App Store requirement — a failing status
  // probe must never hide it.
  test('a failing status check leaves the Delete Account row reachable', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => window.agsSetCurrentUserIdForTesting?.('deleting-user'));
    await page.route('**/account/deletion', route => route.abort());
    await page.evaluate(() => window.agsRefreshDeletionStatus());

    await expect(page.locator('#account-deletion-request')).not.toHaveCSS('display', 'none');
    await expect(page.locator('#account-deletion-pending')).toHaveCSS('display', 'none');
  });
});

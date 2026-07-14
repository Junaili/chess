const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Family allowance — "Give coins" (dev-plan Milestone 8 / §6.8). /coins/give
// is stubbed at the network layer (pattern: kudos.spec.js's stubClubStatusCoins).
// familyState is a private main.js module binding, so this drives the real
// renderFamilyPanel()/agsGiveCoins() code paths via a dedicated dev-only
// setter (window.agsSetFamilyStateForTesting) rather than hand-injected DOM,
// the same tradeoff club.spec.js makes with window.agsRenderClubForTesting.

const GUARDIAN_ID = 'guardian-1';
const CHILD_ID = 'child-1';

function familyState() {
  return {
    group: { groupId: 'grp-1', groupName: 'Test Family' },
    members: [
      { userId: GUARDIAN_ID, displayName: 'Parent', role: 'guardian', presence: { status: 'online', label: 'Online' } },
      { userId: CHILD_ID, displayName: 'Kid', role: 'child', presence: { status: 'offline', label: 'Offline' } },
    ],
    incomingInvites: [],
  };
}

// #ags-family-panel is nested inside #ags-friends-panel, which (like the
// rest of the signed-in dashboard) is gated behind #screen-home.signed-in
// and its own inline display style — same two lines people-panel.spec.js
// sets before asserting on family DOM.
async function showPeoplePanel(page) {
  await page.evaluate(() => {
    document.getElementById('screen-home').classList.add('signed-in');
    document.getElementById('ags-friends-panel').style.display = '';
  });
}

async function setupSignedInGuardian(page) {
  await gotoApp(page);
  await showPeoplePanel(page);
  await page.evaluate(guardianId => {
    window.agsCurrentUserId = guardianId;
    window.agsSetCurrentUserIdForTesting?.(guardianId);
  }, GUARDIAN_ID);
}

test.describe('Family allowance — Give coins', () => {
  test('guardian sees a "Give coins" button on the child row, not on their own row', async ({ page }) => {
    await setupSignedInGuardian(page);
    await page.evaluate(state => window.agsSetFamilyStateForTesting(state), familyState());

    const rows = page.locator('#ags-family-list .friend-row');
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#ags-family-list [data-action="give-coins"]')).toHaveCount(1);
    await expect(page.locator(`#ags-family-list [data-action="give-coins"][data-user-id="${CHILD_ID}"]`)).toBeVisible();
  });

  test('non-guardian family member never sees a "Give coins" button', async ({ page }) => {
    await gotoApp(page);
    await showPeoplePanel(page);
    await page.evaluate(childId => {
      window.agsCurrentUserId = childId;
      window.agsSetCurrentUserIdForTesting?.(childId);
    }, CHILD_ID);
    await page.evaluate(state => window.agsSetFamilyStateForTesting(state), familyState());

    await expect(page.locator('#ags-family-list [data-action="give-coins"]')).toHaveCount(0);
  });

  test('give-coins flow POSTs recipientUserId + amount, and shows a confirmation with the new balance', async ({ page }) => {
    await setupSignedInGuardian(page);
    await page.evaluate(state => window.agsSetFamilyStateForTesting(state), familyState());

    let requestBody = null;
    await page.route('**/coins/give*', route => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, guardianBalance: 50 }),
      });
    });
    // /club/status is force-refreshed after a successful give; keep it benign.
    await page.route('**/club/status*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false, coins: 50, activeSkus: [], canPurchase: true, journalOpen: null, narrativesRemainingToday: 1 }),
    }));

    page.once('dialog', dialog => dialog.accept('25'));
    await page.locator(`#ags-family-list [data-action="give-coins"][data-user-id="${CHILD_ID}"]`).click();

    await expect(page.locator('#ags-family-message')).toContainText('Gave 25 coins to Kid');
    await expect(page.locator('#ags-family-message')).toContainText('50 🪙');
    expect(requestBody).toEqual({ recipientUserId: CHILD_ID, amount: 25 });
  });

  test('cancelling the amount prompt sends no request', async ({ page }) => {
    await setupSignedInGuardian(page);
    await page.evaluate(state => window.agsSetFamilyStateForTesting(state), familyState());

    let called = false;
    await page.route('**/coins/give*', route => { called = true; return route.fulfill({ status: 200, body: '{}' }); });

    page.once('dialog', dialog => dialog.dismiss());
    await page.locator(`#ags-family-list [data-action="give-coins"][data-user-id="${CHILD_ID}"]`).click();

    expect(called).toBe(false);
  });

  test('a non-numeric amount is rejected client-side with no request sent', async ({ page }) => {
    await setupSignedInGuardian(page);
    await page.evaluate(state => window.agsSetFamilyStateForTesting(state), familyState());

    let called = false;
    await page.route('**/coins/give*', route => { called = true; return route.fulfill({ status: 200, body: '{}' }); });

    page.once('dialog', dialog => dialog.accept('not-a-number'));
    await page.locator(`#ags-family-list [data-action="give-coins"][data-user-id="${CHILD_ID}"]`).click();

    await expect(page.locator('#ags-family-message')).toContainText('Enter a whole number');
    expect(called).toBe(false);
  });

  test('server-side insufficient_coins shows the balance from the 402 response', async ({ page }) => {
    await setupSignedInGuardian(page);
    await page.evaluate(state => window.agsSetFamilyStateForTesting(state), familyState());

    await page.route('**/coins/give*', route => route.fulfill({
      status: 402,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'insufficient_coins', message: 'Not enough coins.', balance: 5 }),
    }));

    page.once('dialog', dialog => dialog.accept('999'));
    await page.locator(`#ags-family-list [data-action="give-coins"][data-user-id="${CHILD_ID}"]`).click();

    await expect(page.locator('#ags-family-message')).toContainText('you have 5 🪙');
  });
});

const { test, expect } = require('@playwright/test');
const { gotoApp, loginWithPassword } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

const creds = testCreds();
const haveTwo = !!(creds && creds.user2);

// LIVE two-account family flow against real AGS Group v2: create family →
// invite (friend-gated picker) → accept → guardian/child role badges →
// guardian-only Coaching tab on the child's profile → leave/cleanup.
test.describe('Live family flow (two accounts)', () => {
  test.skip(!haveTwo, 'Set TEST_USER_2_* in .env.test to run the family test');

  test('guardian creates a family, invites a child, and gets a coaching view', async ({ browser }) => {
    test.setTimeout(240_000);

    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage(); // guardian
    const pageB = await ctxB.newPage(); // child

    // Any family left over from a previous run makes create/invite
    // unreachable — leave it first (dialogs auto-accepted by gotoApp).
    async function leaveExistingFamily(page) {
      await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) {
          if (typeof window.agsRefreshFamily === 'function') await window.agsRefreshFamily(false)
          const actions = document.getElementById('ags-family-actions')
          if (!actions || actions.style.display === 'none') return
          if (typeof window.agsLeaveFamily === 'function') await window.agsLeaveFamily()
        }
      })
    }

    try {
      await gotoApp(pageA, { offline: false });
      await gotoApp(pageB, { offline: false });
      await loginWithPassword(pageA, creds.user1.identifier, creds.user1.password);
      await loginWithPassword(pageB, creds.user2.identifier, creds.user2.password);

      await expect(pageA.locator('#ags-family-panel')).toBeVisible({ timeout: 30_000 });
      await leaveExistingFamily(pageA);
      await leaveExistingFamily(pageB);
      await pageA.evaluate(() => window.agsRefreshFamily(false));
      await pageB.evaluate(() => window.agsRefreshFamily(false));

      // The invite picker is friend-gated; make sure the accounts are friends
      // (request+accept are harmless no-op errors if they already are).
      const userIdA = await pageA.evaluate(() => window.agsCurrentUserId);
      const userIdB0 = await pageB.evaluate(() => window.agsCurrentUserId);
      await pageA.evaluate(async id => { await window.agsRequestFriend(id) }, userIdB0);
      await pageB.evaluate(async id => {
        await window.agsRefreshFriends(false)
        await window.agsAcceptFriend(id)
      }, userIdA);
      await pageA.evaluate(() => window.agsRefreshFriends(false));

      // A creates the family.
      await expect(pageA.locator('#ags-family-empty')).toBeVisible({ timeout: 15_000 });
      await pageA.locator('#ags-family-empty button').click();
      await expect(pageA.locator('#ags-section-family-members')).toBeVisible({ timeout: 15_000 });
      await expect(pageA.locator('#ags-family-list .family-role-badge').first()).toHaveText('Guardian');

      // The invite picker opens automatically after create; the two QA
      // accounts are friends from the standing QA suite, so B is offered.
      const userIdB = await pageB.evaluate(() => window.agsCurrentUserId);
      const inviteButton = pageA.locator(`#ags-family-invite-picker [data-action="family-invite"][data-user-id="${userIdB}"]`);
      await expect(inviteButton).toBeVisible({ timeout: 15_000 });
      await inviteButton.click();
      await expect(pageA.locator('#ags-family-message')).toContainText(/invite sent/i, { timeout: 15_000 });

      // B refreshes and accepts.
      await pageB.evaluate(() => window.agsRefreshFamily(false));
      const acceptButton = pageB.locator('#ags-family-invites [data-action="accept-family"]');
      await expect(acceptButton).toBeVisible({ timeout: 20_000 });
      await acceptButton.click();
      await expect(pageB.locator('#ags-section-family-members')).toBeVisible({ timeout: 15_000 });
      // B sees both members; B's own row carries the Child badge.
      await expect(pageB.locator('#ags-family-list .friend-row')).toHaveCount(2, { timeout: 15_000 });
      await expect(pageB.locator('#ags-family-list .family-role-badge').filter({ hasText: 'Child' })).toHaveCount(1);

      // Guardian A opens the child's profile → Coaching tab visible.
      await pageA.evaluate(() => window.agsRefreshFamily(false));
      await pageA.evaluate(id => window.agsOpenProfile(id, ''), userIdB);
      await expect(pageA.locator('[data-profile-tab="coaching"]')).toBeVisible({ timeout: 20_000 });
      await pageA.locator('[data-profile-tab="coaching"]').click();
      // Either real analysis or the no-games empty state — both prove the
      // tab renders through the coaching pipeline.
      await expect(pageA.locator('#profile-coaching-headline')).toHaveText(/.+/, { timeout: 60_000 });

      // Child B opens the guardian's profile → NO coaching tab.
      await pageB.evaluate(id => window.agsOpenProfile(id, ''), userIdA);
      await expect(pageB.locator('#profile-display-name')).toHaveText(/.+/, { timeout: 20_000 });
      await expect(pageB.locator('[data-profile-tab="coaching"]')).toBeHidden();
    } finally {
      // Cleanup: both leave; AGS garbage-collects the empty group.
      await pageB.evaluate(async () => { if (window.agsLeaveFamily) await window.agsLeaveFamily() }).catch(() => {});
      await pageA.evaluate(async () => { if (window.agsLeaveFamily) await window.agsLeaveFamily() }).catch(() => {});
      await ctxA.close();
      await ctxB.close();
    }
  });
});

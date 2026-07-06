const { test, expect } = require('@playwright/test');
const { gotoApp, loginWithPassword, squareLocator } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

const creds = testCreds();
const haveTwo = !!(creds && creds.user2);

// LIVE test: verifies a player can crash/reload mid-match and resume it —
// the actual feature under test in the match-resiliency plan. Reuses the
// same matchmaking-pairing pattern as online-match.live.spec.js.
test.describe('Live match resume after reload', () => {
  test.skip(!haveTwo, 'Set TEST_USER_2_* in .env.test to run the resume test');

  test('a page reload mid-match offers a resume prompt that restores the board and reconnects', async ({ browser }) => {
    test.setTimeout(180_000);

    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    let pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await gotoApp(pageA, { offline: false });
      await gotoApp(pageB, { offline: false });
      await loginWithPassword(pageA, creds.user1.identifier, creds.user1.password);
      await loginWithPassword(pageB, creds.user2.identifier, creds.user2.password);

      await pageA.locator('#btn-play-random').click();
      await pageB.locator('#btn-play-random').click();

      await expect(pageA.locator('#screen-game')).toBeVisible({ timeout: 120_000 });
      await expect(pageB.locator('#screen-game')).toBeVisible({ timeout: 120_000 });
      await expect(pageA.locator('#online-chat-status')).toHaveText('Connected', { timeout: 30_000 });
      await expect(pageB.locator('#online-chat-status')).toHaveText('Connected', { timeout: 30_000 });

      // Whoever is White (moves first) plays e2-e4; try A, fall back to B.
      await squareLocator(pageA, 'e2').click();
      await squareLocator(pageA, 'e4').click();
      const movedOnA = await squareLocator(pageA, 'e4').locator('.piece').count();
      if (!movedOnA) {
        await squareLocator(pageB, 'e2').click();
        await squareLocator(pageB, 'e4').click();
      }
      await expect(pageB.locator('[data-r="4"][data-c="4"] .piece')).toHaveCount(1, { timeout: 30_000 });

      // Simulate a crash/relaunch on A: a real page reload, fresh JS context.
      await pageA.reload();

      // Session should auto-resume from the stored token; land signed in
      // (directly, or via the legal gate) rather than at the login screen.
      await expect.poll(async () => {
        if (await pageA.locator('#resume-match-modal').isVisible()) return 'resume-prompt';
        if (await pageA.locator('#screen-login').isVisible()) return 'login-required';
        return 'waiting';
      }, { timeout: 45_000 }).not.toBe('waiting');

      if (await pageA.locator('#screen-login').isVisible()) {
        // Session didn't auto-resume in this environment — log back in
        // explicitly; the resume check fires from the same post-login hook.
        await loginWithPassword(pageA, creds.user1.identifier, creds.user1.password);
      }

      await expect(pageA.locator('#resume-match-modal')).toBeVisible({ timeout: 30_000 });
      const opponentText = (await pageA.locator('#resume-match-opponent').textContent())?.trim();
      expect(opponentText).toBeTruthy();
      expect(opponentText).not.toBe('Opponent'); // the unpopulated placeholder value
      await pageA.getByRole('button', { name: 'Resume Game' }).click();

      // B never reloaded, but its own connection-lost handling (triggered
      // when A vanished) destroys its peer and returns it home — B needs to
      // accept the same resume prompt before anyone is listening again.
      await expect(pageB.locator('#resume-match-modal')).toBeVisible({ timeout: 30_000 });
      await pageB.getByRole('button', { name: 'Resume Game' }).click();

      await expect(pageA.locator('#screen-game')).toBeVisible({ timeout: 30_000 });
      await expect(pageB.locator('#screen-game')).toBeVisible({ timeout: 30_000 });
      // The pre-reload move must have survived the resume (recovered from the
      // chess-live CloudSave record, not from any in-memory state).
      await expect(pageA.locator('[data-r="4"][data-c="4"] .piece')).toHaveCount(1);
      await expect(pageA.locator('[data-r="6"][data-c="4"] .piece')).toHaveCount(0);

      // Prove the PeerJS connection is genuinely live again, not just a
      // locally-redrawn board: play one more move from B and confirm A sees it.
      await squareLocator(pageB, 'e7').click();
      await squareLocator(pageB, 'e5').click();
      await expect(pageA.locator('[data-r="3"][data-c="4"] .piece')).toHaveCount(1, { timeout: 30_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

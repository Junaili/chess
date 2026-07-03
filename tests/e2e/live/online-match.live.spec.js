const { test, expect } = require('@playwright/test');
const { gotoApp, loginWithPassword, squareLocator } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

const creds = testCreds();
const haveTwo = !!(creds && creds.user2);

// LIVE two-player online match over real AGS matchmaking + PeerJS. Needs a
// second account (TEST_USER_2_*). The whole flow (queue → match → peer connect →
// move sync) is generous on time and inherently network-dependent.
test.describe('Live online match (two players)', () => {
  test.skip(!haveTwo, 'Set TEST_USER_2_* in .env.test to run the two-player online match test');

  test('two queued players sync a move over PeerJS and chat over AGS', async ({ browser }) => {
    test.setTimeout(180_000);

    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await gotoApp(pageA, { offline: false });
      await gotoApp(pageB, { offline: false });
      await loginWithPassword(pageA, creds.user1.identifier, creds.user1.password);
      await loginWithPassword(pageB, creds.user2.identifier, creds.user2.password);

      // Both enter the quick-match queue.
      await pageA.locator('#btn-play-random').click();
      await pageB.locator('#btn-play-random').click();

      // Matchmaking + PeerJS handshake lands both on the board.
      await expect(pageA.locator('#screen-game')).toBeVisible({ timeout: 120_000 });
      await expect(pageB.locator('#screen-game')).toBeVisible({ timeout: 120_000 });
      await expect(pageA.locator('#chess-board .piece')).toHaveCount(32);
      await expect(pageA.locator('#online-chat-status')).toHaveText('Connected', { timeout: 30_000 });
      await expect(pageB.locator('#online-chat-status')).toHaveText('Connected', { timeout: 30_000 });

      const chatText = `AGS chat ${Date.now()}`;
      await pageA.locator('#online-chat-input').fill(chatText);
      await pageA.locator('#btn-chat-send').click();
      await expect(pageA.locator('.chat-message-body', { hasText: chatText })).toHaveCount(1);
      await expect(pageB.locator('.chat-message-body', { hasText: chatText })).toHaveCount(1, { timeout: 30_000 });

      // Whoever is White (moves first) plays e2-e4; try A, fall back to B.
      let whitePage = pageA;
      let blackPage = pageB;
      await squareLocator(pageA, 'e2').click();
      await squareLocator(pageA, 'e4').click();
      const movedOnA = await squareLocator(pageA, 'e4').locator('.piece').count();
      if (!movedOnA) {
        whitePage = pageB;
        blackPage = pageA;
        await squareLocator(pageB, 'e2').click();
        await squareLocator(pageB, 'e4').click();
      }

      // The move must replicate to the opponent's board (e2 empty, e4 occupied).
      await expect(whitePage.locator('#chess-board').locator('[data-r="4"][data-c="4"] .piece')).toHaveCount(1);
      await expect(blackPage.locator('[data-r="4"][data-c="4"] .piece')).toHaveCount(1, { timeout: 30_000 });
      await expect(blackPage.locator('[data-r="6"][data-c="4"] .piece')).toHaveCount(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

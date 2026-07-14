const { test, expect } = require('@playwright/test');
const { gotoApp, openGuestColorSelect } = require('./helpers.cjs');

// High Five — offline spec. /coins/highfive is stubbed at the network layer
// (pattern: club.spec.js). Reaching an online-match game-over state mirrors
// exactly what resignGame() does in production (force game.status/winner,
// call showGameOver()) via two small always-on test seams in app.js
// (setCurrentMatchIdForTesting / setGameModeForTesting), the same pattern
// already established by setCurrentOpponent (used by player-safety.spec.js
// and video-chat-gate.spec.js).

async function reachOnlineWin(page, { opponentUserId = 'opp-1', matchId = 'match-test-1', coins = 50 } = {}) {
  await openGuestColorSelect(page);
  await page.locator('#screen-color-select .color-btn.white-btn').click();
  await page.locator('#piece-color-options > *').first().click();
  await page.locator('#screen-difficulty .diff-btn.easy').click();
  await page.locator('#chess-board [data-r]').first().waitFor({ state: 'visible' });

  await page.evaluate(({ opponentUserId, matchId, coins }) => {
    window.agsCurrentUserId = 'self-player';
    // main.js's OWN currentUserId is a private module binding — the mirror
    // above (agsCurrentUserId) only flows main.js -> app.js, not back.
    window.agsSetCurrentUserIdForTesting?.('self-player');
    // window.agsHighFiveButtonState reads getCoins() synchronously from
    // club.js's cache — nothing in this test flow ever triggers a real
    // /club/status fetch (that only happens via real sign-in hydration), so
    // seed the cache directly via the same seam club.spec.js uses.
    window.agsRenderClubForTesting?.(
      { active: false, coins, activeSkus: [], canPurchase: true, journalOpen: null, narrativesRemainingToday: 1 },
      { isChildSession: false },
    );
    window.setGameModeForTesting('online');
    window.setCurrentOpponent('Opponent One', opponentUserId);
    window.setCurrentMatchIdForTesting(matchId);
    window.forceGameOverStateForTesting('checkmate', 'white'); // player chose white above
    window.showGameOver();
  }, { opponentUserId, matchId, coins });

  await expect(page.locator('#game-over-modal')).toBeVisible();
}

async function stubClubStatusCoins(page, coins) {
  await page.route('**/club/status*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ active: false, coins, activeSkus: [], canPurchase: true, journalOpen: null, narrativesRemainingToday: 1 }),
  }));
}

test.describe('High Five', () => {
  test('eligible: shows an enabled button with the coin cost when facing a real opponent with enough coins', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatusCoins(page, 50);
    await reachOnlineWin(page);

    const btn = page.locator('#btn-high-five');
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(btn).toContainText('10 🪙');
  });

  test('sending: clicking POSTs matchId + recipientUserId, updates the button, and notifies the connected peer', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatusCoins(page, 50);
    let requestBody = null;
    await page.route('**/coins/highfive*', route => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, senderBalance: 40 }) });
    });
    await reachOnlineWin(page);

    // Simulate a connected peer so the "notify" send path is exercised too.
    // peerConn is app.js's own module-private `let`, not window.peerConn.
    await page.evaluate(() => {
      window.__sentToPeer = [];
      window.setPeerConnForTesting({ open: true, send: msg => window.__sentToPeer.push(msg) });
    });

    await page.locator('#btn-high-five').click();

    await expect.poll(() => requestBody).toEqual({ matchId: 'match-test-1', recipientUserId: 'opp-1' });
    await expect(page.locator('#btn-high-five')).toContainText('sent');
    await expect(page.locator('#btn-high-five')).toBeDisabled();
    const sentToPeer = await page.evaluate(() => window.__sentToPeer);
    expect(sentToPeer).toEqual([{ type: 'highfive', fromName: 'Tester' }]);
  });

  test('broke: shows a disabled button with a friendly "need N coins" label when balance is too low', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatusCoins(page, 4);
    await reachOnlineWin(page, { coins: 4 });

    const btn = page.locator('#btn-high-five');
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText('need 10');
  });

  test('insufficient-funds server rejection (stale client balance) shows the friendly exact-balance message', async ({ page }) => {
    await gotoApp(page);
    // Client thinks it has enough (stale cache); server disagrees.
    await stubClubStatusCoins(page, 50);
    await page.route('**/coins/highfive*', route => route.fulfill({
      status: 402,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'insufficient_coins', message: 'Not enough coins.', senderBalance: 4 }),
    }));
    await reachOnlineWin(page);

    await page.locator('#btn-high-five').click();
    await expect(page.locator('#match-friend-message')).toContainText('you have 4');
    // Button re-enables so the player can try again after topping up elsewhere.
    await expect(page.locator('#btn-high-five')).toBeEnabled();
  });

  test('vs bot: no High Five button', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatusCoins(page, 50);
    await page.evaluate(() => {
      window.agsGambitGusUserId = 'gambit-gus';
      window.agsGambitGusName = 'Gambit Gus';
    });
    await reachOnlineWin(page, { opponentUserId: 'gambit-gus' });

    await expect(page.locator('#btn-high-five')).toBeHidden();
  });

  test('guest/unknown opponent (no AGS userId): no High Five button — never guesses an identity', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatusCoins(page, 50);
    await reachOnlineWin(page, { opponentUserId: '' });

    await expect(page.locator('#btn-high-five')).toBeHidden();
  });

  test('vs computer (not online): no High Five button', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatusCoins(page, 50);
    await openGuestColorSelect(page);
    await page.locator('#screen-color-select .color-btn.white-btn').click();
    await page.locator('#piece-color-options > *').first().click();
    await page.locator('#screen-difficulty .diff-btn.easy').click();
    await page.locator('#chess-board [data-r]').first().waitFor({ state: 'visible' });
    await page.evaluate(() => {
      window.forceGameOverStateForTesting('checkmate', 'white');
      window.showGameOver();
    });

    await expect(page.locator('#game-over-modal')).toBeVisible();
    await expect(page.locator('#btn-high-five')).toBeHidden();
  });

  test('repeat blocked: a second High Five on the same match shows the sent state without a new request', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatusCoins(page, 50);
    let calls = 0;
    await page.route('**/coins/highfive*', route => {
      calls++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, senderBalance: 40 }) });
    });
    await reachOnlineWin(page);
    await page.locator('#btn-high-five').click();
    await expect(page.locator('#btn-high-five')).toContainText('sent');

    // Re-open game-over state for the SAME match (e.g. modal re-rendered) —
    // the client-side "already sent" tracking should keep it disabled
    // without hitting the server again.
    await page.evaluate(() => {
      window.setCurrentMatchIdForTesting('match-test-1');
      window.forceGameOverStateForTesting('checkmate', 'white');
      window.showGameOver();
    });
    await expect(page.locator('#btn-high-five')).toContainText('sent');
    await expect(page.locator('#btn-high-five')).toBeDisabled();
    expect(calls).toBe(1);
  });
});

// Kudos-count display on the profile screen (index.html's #profile-kudos,
// populated in src/main.js's openPublicProfile from stats.js's fetchStats)
// is NOT covered by an offline e2e test: reaching it requires main.js's own
// internal `currentUserId` to be set, which only happens through a real
// sign-in — no e2e spec in this suite simulates that offline (gotoApp's
// default blocks **/iam/** entirely; genuine sessions live under
// tests/e2e/live/). Coverage here is the formatKudosCount() unit test
// (tests/unit/kudos-contract.test.cjs) plus the fact that #profile-kudos
// follows the exact same fetchStats()-> textContent path already exercised
// for wins/losses/rating on every profile view.

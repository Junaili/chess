const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Home leaderboard panel: capped at 10 entries with a "View full leaderboard"
// overlay for the rest. Offline spec — rendering is driven directly via the
// dev-only agsRenderLeaderboardForTesting seam (same pattern as
// agsRenderFriendsListForTesting) so it doesn't depend on the AGS SDK's
// response shape; the overlay's own fetch is stubbed at the network layer.

function rankings(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    userId: `player-${offset + i}`,
    point: 2000 - (offset + i) * 10,
    additionalData: { displayName: `Player ${offset + i + 1}` },
  }));
}

// The AGS leaderboard SDK validates responses against GetLeaderboardRankingResp
// (zod) — data[] plus a required (if empty-ish) paging object — so a network
// stub must include it or the client-side call throws and the row never
// renders.
function rankingsResponseBody(count, offset = 0) {
  return JSON.stringify({
    data: rankings(count, offset),
    paging: { First: '', Last: '', Next: '', Previous: '' },
  });
}

test.describe('Leaderboard: top 10 + view full overlay', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      document.getElementById('screen-home').classList.add('signed-in');
      document.getElementById('home-leaderboard-panel').style.display = '';
    });
  });

  test('shows at most 10 rows and hides "view full" when there are 10 or fewer', async ({ page }) => {
    await page.evaluate(data => {
      window.agsRenderLeaderboardForTesting(data, {}, null, false);
    }, rankings(7));

    await expect(page.locator('#lb-list .lb-entry')).toHaveCount(7);
    await expect(page.locator('#lb-view-more')).toBeHidden();
    await expect(page.locator('#lb-your-rank')).toBeHidden();
  });

  test('shows exactly 10 rows plus "view full leaderboard" when there are more', async ({ page }) => {
    await page.evaluate(data => {
      window.agsRenderLeaderboardForTesting(data, {}, null, true);
    }, rankings(10));

    await expect(page.locator('#lb-list .lb-entry')).toHaveCount(10);
    const viewMore = page.locator('#lb-view-more');
    await expect(viewMore).toBeVisible();
    await expect(viewMore).toContainText('View full leaderboard');
  });

  test('shows a "your rank" callout when the player is outside the top 10', async ({ page }) => {
    await page.evaluate(data => {
      window.currentUserId = 'me';
      window.agsRenderLeaderboardForTesting(data, {}, { rank: 42, point: 980 }, true);
    }, rankings(10));

    const rankCard = page.locator('#lb-your-rank');
    await expect(rankCard).toBeVisible();
    await expect(rankCard).toContainText('Your rank');
    await expect(rankCard).toContainText('#42');
    // Not duplicated as an 11th row in the scrolling list.
    await expect(page.locator('#lb-list .lb-entry')).toHaveCount(10);
  });

  test('opens the full leaderboard, switches views, and closes on Escape', async ({ page }) => {
    // gotoApp() already routed this exact pattern to abort() (offline mode);
    // clear it before installing a stub that actually answers the request.
    await page.unroute('**/leaderboard/**');
    await page.route('**/leaderboard/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: rankingsResponseBody(15),
    }));
    await page.evaluate(data => {
      window.agsRenderLeaderboardForTesting(data, {}, null, true);
    }, rankings(10));

    await page.locator('#lb-view-more').click();
    const overlay = page.locator('#leaderboard-overlay');
    await expect(overlay).toBeVisible();
    await expect(page.locator('#leaderboard-overlay-list .lb-entry')).toHaveCount(15);
    await expect(page.locator('#leaderboard-overlay-list')).toContainText('Player 1');

    await expect(page.locator('[data-lb-overlay-view="rating"]')).toHaveClass(/active/);
    await page.locator('[data-lb-overlay-view="weekly"]').click();
    await expect(page.locator('[data-lb-overlay-view="weekly"]')).toHaveClass(/active/);
    await expect(page.locator('[data-lb-overlay-view="rating"]')).not.toHaveClass(/active/);

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(page.locator('#lb-view-more')).toBeFocused();
  });

  test('closing a profile opened from the overlay leaves the overlay closed', async ({ page }) => {
    await page.unroute('**/leaderboard/**');
    await page.route('**/leaderboard/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: rankingsResponseBody(12),
    }));
    await page.evaluate(data => {
      window.agsRenderLeaderboardForTesting(data, {}, null, true);
    }, rankings(10));

    await page.locator('#lb-view-more').click();
    await expect(page.locator('#leaderboard-overlay')).toBeVisible();

    await page.locator('#leaderboard-overlay-list .lb-name-button').first().click();
    await expect(page.locator('#screen-profile')).toBeVisible();
    await expect(page.locator('#leaderboard-overlay')).toBeHidden();
  });
});

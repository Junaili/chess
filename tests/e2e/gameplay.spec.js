const { test, expect } = require('@playwright/test');
const { gotoApp, startVsComputer, playMove, squareLocator } = require('./helpers.cjs');

// Fully offline: the "Single Player" mode is pure client-side logic, so these
// run on both the Chromium (browser) and WebKit/iPad (iOS engine) projects.
test.describe('Single Player', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('player move is applied and the computer replies', async ({ page }) => {
    await startVsComputer(page, { color: 'white', difficulty: 'easy' });

    await playMove(page, 'e2', 'e4');

    // The pawn left e2 and now sits on e4.
    await expect(squareLocator(page, 'e2').locator('.piece')).toHaveCount(0);
    await expect(squareLocator(page, 'e4').locator('.piece')).toHaveCount(1);

    // White's move is recorded, then the engine answers with a black move.
    const firstRow = page.locator('#move-list .move-row').first();
    await expect(firstRow.locator('.move-white')).toHaveText(/^e4/);
    await expect(firstRow.locator('.move-black')).toHaveText(/.+/, { timeout: 20_000 });
  });

  test('choosing black lets the computer open as white', async ({ page }) => {
    await startVsComputer(page, { color: 'black', difficulty: 'easy' });

    // No human input yet — the computer (white) must make the first move, then
    // wait for the human (black). Exactly one white ply, no black ply yet.
    const firstRow = page.locator('#move-list .move-row').first();
    await expect(firstRow.locator('.move-white')).toHaveText(/.+/, { timeout: 20_000 });
    await expect(firstRow.locator('.move-black')).toHaveText('');
    await expect(page.locator('#turn-indicator')).toContainText(/your turn/i);
  });

  test('illegal moves are rejected by the UI', async ({ page }) => {
    await startVsComputer(page, { color: 'white', difficulty: 'easy' });

    // e2 -> e5 is not a legal first move; the pawn must stay put.
    await squareLocator(page, 'e2').click();
    await squareLocator(page, 'e5').click();

    await expect(squareLocator(page, 'e2').locator('.piece')).toHaveCount(1);
    await expect(squareLocator(page, 'e5').locator('.piece')).toHaveCount(0);
    await expect(page.locator('#move-list .move-row')).toHaveCount(0);
  });

  test('Get Hint surfaces a suggested move', async ({ page }) => {
    await startVsComputer(page, { color: 'white', difficulty: 'easy' });

    await page.getByRole('tab', { name: 'More' }).click();
    await page.locator('#btn-hint').click();
    await expect(page.locator('#hint-box')).toBeVisible();
    await expect(page.locator('#hint-text')).toHaveText(/.+/);
  });

  test('New Game clears the board state', async ({ page }) => {
    await startVsComputer(page, { color: 'white', difficulty: 'easy' });
    await playMove(page, 'd2', 'd4');
    await expect(page.locator('#move-list .move-row')).not.toHaveCount(0);

    await page.getByRole('tab', { name: 'More' }).click();
    await page.locator('#btn-new-game').click(); // confirm() auto-accepted in helper
    await expect(page.locator('#move-list .move-row')).toHaveCount(0);
    await expect(squareLocator(page, 'd2').locator('.piece')).toHaveCount(1);
  });

  test('Resign ends the game with a loss', async ({ page }) => {
    await startVsComputer(page, { color: 'white', difficulty: 'easy' });
    await playMove(page, 'e2', 'e4');

    await page.getByRole('tab', { name: 'More' }).click();
    await page.locator('#btn-resign').click(); // confirm() auto-accepted in helper
    await expect(page.locator('#game-over-modal')).toBeVisible();
    await expect(page.locator('#game-over-message')).toHaveText(/.+/);
  });

  test('computer game-over offers replay, main menu, and a working challenge share prompt', async ({ page }) => {
    await startVsComputer(page, { color: 'white', difficulty: 'easy' });
    await playMove(page, 'e2', 'e4');

    await page.getByRole('tab', { name: 'More' }).click();
    await page.locator('#btn-resign').click();
    await expect(page.locator('#game-over-modal')).toBeVisible();
    await expect(page.locator('#btn-play-again')).toBeVisible();
    await expect(page.locator('#btn-game-over-home')).toBeVisible();
    await expect(page.locator('#game-over-invite-prompt')).toContainText(/(Share a challenge link|Create an account to invite)/);
    const shareRow = page.locator('#game-over-invite-prompt .share-row');
    if (await shareRow.isVisible().catch(() => false)) {
      await expect(shareRow.locator('.share-chip').first()).toBeVisible();
    } else {
      await expect(page.locator('#game-over-invite-prompt .invite-nudge-cta')).toHaveAttribute('role', 'button');
    }

    await page.locator('#btn-play-again').click();
    await expect(page.locator('#game-over-modal')).toBeHidden();
    await expect(page.locator('#screen-game')).toBeVisible();
    await expect(page.locator('#move-list .move-row')).toHaveCount(0);

    await page.getByRole('tab', { name: 'More' }).click();
    await page.locator('#btn-resign').click();
    await page.locator('#btn-game-over-home').click();
    await expect(page.locator('#game-over-modal')).toBeHidden();
    await expect(page.locator('#screen-home')).toBeVisible();
  });

  // Regression test: an incoming rematch request keeps the game-over modal
  // open (with its Decline button on a separate, absolutely-positioned
  // notification) while a decision is pending. That notification previously
  // had a lower z-index than the modal's full-screen overlay, so it was
  // completely covered — the only path to "no" was invisible and unclickable,
  // leaving players stuck. Playwright's own click-actionability check (which
  // fails if a click target is obscured by another element) is exactly what
  // would have caught this.
  test('an incoming rematch request leaves Decline visible and clickable, and resets the countdown', async ({ page }) => {
    await startVsComputer(page, { color: 'white', difficulty: 'easy' });
    await playMove(page, 'e2', 'e4');
    await page.getByRole('tab', { name: 'More' }).click();
    await page.locator('#btn-resign').click();
    await expect(page.locator('#game-over-modal')).toBeVisible();

    // Simulate an incoming rematch request the same way the peer-message
    // handler does: pause the countdown and surface the notification while
    // the modal stays open underneath it. app.js is a classic (non-module)
    // script, so its top-level functions are already reachable on window.
    await page.evaluate(() => {
      window.stopGameOverCountdown();
      const notification = document.getElementById('rematch-notification');
      notification.style.display = 'flex';
    });
    await expect(page.locator('#game-over-countdown')).toHaveText('');

    const decline = page.locator('#rematch-notification').getByRole('button', { name: 'Decline' });
    await expect(decline).toBeVisible();
    await decline.click(); // fails if obscured by the modal's overlay (the actual bug)

    await expect(page.locator('#rematch-notification')).toBeHidden();
    await expect(page.locator('#rematch-message')).toHaveText(/declined/i);
    await expect(page.locator('#game-over-countdown')).toHaveText(/Returning to Main Menu in \d+s/);
  });
});

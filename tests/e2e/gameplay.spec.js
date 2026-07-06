const { test, expect } = require('@playwright/test');
const { gotoApp, startVsComputer, playMove, squareLocator } = require('./helpers.cjs');

// Fully offline: the "Play vs Computer" mode is pure client-side logic, so these
// run on both the Chromium (browser) and WebKit/iPad (iOS engine) projects.
test.describe('Play vs Computer', () => {
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
});

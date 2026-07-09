const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Video chat is friends-only: the in-game button may only appear once AGS
// confirms mutual friendship with the current opponent, and the call entry
// point refuses strangers even when invoked directly. Offline spec — the
// friendship probe (window.agsIsFriendWith) is stubbed; the gating logic in
// app.js (updateVideoChatAvailability / startVideoChat) runs for real.

const btnDisplay = page =>
  page.evaluate(() => document.getElementById('btn-video-chat').style.display);

// Puts app.js into "online game vs <userId>" state without a live peer:
// showColorSelect('online') sets gameMode, setCurrentOpponent triggers the
// friendship re-check (both are top-level app.js functions, hence globals).
const simulateOnlineOpponent = (page, userId) =>
  page.evaluate(id => {
    window.showColorSelect('online');
    window.setCurrentOpponent(id ? 'Opponent' : '', id);
  }, userId);

test.describe('Video chat friends-only gate', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.agsIsFriendWith = async userId => userId === 'friend-1';
    });
  });

  test('shows the button only after friendship is confirmed', async ({ page }) => {
    await simulateOnlineOpponent(page, 'friend-1');
    await expect.poll(() => btnDisplay(page)).toBe('');
  });

  test('keeps the button hidden for a non-friend opponent', async ({ page }) => {
    await simulateOnlineOpponent(page, 'stranger-9');
    // The probe resolves asynchronously — give it a beat, then assert hidden.
    await page.waitForTimeout(250);
    expect(await btnDisplay(page)).toBe('none');
  });

  test('keeps the button hidden when the opponent is unknown or the probe is unavailable', async ({ page }) => {
    await simulateOnlineOpponent(page, '');
    await page.waitForTimeout(250);
    expect(await btnDisplay(page)).toBe('none');

    await page.evaluate(() => { delete window.agsIsFriendWith; });
    await simulateOnlineOpponent(page, 'friend-1');
    await page.waitForTimeout(250);
    expect(await btnDisplay(page)).toBe('none');
  });

  test('re-checks when the opponent changes mid-session', async ({ page }) => {
    await simulateOnlineOpponent(page, 'friend-1');
    await expect.poll(() => btnDisplay(page)).toBe('');

    // Rematch queue pairs us with a stranger → the button must retract.
    await page.evaluate(() => window.setCurrentOpponent('Rando', 'stranger-9'));
    await expect.poll(() => btnDisplay(page)).toBe('none');
  });

  test('startVideoChat refuses to dial a non-friend even when invoked directly', async ({ page }) => {
    await simulateOnlineOpponent(page, 'stranger-9');
    await page.waitForTimeout(250);

    const dialog = new Promise(resolve => {
      page.once('dialog', async d => {
        const message = d.message();
        await d.dismiss();
        resolve(message);
      });
    });
    await page.evaluate(() => window.startVideoChat());
    expect(await dialog).toContain('only available between friends');
  });
});

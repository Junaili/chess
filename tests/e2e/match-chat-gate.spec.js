const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Match chat is limited to friends and family — casual opponents (random
// matchmaking, the cold-start bot "Gus") are strangers by default and must
// not be able to open a chat channel. Offline spec — the friendship probe
// (window.agsIsFriendWith) is stubbed; the real guard in main.js
// (agsActivateSessionChat / agsActivatePersonalChat / chatPeerGuardError)
// runs for real and rejects before any live chat activation is attempted.

test.describe('Match chat friends-or-family-only gate', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.agsIsFriendWith = async userId => userId === 'friend-1';
    });
  });

  test('rejects session chat with a stranger opponent (e.g. the cold-start bot)', async ({ page }) => {
    const rejected = await page.evaluate(async () => {
      try {
        await window.agsActivateSessionChat('session-1', 'gus-bot-9');
        return null;
      } catch (e) {
        return e.message;
      }
    });
    expect(rejected).toBe('Chat is only available with friends and family.');
  });

  test('rejects personal chat with a stranger opponent', async ({ page }) => {
    const rejected = await page.evaluate(async () => {
      try {
        await window.agsActivatePersonalChat('stranger-9');
        return null;
      } catch (e) {
        return e.message;
      }
    });
    expect(rejected).toBe('Chat is only available with friends and family.');
  });

  test('rejects when the opponent identity is unknown', async ({ page }) => {
    const rejected = await page.evaluate(async () => {
      try {
        await window.agsActivateSessionChat('session-1', '');
        return null;
      } catch (e) {
        return e.message;
      }
    });
    expect(rejected).toBe('Chat requires both players to be signed in.');
  });

  test('never sends a friend request to Gambit Gus', async ({ page }) => {
    const message = await page.evaluate(async () => {
      window.agsGambitGusUserId = 'gus-bot-9';
      window.agsGambitGusName = 'Gambit Gus';
      window.agsLastOpponent = { userId: 'gus-bot-9', name: 'Gambit Gus' };
      await window.agsRequestLastOpponent();
      return document.querySelector('#match-friend-message')?.textContent || '';
    });
    expect(message).toBe('Gambit Gus cannot be added as a friend.');
  });
});

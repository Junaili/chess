const { test, expect } = require('@playwright/test');
const { gotoApp, loginWithPassword, squareLocator } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

const creds = testCreds();
const haveTwo = !!(creds && creds.user2);

async function refreshFriends(page) {
  await page.evaluate(() => window.agsRefreshFriends?.(false));
}

async function unblockIfNeeded(page, otherUserId) {
  const result = await page.evaluate(async userId => {
    if (!window.agsIsBlockedPlayer?.(userId)) return { ok: true };
    return window.agsUnblockPlayer?.(userId);
  }, otherUserId);
  expect(result?.ok).not.toBe(false);
}

async function acceptIncoming(page, fromUserId) {
  const button = page.locator(
    `#ags-friends-incoming button[data-action="accept"][data-user-id="${fromUserId}"]`,
  );
  if (!await button.count()) return false;
  await button.click();
  return true;
}

async function ensureFriends(pageA, pageB, userIdA, userIdB) {
  await refreshFriends(pageA);
  await refreshFriends(pageB);

  if (await pageA.evaluate(id => window.agsIsFriendWith?.(id), userIdB)) return;

  // Reuse either direction of an existing request before creating a new one.
  let accepted = await acceptIncoming(pageA, userIdB);
  if (!accepted) accepted = await acceptIncoming(pageB, userIdA);

  if (!accepted) {
    await pageA.evaluate(id => window.agsRequestFriend?.(id), userIdB);
  }

  await expect.poll(async () => {
    await refreshFriends(pageA);
    await refreshFriends(pageB);
    if (await pageA.evaluate(id => window.agsIsFriendWith?.(id), userIdB)) return true;
    if (await acceptIncoming(pageA, userIdB)) return false;
    if (await acceptIncoming(pageB, userIdA)) return false;
    return false;
  }, {
    message: 'the two live-test accounts should become friends',
    timeout: 45_000,
    intervals: [500, 1000, 2000],
  }).toBe(true);

  await refreshFriends(pageA);
  await refreshFriends(pageB);
}

test.describe('Live friend match invite', () => {
  test.skip(!haveTwo, 'Set TEST_USER_2_* in .env.test to run the friend-invite test');

  test('delivers, accepts, connects, chats, and syncs a move', async ({ browser }) => {
    test.setTimeout(180_000);

    const contextA = await browser.newContext({ ignoreHTTPSErrors: true });
    const contextB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await gotoApp(pageA, { offline: false });
      await gotoApp(pageB, { offline: false });
      await loginWithPassword(pageA, creds.user1.identifier, creds.user1.password);
      await loginWithPassword(pageB, creds.user2.identifier, creds.user2.password);

      const userIdA = await pageA.evaluate(() => window.agsCurrentUserId);
      const userIdB = await pageB.evaluate(() => window.agsCurrentUserId);
      expect(userIdA).toBeTruthy();
      expect(userIdB).toBeTruthy();
      expect(userIdA).not.toBe(userIdB);

      await unblockIfNeeded(pageA, userIdB);
      await unblockIfNeeded(pageB, userIdA);
      await ensureFriends(pageA, pageB, userIdA, userIdB);

      const inviteButton = pageA.locator(
        `#ags-friends-list button[data-action="invite"][data-user-id="${userIdB}"]`,
      );
      await expect(inviteButton).toBeVisible({ timeout: 30_000 });
      await inviteButton.click();

      await expect(pageA.locator('#screen-waiting')).toBeVisible();
      await expect(pageA.locator('#waiting-sub')).toContainText('Invite sent', { timeout: 45_000 });
      const notification = pageB.locator('#friend-match-invite-notification');
      await expect(notification).toBeVisible({ timeout: 45_000 });
      await notification.getByRole('button', { name: 'Accept' }).click();

      await expect(pageA.locator('#screen-game')).toBeVisible({ timeout: 60_000 });
      await expect(pageB.locator('#screen-game')).toBeVisible({ timeout: 60_000 });
      await expect(pageA.locator('#chess-board .piece')).toHaveCount(32);
      await expect(pageB.locator('#chess-board .piece')).toHaveCount(32);
      expect(await pageA.evaluate(() => window.agsLastOpponent?.userId)).toBe(userIdB);
      expect(await pageB.evaluate(() => window.agsLastOpponent?.userId)).toBe(userIdA);

      await expect(pageA.locator('#online-chat-status')).toHaveText('Connected', { timeout: 30_000 });
      await expect(pageB.locator('#online-chat-status')).toHaveText('Connected', { timeout: 30_000 });
      const chatText = `Friend invite chat ${Date.now()}`;
      await pageA.getByRole('tab', { name: 'Chat' }).click();
      await pageB.getByRole('tab', { name: 'Chat' }).click();
      await pageA.locator('#online-chat-input').fill(chatText);
      await pageA.locator('#btn-chat-send').click();
      await expect(pageB.locator('.chat-message-body', { hasText: chatText })).toHaveCount(
        1,
        { timeout: 30_000 },
      );

      // The inviter is always White in a direct friend match.
      await squareLocator(pageA, 'e2').click();
      await squareLocator(pageA, 'e4').click();
      await expect(squareLocator(pageA, 'e4').locator('.piece')).toHaveCount(1);
      await expect(squareLocator(pageB, 'e4').locator('.piece')).toHaveCount(1, { timeout: 30_000 });
      await expect(squareLocator(pageB, 'e2').locator('.piece')).toHaveCount(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

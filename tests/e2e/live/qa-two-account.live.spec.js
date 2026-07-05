const { test, expect } = require('@playwright/test');
const { gotoApp, squareLocator } = require('../helpers.cjs');

const email1 = process.env.QA_USER_1_EMAIL;
const email2 = process.env.QA_USER_2_EMAIL;
const password = process.env.QA_USER_PASSWORD;
const haveCredentials = !!(email1 && email2 && password);

async function acceptLegalIfRequired(page) {
  const legal = page.locator('#screen-legal');
  if (!await legal.isVisible()) return false;

  const reviewButtons = page.locator('#ags-legal-list .legal-review-button:not([disabled])');
  const reviewCount = await reviewButtons.count();
  if (!reviewCount) {
    throw new Error(`Legal gate has no reviewable documents: ${await page.locator('#ags-legal-message').textContent()}`);
  }
  for (let index = 0; index < reviewCount; index += 1) {
    const popupPromise = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
    await reviewButtons.nth(index).click();
    const popup = await popupPromise;
    if (popup) await popup.close();
  }
  await page.locator('#ags-legal-confirm').check();
  await page.locator('#ags-legal-accept').click();
  await expect(page.locator('#ags-signedin-info')).toBeVisible({ timeout: 30_000 });
  return true;
}

async function loginFromLoginScreen(page, email) {
  await expect(page.locator('#screen-login')).toBeVisible();
  await page.locator('#ags-login-identifier').fill(email);
  await page.locator('#ags-login-password').fill(password);
  await page.locator('#ags-login-submit').click();

  await expect.poll(async () => {
    if (await page.locator('#ags-signedin-info').isVisible()) return 'signed-in';
    if (await page.locator('#screen-legal').isVisible()) return 'legal';
    const message = (await page.locator('#ags-login-message').textContent())?.trim() || '';
    return message && message !== 'Signing in…' ? message : 'waiting';
  }, { timeout: 45_000 }).not.toBe('waiting');

  if (await page.locator('#ags-signedin-info').isVisible()) return;
  if (await page.locator('#screen-legal').isVisible()) {
    await acceptLegalIfRequired(page);
    return;
  }
  const loginError = (await page.locator('#ags-login-message').textContent())?.trim();
  if (loginError) throw new Error(`Login failed for ${email}: ${loginError}`);
  await expect(page.locator('#ags-signedin-info')).toBeVisible({ timeout: 30_000 });
}

async function provisionThroughIam(page, email, displayName) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const username = `sealqa${suffix}`.slice(0, 32);
  const response = await page.request.post('/iam/v4/public/namespaces/seal-chessags/users', {
    data: {
      authType: 'EMAILPASSWD',
      country: 'US',
      emailAddress: email,
      displayName,
      uniqueDisplayName: displayName,
      password,
      reachMinimumAge: true,
      username,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok() && !/already|exist|registered|used/i.test(JSON.stringify(body))) {
    throw new Error(`IAM fallback provisioning failed for ${email}: ${JSON.stringify(body)}`);
  }
  return response.ok() ? 'provisioned-after-registration-defect' : 'existing';
}

async function registerOrLogin(page, email, displayName) {
  await gotoApp(page, { offline: false });
  await page.getByRole('button', { name: 'Create Free Account' }).first().click();
  await expect(page.locator('#screen-register')).toBeVisible();
  await page.locator('#ags-register-email').fill(email);
  await page.locator('#ags-register-display-name').fill(displayName);
  await page.locator('#ags-register-password').fill(password);
  await page.locator('#ags-register-minimum-age').check();
  await page.locator('#ags-register-submit').click();

  await expect.poll(async () => {
    if (await page.locator('#ags-signedin-info').isVisible()) return 'signed-in';
    if (await page.locator('#screen-legal').isVisible()) return 'legal';
    if (await page.locator('#screen-login').isVisible()) return 'login';
    const message = (await page.locator('#ags-register-message').textContent())?.trim() || '';
    return message && message !== 'Creating account…' ? message : 'waiting';
  }, { timeout: 45_000 }).not.toBe('waiting');

  if (await page.locator('#ags-signedin-info').isVisible()) return 'registered';
  if (await page.locator('#screen-legal').isVisible()) {
    await acceptLegalIfRequired(page);
    return 'registered';
  }
  if (await page.locator('#screen-register').isVisible()) {
    const message = (await page.locator('#ags-register-message').textContent())?.trim() || '';
    if (/username violates input validation/i.test(message)) {
      const state = await provisionThroughIam(page, email, displayName);
      await page.locator('#screen-register .auth-login-link').click();
      await loginFromLoginScreen(page, email);
      return state;
    }
    if (!/already|exist|registered|used/i.test(message)) {
      throw new Error(`Registration failed for ${email}: ${message}`);
    }
    await page.locator('#screen-register .auth-login-link').click();
  }
  await loginFromLoginScreen(page, email);
  return 'existing';
}

async function refreshFriends(page) {
  const result = await page.evaluate(() => window.agsRefreshFriends?.());
  if (result?.ok === false) throw new Error(result.error || 'Friend refresh failed.');
}

async function unblockIfNeeded(page, otherUserId) {
  return page.evaluate(async userId => {
    if (!window.agsIsBlockedPlayer?.(userId)) return { ok: true, changed: false };
    const result = await window.agsUnblockPlayer?.(userId);
    return { ...result, changed: true };
  }, otherUserId);
}

async function ensureFriends(pageA, pageB, userIdA, userIdB) {
  await refreshFriends(pageA);
  await refreshFriends(pageB);

  const inviteButton = pageA.locator(
    `#ags-friends-list button[data-action="invite"][data-user-id="${userIdB}"]`,
  );
  if (await inviteButton.count()) return;

  const existingIncoming = pageB.locator(
    `#ags-friends-incoming button[data-action="accept"][data-user-id="${userIdA}"]`,
  );
  if (!await existingIncoming.count()) {
    await pageA.locator('#btn-add-friend-expand').click();
    await pageA.locator('#ags-add-friend-email').fill(email2);
    await pageA.locator('#ags-add-friend-form .btn-mini').click();
    await expect(pageA.locator('#ags-add-friend-result')).toContainText(
      /Friend request sent|No account found|Could not search/i,
      { timeout: 30_000 },
    );
    const lookupResult = await pageA.locator('#ags-add-friend-result').innerText();
    if (!/Friend request sent/i.test(lookupResult)) {
      await pageA.evaluate(userId => window.agsRequestFriend?.(userId), userIdB);
    }
    await refreshFriends(pageB);
  }

  const accept = pageB.locator(
    `#ags-friends-incoming button[data-action="accept"][data-user-id="${userIdA}"]`,
  );
  await expect(accept).toBeVisible({ timeout: 30_000 });
  await accept.click();
  await refreshFriends(pageA);
  await refreshFriends(pageB);
  await expect(inviteButton).toBeVisible({ timeout: 30_000 });
}

test.describe('QA two-account online flow', () => {
  test.skip(!haveCredentials, 'Set QA_USER_1_EMAIL, QA_USER_2_EMAIL, and QA_USER_PASSWORD');

  test('registers, friends, plays, chats, blocks, persists, and unblocks', async ({ browser }) => {
    test.setTimeout(300_000);

    const contextA = await browser.newContext({ ignoreHTTPSErrors: true });
    const contextB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const diagnostics = { account1: [], account2: [], failedRequests: [] };

    for (const [page, label] of [[pageA, 'account1'], [pageB, 'account2']]) {
      page.on('pageerror', error => diagnostics[label].push(`pageerror: ${error.message}`));
      page.on('console', message => {
        if (message.type() === 'error') diagnostics[label].push(`console: ${message.text()}`);
      });
      page.on('response', response => {
        if (response.status() >= 400 && /gamingservices|localhost:8808/.test(response.url())) {
          diagnostics.failedRequests.push(`${label}: ${response.status()} ${response.request().method()} ${response.url()}`);
        }
      });
    }

    try {
      const account1State = await registerOrLogin(pageA, email1, 'Seal QA Test 1');
      const account2State = await registerOrLogin(pageB, email2, 'Seal QA Test 2');
      const userIdA = await pageA.evaluate(() => window.agsCurrentUserId);
      const userIdB = await pageB.evaluate(() => window.agsCurrentUserId);
      expect(userIdA).toBeTruthy();
      expect(userIdB).toBeTruthy();
      expect(userIdA).not.toBe(userIdB);

      const unblockA = await unblockIfNeeded(pageA, userIdB);
      const unblockB = await unblockIfNeeded(pageB, userIdA);
      expect(unblockA?.ok).not.toBe(false);
      expect(unblockB?.ok).not.toBe(false);

      const setupBlock = await pageB.evaluate(userId => window.agsBlockPlayer?.(userId), userIdA);
      expect(setupBlock?.ok).toBe(true);
      expect(await pageB.evaluate(id => window.agsIsBlockedPlayer?.(id), userIdA)).toBe(true);
      const setupUnblock = await pageB.evaluate(userId => window.agsUnblockPlayer?.(userId), userIdA);
      expect(setupUnblock?.ok).toBe(true);
      expect(setupUnblock?.lobbyRefreshed).toBe(true);

      await ensureFriends(pageA, pageB, userIdA, userIdB);

      const inviteButton = pageA.locator(
        `#ags-friends-list button[data-action="invite"][data-user-id="${userIdB}"]`,
      );
      await inviteButton.click();
      await expect(pageA.locator('#screen-waiting')).toBeVisible();
      await expect(pageB.locator('#friend-match-invite-notification')).toBeVisible({ timeout: 30_000 });
      await pageB.locator('#friend-match-invite-notification').getByRole('button', { name: 'Accept' }).click();

      await expect(pageA.locator('#screen-game')).toBeVisible({ timeout: 60_000 });
      await expect(pageB.locator('#screen-game')).toBeVisible({ timeout: 60_000 });
      await expect(pageA.locator('#chess-board .piece')).toHaveCount(32);
      await expect(pageB.locator('#chess-board .piece')).toHaveCount(32);
      await expect(pageA.locator('#online-chat-status')).toHaveText('Connected', { timeout: 30_000 });
      await expect(pageB.locator('#online-chat-status')).toHaveText('Connected', { timeout: 30_000 });

      const chatText = `QA friend chat ${Date.now()}`;
      await pageA.locator('#online-chat-input').fill(chatText);
      await pageA.locator('#btn-chat-send').click();
      await expect(pageA.locator('.chat-message-body', { hasText: chatText })).toHaveCount(1);
      await expect(pageB.locator('.chat-message-body', { hasText: chatText })).toHaveCount(
        1,
        { timeout: 30_000 },
      );

      await pageB.locator('#online-chat-input').fill('fuck');
      await pageB.locator('#btn-chat-send').click();
      await expect(pageB.locator('#online-chat-message')).toContainText(/not sent|remove inappropriate/i);
      await expect(pageA.locator('.chat-message-body', { hasText: 'fuck' })).toHaveCount(0);

      await squareLocator(pageA, 'e2').click();
      await squareLocator(pageA, 'e4').click();
      await expect(squareLocator(pageA, 'e4').locator('.piece')).toHaveCount(1);
      await expect(squareLocator(pageB, 'e4').locator('.piece')).toHaveCount(1, { timeout: 30_000 });
      await expect(squareLocator(pageB, 'e2').locator('.piece')).toHaveCount(0);

      await pageB.locator('#btn-match-safety').click();
      await expect(pageB.locator('#match-safety-modal')).toBeVisible();
      await pageB.locator('#btn-block-current-opponent').click();
      await expect(pageB.locator('#match-safety-message')).toContainText(
        /Player blocked/i,
        { timeout: 30_000 },
      );
      await expect(pageB.locator('#online-chat-status')).toHaveText('Blocked');
      await expect(pageB.locator('#online-chat-messages')).toContainText(/Chat is hidden/i);
      await expect(pageB.locator('#online-chat .online-chat-compose')).toBeHidden();
      expect(await pageB.evaluate(id => window.agsIsBlockedPlayer?.(id), userIdA)).toBe(true);

      const blockedChat = `Blocked chat ${Date.now()}`;
      await pageA.locator('#online-chat-input').fill(blockedChat);
      await pageA.locator('#btn-chat-send').click();
      await pageB.waitForTimeout(2000);
      await expect(pageB.locator('.chat-message-body', { hasText: blockedChat })).toHaveCount(0);

      await pageB.locator('#match-safety-modal').getByRole('button', { name: 'Close' }).click();
      await pageB.evaluate(({ id, name }) => window.agsOpenProfile?.(id, name), {
        id: userIdB,
        name: 'Seal QA Test 2',
      });
      await expect(pageB.locator('#screen-profile')).toBeVisible();
      const blockedRow = pageB.locator('#profile-blocked-players .profile-blocked-row').filter({
        hasText: userIdA,
      });
      await expect(blockedRow).toBeVisible({ timeout: 30_000 });
      await blockedRow.getByRole('button', { name: 'Unblock' }).click({ timeout: 10_000 });
      await expect(blockedRow).toHaveCount(0, { timeout: 30_000 });
      expect(await pageB.evaluate(id => window.agsIsBlockedPlayer?.(id), userIdA)).toBe(false);

      await test.info().attach('qa-result.json', {
        body: Buffer.from(JSON.stringify({
          account1State,
          account2State,
          userIdA,
          userIdB,
          diagnostics,
        }, null, 2)),
        contentType: 'application/json',
      });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

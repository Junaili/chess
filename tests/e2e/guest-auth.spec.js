const { test, expect } = require('@playwright/test');
const { APP_PATH } = require('./helpers.cjs');

const GUEST_USER_ID = 'guest-user-id';
const GUEST_PROFILE = {
  authType: 'DEVICE',
  bans: [],
  country: 'US',
  createdAt: '2026-08-15T00:00:00Z',
  deletionStatus: false,
  displayName: '',
  emailAddress: '',
  emailVerified: false,
  enabled: true,
  lastDateOfBirthChangedTime: '',
  lastEnabledChangedTime: '2026-08-15T00:00:00Z',
  namespace: 'chess',
  namespaceRoles: [],
  permissions: [],
  phoneVerified: false,
  roles: [],
  uniqueDisplayName: '',
  userId: GUEST_USER_ID,
  userName: null,
};

function tokenResponse(attempt) {
  return {
    access_token: `guest-access-token-${attempt}`,
    expires_in: 3600,
    namespace: 'chess',
    permissions: [],
    refresh_expires_in: 86400,
    refresh_token: `guest-refresh-token-${attempt}`,
    scope: 'commerce account social publishing analytics',
    token_type: 'Bearer',
    user_id: GUEST_USER_ID,
  };
}

// A pending, mandatory Terms-of-Service eligibility — same shape AGS Legal
// returns for a real registered account. Used to prove that guest login
// doesn't route through the legal-acceptance gate (dev-plan: guests never
// see it — device-ID login still returns a normal IAM token, so without an
// explicit guest bypass AGS Legal would flag it exactly like it would for
// any registered account).
const PENDING_TOS_ELIGIBILITY = {
  isAccepted: false,
  isMandatory: true,
  policyId: 'policy-tos',
  policyName: 'Terms of Service',
  policyVersions: [{
    id: 'version-1',
    displayVersion: '1.0',
    isInEffect: true,
    localizedPolicyVersions: [{
      id: 'localized-1',
      localeCode: 'en-US',
      isDefaultSelection: true,
      attachmentLocation: 'tos.md',
    }],
  }],
};

async function mockGuestBackend(page, { failFirstGrant = false, pendingLegalDocuments = false } = {}) {
  const deviceIds = [];
  const accountOnlyRequests = [];
  let grantAttempts = 0;

  await page.addInitScript(() => {
    localStorage.setItem('chess_privacy_preferences_v1', JSON.stringify({
      analytics: false,
      decided: true,
      updatedAt: new Date().toISOString(),
    }));
  });

  await page.route('**/iam/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path.endsWith('/iam/v4/oauth/platforms/device/token')) {
      grantAttempts += 1;
      const body = new URLSearchParams(request.postData() || '');
      const deviceId = body.get('device_id');
      deviceIds.push(deviceId);
      expect(deviceId).toMatch(/^chess-/);
      expect(request.headers()['device-id']).toBe(deviceId);
      expect(body.get('createHeadless')).toBe('true');
      expect(body.get('skipSetCookie')).toBe('true');
      if (failFirstGrant && grantAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'temporary backend failure' }),
        });
        return;
      }
      await route.fulfill({ status: 200, json: tokenResponse(grantAttempts) });
      return;
    }

    if (path.endsWith('/iam/v3/public/users/me')) {
      await route.fulfill({ status: 200, json: GUEST_PROFILE });
      return;
    }

    if (path.endsWith('/iam/v3/oauth/revoke') || path.endsWith('/iam/v3/logout')) {
      await route.fulfill({ status: 204 });
      return;
    }

    await route.fulfill({ status: 404, json: { message: `Unexpected IAM request: ${path}` } });
  });

  await page.route('**/agreement/**', route => {
    const url = route.request().url();
    if (url.includes('/eligibilities/namespaces/')) {
      return route.fulfill({ status: 200, json: pendingLegalDocuments ? [PENDING_TOS_ELIGIBILITY] : [] });
    }
    return route.fulfill({ status: 200, json: [] });
  });
  for (const pattern of [
    '**/friends/**',
    '**/leaderboard/**',
    '**/social/**',
    '**/achievement/**',
    '**/basic/**',
  ]) {
    await page.route(pattern, route => {
      accountOnlyRequests.push(route.request().url());
      return route.fulfill({ status: 403, json: { message: 'account-only endpoint' } });
    });
  }
  await page.route('**/match2/**', async route => {
    const method = route.request().method();
    if (method === 'POST') {
      await route.fulfill({
        status: 201,
        json: { matchTicketID: 'guest-ticket', queueTime: 0 },
      });
      return;
    }
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        json: {
          isActive: true,
          matchFound: false,
          matchPool: 'chess-quickmatch',
          matchTicketID: 'guest-ticket',
          sessionID: '',
        },
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });

  return { accountOnlyRequests, deviceIds, grantAttempts: () => grantAttempts };
}

async function submitOnlineGuest(page, name = 'Guest Knight') {
  await page.locator('#ags-open-online-guest').click();
  await page.locator('#online-guest-name-input').fill(name);
  await page.locator('#ags-online-guest-submit').click();
}

test.describe('AGS Device ID guest login', () => {
  test('starts online matchmaking, gates account features, and reuses the device identity', async ({ page }) => {
    const backend = await mockGuestBackend(page);
    await page.goto(APP_PATH);
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');

    await submitOnlineGuest(page);
    await expect(page.locator('#screen-waiting')).toBeVisible();
    await expect(page.locator('#waiting-title')).toHaveText('Finding opponent…');

    await page.locator('#btn-waiting-cancel').click();
    await expect(page.locator('#screen-home')).toBeVisible();
    await expect(page.locator('#screen-home')).toHaveClass(/guest-session/);
    await expect(page.locator('#ags-signedin-greeting')).toHaveText('Playing online as guest');
    await expect(page.locator('#btn-play-random')).toBeVisible();
    await expect(page.locator('#btn-single-player')).toBeHidden();
    await expect(page.locator('#btn-my-account')).toBeHidden();
    await expect(page.locator('#btn-edit-name')).toBeHidden();
    await expect(page.locator('#home-leaderboard-panel')).toBeHidden();
    expect(backend.accountOnlyRequests).toEqual([]);

    await Promise.all([
      page.waitForEvent('framenavigated'),
      page.locator('#btn-signout').click(),
    ]);
    await expect(page.locator('#ags-open-online-guest')).toBeVisible();

    await submitOnlineGuest(page, 'Guest Knight Returns');
    await expect(page.locator('#screen-waiting')).toBeVisible();
    expect(backend.deviceIds).toHaveLength(2);
    expect(backend.deviceIds[1]).toBe(backend.deviceIds[0]);
    expect(backend.accountOnlyRequests).toEqual([]);
  });

  test('shows a safe retryable error when the device grant temporarily fails', async ({ page }) => {
    const backend = await mockGuestBackend(page, { failFirstGrant: true });
    await page.goto(APP_PATH);
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');

    await submitOnlineGuest(page);
    await expect(page.locator('#ags-online-guest-message')).toContainText(/could not sign in as guest/i);
    await expect(page.locator('#ags-online-guest-submit')).toBeEnabled();

    await page.locator('#ags-online-guest-submit').click();
    await expect(page.locator('#screen-waiting')).toBeVisible();
    expect(backend.grantAttempts()).toBe(2);
  });

  test('skips the legal-acceptance gate even when AGS reports a pending mandatory agreement', async ({ page }) => {
    await mockGuestBackend(page, { pendingLegalDocuments: true });
    await page.goto(APP_PATH);
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');

    await submitOnlineGuest(page);
    await expect(page.locator('#screen-waiting')).toBeVisible();
    await expect(page.locator('#screen-legal')).not.toHaveClass(/active/);
  });
});

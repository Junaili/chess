const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Ethan's Chess Club — offline spec. /club/status is stubbed at the network
// layer (pattern: gus.spec.js's stubGusProfile) and the screen is opened via
// the real window.agsOpenClub() entry point, exercising the actual
// fetchClubStatus -> deriveClubUI -> render pipeline, not just a dev seam.

const FREE_STATUS = {
  active: false, tier: '', source: '', lifetime: false, activeSkus: [],
  coins: 40, canPurchase: true, journalOpen: null, narrativesRemainingToday: 1,
};

const ACTIVE_STATUS = {
  active: true, tier: 'individual', source: 'self', lifetime: false,
  expiresAt: '2026-08-11T00:00:00Z', activeSkus: ['club-individual-monthly'],
  monthlyOrigin: 'stripe', coins: 299, canPurchase: true,
  journalOpen: null, narrativesRemainingToday: null,
};

async function stubClubStatus(page, status) {
  await page.route('**/club/status*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(status),
  }));
}

async function openClub(page) {
  await page.evaluate(() => window.agsOpenClub && window.agsOpenClub());
  await expect(page.locator('#screen-club')).toBeVisible();
}

test.describe('Ethan\'s Chess Club', () => {
  test('free user sees purchase buttons for all four plans, no covered state', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatus(page, FREE_STATUS);
    await openClub(page);

    await expect(page.locator('#club-status-line')).toContainText('40 🪙');
    const cards = page.locator('.club-plan-card');
    await expect(cards).toHaveCount(4);
    // None owned yet — every card shows a live Buy button, not "Included".
    await expect(page.locator('.club-plan-included')).toHaveCount(0);
    for (const btn of await page.locator('[data-club-buy]').all()) {
      await expect(btn).toBeEnabled();
    }
  });

  test('active member sees "Included" on their own plan, coin balance, and manage-subscription', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatus(page, ACTIVE_STATUS);
    await openClub(page);

    await expect(page.locator('#club-status-line')).toContainText('You have Club');
    await expect(page.locator('#club-status-line')).toContainText('299 🪙');
    const ownedCard = page.locator('.club-plan-card.covered');
    await expect(ownedCard).toHaveCount(1);
    await expect(ownedCard.locator('.club-plan-included')).toBeVisible();
    // Family tier is NOT covered by an individual plan — still purchasable.
    const otherButtons = page.locator('[data-club-buy]');
    await expect(otherButtons).toHaveCount(3); // 4 SKUs - 1 covered
    await expect(page.locator('#btn-club-manage')).toBeVisible();
  });

  test('Apple-billed member does not see the web manage-subscription button', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatus(page, { ...ACTIVE_STATUS, monthlyOrigin: 'apple' });
    await openClub(page);

    await expect(page.locator('#club-status-line')).toContainText('You have Club');
    await expect(page.locator('#btn-club-manage')).toBeHidden();
  });

  test('child session sees zero purchase UI anywhere on the Club screen', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatus(page, FREE_STATUS);
    await page.evaluate(status => {
      window.agsRenderClubForTesting(status, { isChildSession: true });
      window.showScreen('club');
    }, FREE_STATUS);
    await expect(page.locator('#screen-club')).toBeVisible();

    // Hard rule (dev-plan §0.2): no [data-purchase-ui] element anywhere,
    // no buy buttons, no upsell taps.
    await expect(page.locator('#screen-club [data-purchase-ui]')).toHaveCount(0);
    await expect(page.locator('#screen-club [data-club-buy]')).toHaveCount(0);
    await expect(page.locator('#club-message')).toContainText('Ask your parent');
  });

  test('child session home card is a static line with no tap action', async ({ page }) => {
    await gotoApp(page);
    // The home leaderboard column (which the Club card lives in) is
    // guest-hidden via #screen-home:not(.signed-in) — simulate the
    // signed-in DOM state the same way updateAuthUI(true, ...) does.
    await page.evaluate(() => {
      document.getElementById('screen-home')?.classList.add('signed-in');
      const panel = document.getElementById('home-leaderboard-panel');
      if (panel) panel.style.display = '';
    });
    await page.evaluate(status => window.agsRenderClubForTesting(status, { isChildSession: true }), FREE_STATUS);

    await expect(page.locator('#club-home-static')).toBeVisible();
    await expect(page.locator('#club-home-static')).toContainText('Ask your parent');
    await expect(page.locator('#btn-club-open')).toBeHidden();
  });

  test('adult home card offers a working "Open" entry point', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      document.getElementById('screen-home')?.classList.add('signed-in');
      const panel = document.getElementById('home-leaderboard-panel');
      if (panel) panel.style.display = '';
    });
    await page.evaluate(status => window.agsRenderClubForTesting(status, { isChildSession: false }), FREE_STATUS);

    await expect(page.locator('#btn-club-open')).toBeVisible();
    await expect(page.locator('#club-home-static')).toBeHidden();
  });

  test('adult family member with inherited access sees "via your family" on the Club screen, no purchase grid', async ({ page }) => {
    await gotoApp(page);
    const FAMILY_GUARDIAN_STATUS = {
      active: true, tier: 'family', source: 'family-guardian', lifetime: false,
      expiresAt: '2026-08-11T00:00:00Z', activeSkus: [],
      coins: 120, canPurchase: true, journalOpen: null, narrativesRemainingToday: null,
    };
    await stubClubStatus(page, FAMILY_GUARDIAN_STATUS);
    await openClub(page);

    await expect(page.locator('#club-message')).toContainText('via your family');
    await expect(page.locator('#club-purchase-grid')).toBeHidden();
    await expect(page.locator('#btn-club-manage')).toBeHidden();
    await expect(page.locator('#club-status-line')).toContainText('120 🪙');
  });

  test('web checkout: clicking a plan POSTs /club/web-checkout and redirects to the returned URL', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatus(page, FREE_STATUS);
    let checkoutBody = null;
    await page.route('**/club/web-checkout*', async route => {
      checkoutBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://example.com/checkout-mock' }),
      });
    });
    // Intercept the redirect target so the test never leaves the mocked sandbox.
    await page.route('https://example.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>mock checkout</body></html>',
    }));
    await openClub(page);

    await page.locator('[data-club-buy="club-individual-monthly"]').click();
    await page.waitForURL('https://example.com/checkout-mock');
    expect(checkoutBody).toEqual({ sku: 'club-individual-monthly' });
  });

  test('checkout failure shows an inline message and re-enables the button', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatus(page, FREE_STATUS);
    await page.route('**/club/web-checkout*', route => route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'checkout_failed', message: 'Could not start checkout. Try again.' }),
    }));
    await openClub(page);

    const btn = page.locator('[data-club-buy="club-individual-monthly"]');
    await btn.click();
    await expect(page.locator('#club-message')).toContainText('Could not start checkout');
    await expect(btn).toBeEnabled();
  });

  test('lifetime member with an active monthly gets the double-subscription cancel notice', async ({ page }) => {
    await gotoApp(page);
    await stubClubStatus(page, {
      ...ACTIVE_STATUS,
      lifetime: true,
      activeSkus: ['club-individual-lifetime', 'club-individual-monthly'],
    });
    await openClub(page);

    await expect(page.locator('#club-message')).toContainText('cancel your monthly plan');
  });

  test('native (iPad) with the IAP plugin not ready shows disabled buttons and a not-ready note', async ({ page }) => {
    await gotoApp(page);
    // Set AFTER navigation: the app's own bundle only defines window.Capacitor
    // once its module graph evaluates, which happens during/after the
    // navigation itself and would clobber an addInitScript-set mock.
    await page.evaluate(() => {
      window.Capacitor = { ...(window.Capacitor || {}), isNativePlatform: () => true };
    });
    await stubClubStatus(page, FREE_STATUS);
    await openClub(page);

    await expect(page.locator('#club-message')).toContainText('isn\'t ready yet');
    for (const btn of await page.locator('[data-club-buy]').all()) {
      await expect(btn).toBeDisabled();
    }
    await expect(page.locator('#btn-club-restore')).toBeVisible();
  });

  test('native (iPad) with the IAP plugin ready shows working, enabled purchase buttons', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.Capacitor = { ...(window.Capacitor || {}), isNativePlatform: () => true };
    });
    await stubClubStatus(page, FREE_STATUS);
    await page.evaluate(() => window.agsSetClubNativeIAPReadyForTesting(true));
    await openClub(page);

    await expect(page.locator('#club-message')).toBeHidden();
    for (const btn of await page.locator('[data-club-buy]').all()) {
      await expect(btn).toBeEnabled();
    }
    await expect(page.locator('#btn-club-restore')).toBeVisible();
  });

  test('native purchaseNative() orders the loaded Apple product offer, never a web checkout', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.Capacitor = { ...(window.Capacitor || {}), isNativePlatform: () => true };
    });
    let webCheckoutCalled = false;
    await page.route('**/club/web-checkout*', route => {
      webCheckoutCalled = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://example.com/should-not-be-used' }) });
    });
    await page.evaluate(() => {
      window.orderedProductIds = [];
      window.agsSetClubNativePurchaseStoreForTesting({
        store: {
          get: (id, platform) => ({
            getOffer: () => ({ order: () => { window.orderedProductIds.push({ id, platform }); return Promise.resolve(); } }),
          }),
        },
        Platform: { APPLE_APPSTORE: 'ios-appstore' },
      });
      window.agsSetClubNativeIAPReadyForTesting(true);
    });
    await stubClubStatus(page, FREE_STATUS);
    await openClub(page);

    await page.locator('[data-club-buy="club-individual-monthly"]').click();
    await expect.poll(() => page.evaluate(() => window.orderedProductIds)).toEqual([{
      id: 'io.github.junaili.chess.club.individual.monthly',
      platform: 'ios-appstore',
    }]);
    expect(webCheckoutCalled).toBe(false);
  });

  test('native validator extracts the StoreKit 2 transaction id from its signed payload', async ({ page }) => {
    await gotoApp(page);
    const jws = `header.${Buffer.from(JSON.stringify({ transactionId: '1234567890' })).toString('base64url')}.signature`;
    await expect.poll(() => page.evaluate(value => window.agsAppleTransactionIdForTesting({
      transaction: { type: 'apple-sk2', jwsRepresentation: value },
    }), jws)).toBe('1234567890');
  });

  test('a successful native transaction refreshes status and shows the welcome toast', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.Capacitor = { ...(window.Capacitor || {}), isNativePlatform: () => true };
    });
    let statusCalls = 0;
    await page.route('**/club/status*', route => {
      statusCalls++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statusCalls === 1 ? FREE_STATUS : ACTIVE_STATUS) });
    });
    await page.evaluate(() => window.agsSetClubNativeIAPReadyForTesting(true));
    await openClub(page);
    await expect(page.locator('#club-status-line')).toContainText('40 🪙');

    await page.evaluate(() => window.agsSimulateNativeTransactionForTesting(true));
    await expect(page.locator('#club-toast')).toHaveClass(/show/);
    await expect(page.locator('#club-toast-text')).toContainText('Welcome to Club');
    await expect(page.locator('#club-status-line')).toContainText('299 🪙');
  });

  test('a cross-account conflict on native shows the specific "different player profile" message', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.Capacitor = { ...(window.Capacitor || {}), isNativePlatform: () => true };
    });
    await stubClubStatus(page, FREE_STATUS);
    await page.evaluate(() => window.agsSetClubNativeIAPReadyForTesting(true));
    await openClub(page);

    await page.evaluate(() => window.agsSimulateNativeTransactionForTesting(false, {
      conflict: true,
      message: 'This purchase belongs to a different player profile. Sign in with the account that made the purchase.',
    }));
    await expect(page.locator('#club-message')).toContainText('different player profile');
  });

  test('Restore Purchases button calls store.restorePurchases() and force-refreshes status', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.Capacitor = { ...(window.Capacitor || {}), isNativePlatform: () => true };
    });
    let statusCalls = 0;
    await page.route('**/club/status*', route => {
      statusCalls++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statusCalls === 1 ? FREE_STATUS : ACTIVE_STATUS) });
    });
    await page.evaluate(() => {
      window.restoreCalled = false;
      window.agsSetClubNativePurchaseStoreForTesting({
        store: { restorePurchases: () => { window.restoreCalled = true; return Promise.resolve(); } },
      });
      window.agsSetClubNativeIAPReadyForTesting(true);
    });
    await openClub(page);

    await page.locator('#btn-club-restore').click();
    await expect.poll(() => page.evaluate(() => window.restoreCalled)).toBe(true);
    await expect(page.locator('#club-status-line')).toContainText('299 🪙');
  });

  test('child session on native never sees Restore Purchases either', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.Capacitor = { ...(window.Capacitor || {}), isNativePlatform: () => true };
    });
    await stubClubStatus(page, FREE_STATUS);
    await page.evaluate(() => window.agsSetClubNativeIAPReadyForTesting(true));
    await page.evaluate(status => {
      window.agsRenderClubForTesting(status, { isChildSession: true });
      window.showScreen('club');
    }, FREE_STATUS);

    await expect(page.locator('#btn-club-restore')).toBeHidden();
    await expect(page.locator('#screen-club [data-purchase-ui]')).toHaveCount(0);
  });
});

test.describe('Journal history depth gating', () => {
  function freshHistory() {
    return [];
  }

  async function openJournalTab(page) {
    await page.evaluate(() => {
      window.showScreen('profile');
      document.querySelector('[data-profile-tab="journal"]').hidden = false;
      window.agsShowProfileTab('journal');
    });
  }

  function fakeRecord(entryCount) {
    return {
      entries: Array.from({ length: entryCount }, (_, i) => ({
        id: `e${i}`,
        createdAt: new Date(2026, 0, i + 1).toISOString(),
        window: '24h',
        record: { wins: 1, losses: 0, draws: 0 },
        gamesAnalyzed: 1,
        gamesInWindow: 1,
        accuracy: {},
        coach: { headline: `Entry ${i}` },
        keyMoments: {},
        puzzles: [],
        games: {},
      })),
      gradeCache: {},
    };
  }

  async function stubCloudSaveWithRecord(page, record) {
    await page.unroute('**/cloudsave/**');
    await page.route('**/cloudsave/**', route => {
      const isJournal = route.request().url().includes('chess-journal');
      if (route.request().method() === 'GET' && isJournal) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: record }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
  }

  test('free tier sees only the 5 most recent entries plus a Club upsell card', async ({ page }) => {
    await gotoApp(page);
    await stubCloudSaveWithRecord(page, fakeRecord(8));
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('me', history, {
      isChildSession: false, clubActive: false, journalOpen: null, narrativesRemainingToday: 1,
    }), freshHistory());

    await expect(page.locator('.journal-entry')).toHaveCount(5);
    await expect(page.locator('#journal-entries .profile-history-locked')).toContainText('3 more entries');
    await expect(page.locator('#journal-entries .profile-history-locked [data-click]')).toBeVisible();
  });

  test('Club member sees the full history with no locked card', async ({ page }) => {
    await gotoApp(page);
    await stubCloudSaveWithRecord(page, fakeRecord(8));
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('me', history, {
      isChildSession: false, clubActive: true, journalOpen: null, narrativesRemainingToday: null,
    }), freshHistory());

    await expect(page.locator('.journal-entry')).toHaveCount(8);
    await expect(page.locator('#journal-entries .profile-history-locked')).toHaveCount(0);
  });

  test('child session sees the free-tier limit but with no purchase-UI marker on the locked card', async ({ page }) => {
    await gotoApp(page);
    await stubCloudSaveWithRecord(page, fakeRecord(8));
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('kid', history, {
      isChildSession: true, clubActive: false, journalOpen: null, narrativesRemainingToday: 1,
    }), freshHistory());

    await expect(page.locator('.journal-entry')).toHaveCount(5);
    await expect(page.locator('#journal-entries [data-purchase-ui]')).toHaveCount(0);
    await expect(page.locator('#journal-entries .profile-history-locked')).toContainText('Ask your parent');
  });
});

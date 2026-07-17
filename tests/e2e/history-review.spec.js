const { test, expect } = require('@playwright/test');
const { gotoApp, startVsComputer, playMove } = require('./helpers.cjs');

// History enrichment (dev-plan §9, M2). Offline spec — match history is
// stubbed at the network layer (pattern: journal.spec.js's stubCloudSave),
// and the flag is turned on via the DEV-only agsSetLearningFlagsForTesting
// seam (src/main.js, added in M0) so the V2 renderer runs without a real
// env build.

function fixtureMatch(overrides = {}) {
  return {
    id: overrides.id || `m-${Math.random().toString(36).slice(2, 8)}`,
    mode: 'online',
    result: 'win',
    endReason: 'checkmate',
    myColor: 'white',
    opponentName: 'Rex',
    whiteName: 'Me',
    blackName: 'Rex',
    endedAt: '2026-07-09T10:00:00Z',
    durationMs: 90000,
    moves: [
      { fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' },
      { fr: 1, fc: 4, toR: 3, toC: 4, promType: 'queen' },
    ],
    ...overrides,
  };
}

function fixtureMatches(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => fixtureMatch({ id: `m${i}`, ...overrides }));
}

async function stubMatchHistoryRoute(page, matchesByUserId) {
  await page.unroute('**/cloudsave/**');
  await page.route('**/cloudsave/**', async route => {
    const url = route.request().url();
    if (!url.includes('chess-match-history')) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    const userId = Object.keys(matchesByUserId).find(id => url.includes(id));
    const matches = userId ? matchesByUserId[userId] : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: { matches } }) });
  });
}

// Signs in as `currentUserId` once, then opens `userId`'s profile — the two
// may differ (viewing a friend) or match (viewing your own).
async function signInAndOpenProfile(page, currentUserId, userId, displayName = 'Me') {
  // gotoApp() only waits for #screen-home to be visible, which can render
  // slightly before main.js finishes its synchronous window.agsX = ...
  // assignments (observed intermittently, more often on WebKit) — wait for
  // the specific function this helper needs before calling it.
  await page.waitForFunction(() => typeof window.agsOpenProfile === 'function', { timeout: 15000 });
  await page.evaluate(({ currentUserId, userId, displayName }) => {
    window.agsSetLearningFlagsForTesting?.({ historyV2: true });
    window.agsSetCurrentUserIdForTesting?.(currentUserId);
    window.agsOpenProfile(userId, displayName);
  }, { currentUserId, userId, displayName });
  await page.evaluate(() => window.agsShowProfileTab('history'));
}

// ─── Review mode (dev-plan §10, M3) ────────────────────────────────────────

// 1.e4 e5 2.Qh5 Nc6 3.Qxh7?? Rxh7 — White hangs the queen for a pawn on
// ply 4: a guaranteed "Better move available" at any search depth, so this
// is the reliable own-blunder review fixture (same game journal.spec.js uses).
const REVIEW_BLUNDER_GAME = {
  id: 'review-blunder',
  mode: 'online',
  result: 'loss',
  endReason: 'resignation',
  myColor: 'white',
  opponentName: 'Rex',
  whiteName: 'Me',
  blackName: 'Rex',
  endedAt: '2026-07-09T10:00:00Z',
  durationMs: 90000,
  moves: [
    { fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' }, // e4
    { fr: 1, fc: 4, toR: 3, toC: 4, promType: 'queen' }, // e5
    { fr: 7, fc: 3, toR: 3, toC: 7, promType: 'queen' }, // Qh5
    { fr: 0, fc: 1, toR: 2, toC: 2, promType: 'queen' }, // Nc6
    { fr: 3, fc: 7, toR: 1, toC: 7, promType: 'queen' }, // Qxh7?? (ply 4)
    { fr: 0, fc: 7, toR: 1, toC: 7, promType: 'queen' }, // Rxh7
  ],
};

// Same game recorded as Black facing 1.e4: a clean checkmate finish with no
// blunder to flag, for the "calm clean-review summary" scenario.
const REVIEW_CLEAN_WIN_GAME = {
  id: 'review-clean-win',
  mode: 'online',
  result: 'win',
  endReason: 'checkmate',
  myColor: 'white',
  opponentName: 'Maya',
  whiteName: 'Me',
  blackName: 'Maya',
  endedAt: '2026-07-09T10:00:00Z',
  durationMs: 90000,
  moves: [
    { fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' }, // e4
    { fr: 1, fc: 4, toR: 3, toC: 4, promType: 'queen' }, // e5
    { fr: 7, fc: 3, toR: 3, toC: 7, promType: 'queen' }, // Qh5
    { fr: 0, fc: 1, toR: 2, toC: 2, promType: 'queen' }, // Nc6
    { fr: 7, fc: 5, toR: 4, toC: 2, promType: 'queen' }, // Bc4
    { fr: 0, fc: 6, toR: 2, toC: 5, promType: 'queen' }, // Nf6??
    { fr: 3, fc: 7, toR: 1, toC: 5, promType: 'queen' }, // Qxf7#
  ],
};

async function openReviewFromHistory(page, match) {
  await stubMatchHistoryRoute(page, { 'self-player': [match] });
  // signInAndOpenProfile itself calls agsSetLearningFlagsForTesting({ historyV2: true })
  // — the seam REPLACES overrides rather than merging them, so reviewV2 must
  // be set AFTER it runs or this call clobbers it.
  await signInAndOpenProfile(page, 'self-player', 'self-player');
  await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, reviewV2: true }));
  await page.locator('.profile-history-row').first().click();
  await expect(page.locator('#screen-spectator')).toBeVisible();
}

test.describe('Review mode (VITE_LEARNING_REVIEW_V2)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('own blunder fixture opens review on the blunder ply with the Quick Review badge', async ({ page }) => {
    test.slow(); // real engine analysis
    await openReviewFromHistory(page, REVIEW_BLUNDER_GAME);

    await expect(page.locator('#spectator-review-badge')).toBeVisible();
    await expect(page.locator('#spectator-review-badge')).toHaveText('Quick Review');
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 5 / 6', { timeout: 15000 }); // ply 4 = 1-indexed move 5
    await expect(page.locator('#spectator-review-summary')).toContainText('moment', { timeout: 15000 });
  });

  test('black owner sees Black at the bottom of the board', async ({ page }) => {
    test.slow();
    const asBlack = { ...REVIEW_BLUNDER_GAME, id: 'review-black', myColor: 'black' };
    await openReviewFromHistory(page, asBlack);
    await expect(page.locator('#spectator-review-badge')).toBeVisible();

    // The top-left square always shows a rank label (display col 0). White
    // orientation labels it "8"; flipped for Black it must read "1".
    const topLeftRank = page.locator('#spectator-board .square').first().locator('.coord-rank');
    await expect(topLeftRank).toHaveText('1');
  });

  test('white owner (default) keeps White at the bottom', async ({ page }) => {
    test.slow();
    await openReviewFromHistory(page, REVIEW_BLUNDER_GAME);
    const topLeftRank = page.locator('#spectator-board .square').first().locator('.coord-rank');
    await expect(topLeftRank).toHaveText('8');
  });

  test('clicking a move notation jumps directly to that ply', async ({ page }) => {
    test.slow();
    await openReviewFromHistory(page, REVIEW_BLUNDER_GAME);
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 5 / 6', { timeout: 15000 });

    await page.locator('[data-replay-ply="0"]').click();
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 1 / 6');
  });

  test('keyboard navigation moves the ply, but not while a textarea has focus', async ({ page }) => {
    test.slow();
    await openReviewFromHistory(page, REVIEW_BLUNDER_GAME);
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 5 / 6', { timeout: 15000 });

    // Inject a throwaway textarea to prove focus-inside-input suppresses nav.
    await page.evaluate(() => {
      const ta = document.createElement('textarea');
      ta.id = 'review-test-textarea';
      document.body.appendChild(ta);
      ta.focus();
    });
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 5 / 6');

    await page.evaluate(() => {
      document.getElementById('review-test-textarea')?.remove();
      document.activeElement?.blur();
    });
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 4 / 6');
    await page.keyboard.press('Home');
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 1 / 6');
    await page.keyboard.press('End');
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 6 / 6');
  });

  test('Try from here opens a drill at the current position', async ({ page }) => {
    test.slow();
    await openReviewFromHistory(page, REVIEW_BLUNDER_GAME);
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 5 / 6', { timeout: 15000 });

    await page.locator('#spectator-review-try').click();
    await expect(page.locator('#screen-game')).toBeVisible();
    await expect(page.locator('#hint-box')).toBeVisible();
  });

  test('Back returns to the History tab, restored active', async ({ page }) => {
    test.slow();
    await openReviewFromHistory(page, REVIEW_BLUNDER_GAME);
    await expect(page.locator('#spectator-back-btn')).toHaveText('← Back to History');

    await page.locator('#spectator-back-btn').click();
    await expect(page.locator('#screen-profile')).toBeVisible();
    await expect(page.locator('[data-profile-tab="history"]')).toHaveClass(/active/);
  });

  test('a clean game (no blunders) shows a calm clean-review summary', async ({ page }) => {
    test.slow();
    await openReviewFromHistory(page, REVIEW_CLEAN_WIN_GAME);
    await expect(page.locator('#spectator-review-summary')).toContainText('clean game', { timeout: 15000 });
  });

  test('worker analysis failure leaves normal replay usable', async ({ page }) => {
    await stubMatchHistoryRoute(page, { 'self-player': [REVIEW_BLUNDER_GAME] });
    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, reviewV2: true }));
    // Force analyzeMatch to fail before opening the row, so the review
    // session's own analysis call is what fails (dev-plan §10.6). Assigning
    // this now works because prepareSpectatorAnalysis() only creates the
    // real worker client with ||= — it won't clobber a truthy stub.
    await page.evaluate(() => {
      window.chessBackgroundWorker = { analyzeMatch: () => Promise.reject(new Error('boom')) };
    });
    await page.locator('.profile-history-row').first().click();

    await expect(page.locator('#screen-spectator')).toBeVisible();
    await expect(page.locator('#spectator-review-summary')).toHaveText('Quick summary unavailable.', { timeout: 10000 });
    // Replay controls still fully usable.
    await expect(page.locator('#spectator-replay-controls')).toBeVisible();
    await page.locator('[data-replay-ply="0"]').click();
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 1 / 6');
  });

  test('live friend watching shows no review chrome and keeps moves non-interactive', async ({ page }) => {
    await page.unroute('**/cloudsave/**');
    await page.route('**/cloudsave/**', async route => {
      const url = route.request().url();
      if (url.includes('chess-live')) {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ value: { active: true, moves: [], whiteName: 'Friend', blackName: 'Opp' } }),
        });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ reviewV2: true }));
    await page.evaluate(() => window.agsWatchFriend('friend-1', 'Friend One'));
    await expect(page.locator('#screen-spectator')).toBeVisible();

    await expect(page.locator('#spectator-review-badge')).toBeHidden();
    await expect(page.locator('#spectator-review-actions')).toBeHidden();
    await expect(page.locator('#spectator-back-btn')).toHaveText('← Stop Watching');
    await expect(page.locator('#spectator-live-note')).toBeVisible();
  });

  test('public friend replay (own review flag on) shows no owner-only review state', async ({ page }) => {
    await stubMatchHistoryRoute(page, { 'friend-1': [REVIEW_BLUNDER_GAME] });
    await signInAndOpenProfile(page, 'self-player', 'friend-1', 'Friend One');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, reviewV2: true }));

    await page.locator('.profile-history-row').first().click();
    await expect(page.locator('#screen-spectator')).toBeVisible();
    await expect(page.locator('#spectator-review-badge')).toBeHidden();
    await expect(page.locator('#spectator-back-btn')).toHaveText('← Back to Profile');
  });
});

test.describe('Post-game Review game entry (dev-plan §10.8)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    // See signInAndOpenProfile's comment above — agsSetLearningFlagsForTesting
    // is called with `?.()` throughout this block, so a race here fails
    // SILENTLY (the flag override never takes effect) rather than throwing.
    await page.waitForFunction(() => typeof window.agsSetLearningFlagsForTesting === 'function', { timeout: 15000 });
  });

  async function playAndResign(page) {
    await startVsComputer(page, { color: 'white', difficulty: 'easy' });
    await playMove(page, 'e2', 'e4'); // a real recorded move, so moveHistory.length > 0
    await page.getByRole('tab', { name: 'More' }).click();
    await page.locator('#btn-resign').click();
    await expect(page.locator('#game-over-modal')).toBeVisible();
  }

  test('guest game-over shows no Review game entry, even with the flag on', async ({ page }) => {
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ reviewV2: true }));
    await playAndResign(page);
    await expect(page.locator('#btn-review-game')).toBeHidden();
  });

  test('signed-in game-over with the flag off shows no Review game entry', async ({ page }) => {
    await page.evaluate(() => {
      window.agsCurrentUserId = 'self-player';
      window.agsSetCurrentUserIdForTesting?.('self-player');
    });
    await playAndResign(page);
    await expect(page.locator('#btn-review-game')).toBeHidden();
  });

  test('signed-in vs-computer game-over shows Review game; opening it starts a review; Done returns home', async ({ page }) => {
    test.slow();
    await page.evaluate(() => {
      window.agsCurrentUserId = 'self-player';
      window.agsSetCurrentUserIdForTesting?.('self-player');
      window.agsSetLearningFlagsForTesting?.({ reviewV2: true });
    });
    await playAndResign(page);
    await expect(page.locator('#btn-review-game')).toBeVisible();

    await page.locator('#btn-review-game').click();
    await expect(page.locator('#game-over-modal')).toBeHidden();
    await expect(page.locator('#screen-spectator')).toBeVisible();
    await expect(page.locator('#spectator-review-badge')).toBeVisible();
    await expect(page.locator('#spectator-back-btn')).toHaveText('Done');

    await page.locator('#spectator-back-btn').click();
    await expect(page.locator('#screen-home')).toBeVisible();
  });

  test('the existing Journal nudge still works alongside the review entry', async ({ page }) => {
    await page.evaluate(() => {
      window.agsCurrentUserId = 'self-player';
      window.agsSetCurrentUserIdForTesting?.('self-player');
      window.agsSetLearningFlagsForTesting?.({ reviewV2: true });
    });
    await playAndResign(page);
    await expect(page.locator('#btn-review-game')).toBeVisible();
    await expect(page.locator('#btn-journal-nudge')).toBeVisible();
  });
});

async function openProfileWithHistoryV2(page, userId, displayName = 'Me') {
  return signInAndOpenProfile(page, userId, userId, displayName);
}

test.describe('History enrichment (VITE_LEARNING_HISTORY_V2)', () => {
  test('reveals 50 fixture matches in fixed steps: 20, then 40, then 50', async ({ page }) => {
    await gotoApp(page);
    await stubMatchHistoryRoute(page, { 'self-player': fixtureMatches(50) });
    await openProfileWithHistoryV2(page, 'self-player');

    await expect(page.locator('.profile-history-row')).toHaveCount(20);
    await expect(page.locator('#profile-history-load-more')).toBeVisible();

    await page.locator('#profile-history-load-more').click();
    await expect(page.locator('.profile-history-row')).toHaveCount(40);

    await page.locator('#profile-history-load-more').click();
    await expect(page.locator('.profile-history-row')).toHaveCount(50);
    await expect(page.locator('#profile-history-load-more')).toBeHidden();
  });

  test('filter selection updates rows and the result count', async ({ page }) => {
    await gotoApp(page);
    const matches = [
      ...fixtureMatches(3, { result: 'win' }),
      ...fixtureMatches(2, { result: 'loss' }),
    ].map((m, i) => ({ ...m, id: `m${i}` }));
    await stubMatchHistoryRoute(page, { 'self-player': matches });
    await openProfileWithHistoryV2(page, 'self-player');

    await expect(page.locator('.profile-history-row')).toHaveCount(5);
    await expect(page.locator('#profile-match-history-count')).toContainText('5 matches');

    await page.locator('[data-history-filter="result"][data-history-value="loss"]').click();
    await expect(page.locator('.profile-history-row')).toHaveCount(2);
    await expect(page.locator('#profile-match-history-count')).toContainText('2 of 5 matches');

    await page.locator('[data-history-filter="result"][data-history-value="all"]').click();
    await expect(page.locator('.profile-history-row')).toHaveCount(5);
  });

  test('switching profile resets filters and loads the new profile\'s matches', async ({ page }) => {
    await gotoApp(page);
    await stubMatchHistoryRoute(page, {
      'self-player': fixtureMatches(3, { result: 'loss' }),
      'friend-1': fixtureMatches(2, { result: 'win' }),
    });
    await openProfileWithHistoryV2(page, 'self-player');
    await page.locator('[data-history-filter="result"][data-history-value="loss"]').click();
    await expect(page.locator('.profile-history-row')).toHaveCount(3);

    await openProfileWithHistoryV2(page, 'friend-1', 'Friend One');
    // A stale "loss" filter carried over would show 0 rows (friend's fixtures
    // are all wins) — the reset must bring back "All" and the new 2 matches.
    await expect(page.locator('.profile-history-row')).toHaveCount(2);
    await expect(page.locator('[data-history-filter="result"][data-history-value="all"]')).toHaveClass(/active/);
  });

  test('own profile offers to review; a friend profile offers to replay', async ({ page }) => {
    await gotoApp(page);
    await stubMatchHistoryRoute(page, {
      'self-player': fixtureMatches(1),
      'friend-1': fixtureMatches(1, { id: 'friend-match' }),
    });

    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await expect(page.locator('.profile-history-row').first()).toContainText('Click to review');

    // Still signed in as self-player — now viewing a friend's profile.
    await signInAndOpenProfile(page, 'self-player', 'friend-1', 'Friend One');
    await expect(page.locator('.profile-history-row').first()).toContainText('Click to replay');
    await expect(page.locator('.profile-history-row').first()).not.toContainText('Click to review');
  });

  test('replay by match ID opens the correct game after filtering', async ({ page }) => {
    await gotoApp(page);
    const target = fixtureMatch({ id: 'target-match', opponentName: 'Target Opponent', blackName: 'Target Opponent', result: 'loss' });
    const matches = [fixtureMatch({ id: 'other-win', result: 'win', blackName: 'Other Opponent' }), target];
    await stubMatchHistoryRoute(page, { 'self-player': matches });
    await openProfileWithHistoryV2(page, 'self-player');

    // Filter down to Losses so only the target match's row remains, then
    // confirm clicking it opens THAT match, not an index that shifted.
    await page.locator('[data-history-filter="result"][data-history-value="loss"]').click();
    await expect(page.locator('.profile-history-row')).toHaveCount(1);
    await page.locator('.profile-history-row').first().click();

    await expect(page.locator('#screen-spectator')).toBeVisible();
    await expect(page.locator('#spectator-black-name')).toContainText('Target Opponent');
  });

  test('iPad profile stays inside its internal scroll container with filters and 50 rows', async ({ page }) => {
    await gotoApp(page);
    await stubMatchHistoryRoute(page, { 'self-player': fixtureMatches(50) });
    await openProfileWithHistoryV2(page, 'self-player');
    await expect(page.locator('.profile-history-row')).toHaveCount(20);

    const geometry = await page.evaluate(() => {
      const screen = document.getElementById('screen-profile');
      const container = document.querySelector('.profile-container').getBoundingClientRect();
      const panel = document.querySelector('[data-profile-panel="history"]').getBoundingClientRect();
      return {
        viewportHeight: innerHeight,
        screenScrollHeight: screen.scrollHeight,
        screenClientHeight: screen.clientHeight,
        container: { top: container.top, bottom: container.bottom },
        panel: { top: panel.top, bottom: panel.bottom },
      };
    });

    // The OUTER screen must not scroll — filters, 20 rows, and Load more
    // scroll inside .profile-container, same contract as every other tab.
    expect(geometry.screenScrollHeight).toBeLessThanOrEqual(geometry.screenClientHeight);
    expect(geometry.container.top).toBeGreaterThanOrEqual(0);
    expect(geometry.container.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.container.top);
    expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.container.bottom);
  });

  test('a match with no moves stays non-interactive', async ({ page }) => {
    await gotoApp(page);
    await stubMatchHistoryRoute(page, { 'self-player': [fixtureMatch({ moves: [] })] });
    await openProfileWithHistoryV2(page, 'self-player');

    const row = page.locator('.profile-history-row').first();
    await expect(row).toHaveClass(/no-replay/);
    await expect(row).toBeDisabled();
    await expect(row).toContainText('Replay unavailable');
  });
});

// ─── Private review status + takeaway (dev-plan §11, M4) ──────────────────

// Stateful learning-index stub: a write updates what the NEXT GET returns,
// so a test can finish a review, re-fetch, and see its own badge reflected —
// same as a real backend, without needing a second page load.
async function stubHistoryAndLearningRoute(page, { matchesByUserId = {}, learningRecord = null, failLearningGet = false, failLearningWrite = false } = {}) {
  const learningPuts = [];
  const learningGetUrls = [];
  let currentRecord = learningRecord;
  await page.unroute('**/cloudsave/**');
  await page.route('**/cloudsave/**', async route => {
    const request = route.request();
    const url = request.url();
    if (url.includes('chess-match-history')) {
      const userId = Object.keys(matchesByUserId).find(id => url.includes(id));
      const matches = userId ? matchesByUserId[userId] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: { matches } }) });
    }
    if (url.includes('chess-learning-index')) {
      if (request.method() === 'GET') {
        learningGetUrls.push(url);
        if (failLearningGet) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        if (currentRecord) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: currentRecord }) });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      if (request.method() === 'PUT' || request.method() === 'POST') {
        if (failLearningWrite) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        try {
          const body = request.postDataJSON();
          learningPuts.push(body);
          currentRecord = body;
        } catch { /* non-JSON */ }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return { learningPuts, learningGetUrls };
}

test.describe('Private review status + takeaway (VITE_LEARNING_INDEX_V1)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('opening an owner review with a lesson creates a private "ready" record', async ({ page }) => {
    test.slow();
    const { learningPuts } = await stubHistoryAndLearningRoute(page, { matchesByUserId: { 'self-player': [REVIEW_BLUNDER_GAME] } });
    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, reviewV2: true, indexV1: true }));
    await page.locator('.profile-history-row').first().click();
    await expect(page.locator('#screen-spectator')).toBeVisible();
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 5 / 6', { timeout: 15000 });

    await expect.poll(() => learningPuts.length, { timeout: 10000 }).toBeGreaterThan(0);
    const write = learningPuts[learningPuts.length - 1];
    expect(write.__META).toEqual({ is_public: false });
    expect(write.reviews[0].matchId).toBe('review-blunder');
    expect(write.reviews[0].status).toBe('ready');
    expect(write.reviews[0].takeaway).toBe('');
  });

  test('Finish Review updates status to Reviewed and patches the History badge', async ({ page }) => {
    test.slow();
    const { learningPuts } = await stubHistoryAndLearningRoute(page, { matchesByUserId: { 'self-player': [REVIEW_BLUNDER_GAME] } });
    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, reviewV2: true, indexV1: true }));
    await page.locator('.profile-history-row').first().click();
    await expect(page.locator('#spectator-replay-pos')).toHaveText('Move 5 / 6', { timeout: 15000 });
    await expect(page.locator('#spectator-review-finish-panel')).toBeVisible();

    const takeawayChip = page.locator('.spectator-review-chip').first();
    const chipText = await takeawayChip.textContent();
    await takeawayChip.click();
    await page.locator('#spectator-review-finish-btn').click();
    await expect(page.locator('#spectator-review-save-note')).toHaveText('Saved', { timeout: 10000 });
    const finished = learningPuts[learningPuts.length - 1];
    expect(finished.reviews[0].status).toBe('reviewed');
    expect(finished.reviews[0].takeaway.length).toBeGreaterThan(0);
    expect(finished.__META).toEqual({ is_public: false });

    // Back to History — the stub now serves the just-written record on the
    // next GET, and agsStopWatching() re-renders History from cache and
    // re-triggers the badge patch, so the row must show Reviewed + takeaway.
    await page.locator('#spectator-back-btn').click();
    await expect(page.locator('[data-profile-tab="history"]')).toHaveClass(/active/);
    await expect(page.locator('[data-learning-badge]').first()).toContainText('Reviewed', { timeout: 10000 });
    await expect(page.locator('[data-learning-badge]').first()).toContainText(chipText);
  });

  test('another player\'s profile never requests the private record', async ({ page }) => {
    const { learningGetUrls } = await stubHistoryAndLearningRoute(page, { matchesByUserId: { 'friend-1': [REVIEW_BLUNDER_GAME] } });
    await signInAndOpenProfile(page, 'self-player', 'friend-1', 'Friend One');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, indexV1: true }));
    await expect(page.locator('.profile-history-row')).toHaveCount(1);
    await page.waitForTimeout(300); // let any (incorrect) fire-and-forget fetch land
    expect(learningGetUrls.length).toBe(0);
  });

  test('a failed learning-index GET leaves History fully usable, no badge', async ({ page }) => {
    await stubHistoryAndLearningRoute(page, { matchesByUserId: { 'self-player': [REVIEW_BLUNDER_GAME] }, failLearningGet: true });
    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, reviewV2: true, indexV1: true }));

    await expect(page.locator('.profile-history-row')).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(page.locator('[data-learning-badge]')).toBeEmpty();
    // Review action itself is unaffected by the badge-fetch failure.
    await page.locator('.profile-history-row').first().click();
    await expect(page.locator('#screen-spectator')).toBeVisible();
  });

  test('a failed learning-index write shows a retryable error, never claims Saved', async ({ page }) => {
    test.slow();
    await stubHistoryAndLearningRoute(page, { matchesByUserId: { 'self-player': [REVIEW_BLUNDER_GAME] }, failLearningWrite: true });
    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, reviewV2: true, indexV1: true }));
    await page.locator('.profile-history-row').first().click();
    await expect(page.locator('#spectator-review-finish-panel')).toBeVisible({ timeout: 15000 });

    await page.locator('#spectator-review-finish-btn').click();
    await expect(page.locator('#spectator-review-save-note')).toHaveText('Could not save — try again.', { timeout: 10000 });
    await expect(page.locator('#spectator-review-save-note')).not.toHaveText('Saved');
  });

  test('switching profiles mid-fetch ignores the delayed, now-stale badge response', async ({ page }) => {
    await page.unroute('**/cloudsave/**');
    await page.route('**/cloudsave/**', async route => {
      const request = route.request();
      const url = request.url();
      if (url.includes('chess-match-history')) {
        const userId = url.includes('self-player') ? 'self-player' : url.includes('friend-1') ? 'friend-1' : '';
        const matches = userId === 'self-player' ? [REVIEW_BLUNDER_GAME] : userId === 'friend-1' ? [fixtureMatch({ id: 'friend-match' })] : [];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: { matches } }) });
      }
      if (url.includes('chess-learning-index') && request.method() === 'GET') {
        // Slow response for self-player's own record — the profile switch
        // below must complete and move on before this ever resolves.
        await new Promise(resolve => setTimeout(resolve, 1500));
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, indexV1: true }));
    await expect(page.locator('.profile-history-row')).toHaveCount(1);

    // Switch to a friend's profile before the slow self-player fetch resolves.
    await signInAndOpenProfile(page, 'self-player', 'friend-1', 'Friend One');
    await expect(page.locator('.profile-history-row')).toHaveCount(1);
    await page.waitForTimeout(1800); // let the stale self-player response land
    // The friend row must never pick up a badge meant for a different profile/match.
    await expect(page.locator('[data-learning-badge]')).toBeEmpty();
  });

  test('logout clears the in-memory learning-index cache (dev-plan §11.4)', async ({ page }) => {
    test.slow();
    let learningGetCount = 0;
    await page.unroute('**/cloudsave/**');
    await page.route('**/cloudsave/**', async route => {
      const request = route.request();
      const url = request.url();
      if (url.includes('chess-match-history')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: { matches: [REVIEW_BLUNDER_GAME] } }) });
      }
      if (url.includes('chess-learning-index') && request.method() === 'GET') {
        learningGetCount++;
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, indexV1: true }));
    await expect.poll(() => learningGetCount, { timeout: 10000 }).toBeGreaterThan(0);
    const countBeforeLogout = learningGetCount;

    // logout() ends in window.location.reload() — page.route handlers
    // survive navigation, but the evaluate call itself may report the
    // context as destroyed mid-reload; that's expected, not a failure.
    await page.evaluate(() => window.agsLogout()).catch(() => {});
    await expect(page.locator('#screen-home')).toBeVisible({ timeout: 15000 });
    // #screen-home appears before main.js finishes wiring window.agsOpenProfile
    // and friends post-reload — wait for that specifically, not just the screen.
    await page.waitForFunction(() => typeof window.agsOpenProfile === 'function', { timeout: 15000 });

    // Re-open the SAME userId's profile after the reload. Without an
    // explicit cache clear on logout, loadLearningIndex would see a
    // still-matching cache.userId and skip the fetch entirely.
    await signInAndOpenProfile(page, 'self-player', 'self-player');
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ historyV2: true, indexV1: true }));
    await expect.poll(() => learningGetCount, { timeout: 10000 }).toBeGreaterThan(countBeforeLogout);
  });
});

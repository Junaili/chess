const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// "My Chess Journal" — offline spec. CloudSave is stubbed at the network
// layer; the tab is driven through the dev seam agsRenderJournalForTesting
// (pattern: agsRenderFriendsListForTesting). The move-grading engine runs for
// real: the fixtures below are legal games in the app's own coordinate
// encoding, so generation exercises the true analysis pipeline.

// 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7# — the player (white) wins with a
// clean, engine-approved finish.
const WIN_GAME = {
  id: 'g-win',
  mode: 'online',
  result: 'win',
  endReason: 'checkmate',
  myColor: 'white',
  opponentName: 'Maya',
  whiteName: 'Me',
  blackName: 'Maya',
  startedAt: '2026-07-09T09:40:00Z',
  endedAt: '2026-07-09T10:00:00Z',
  durationMs: 1200000,
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

// 1.e4 e5 2.Qh5 Nc6 3.Qxh7?? Rxh7 — the player (white) hangs the queen for a
// pawn on ply 4: a guaranteed "Better move available" at any depth, so the
// entry must contain a mistake key moment and a practice puzzle.
const BLUNDER_GAME = {
  id: 'g-blunder',
  mode: 'online',
  result: 'loss',
  endReason: 'resignation',
  myColor: 'white',
  opponentName: 'Rex',
  whiteName: 'Me',
  blackName: 'Rex',
  startedAt: '2026-07-09T08:00:00Z',
  endedAt: '2026-07-09T08:20:00Z',
  durationMs: 1200000,
  moves: [
    { fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' }, // e4
    { fr: 1, fc: 4, toR: 3, toC: 4, promType: 'queen' }, // e5
    { fr: 7, fc: 3, toR: 3, toC: 7, promType: 'queen' }, // Qh5
    { fr: 0, fc: 1, toR: 2, toC: 2, promType: 'queen' }, // Nc6
    { fr: 3, fc: 7, toR: 1, toC: 7, promType: 'queen' }, // Qxh7??
    { fr: 0, fc: 7, toR: 1, toC: 7, promType: 'queen' }, // Rxh7
  ],
};

const FRESH_HISTORY = [WIN_GAME, BLUNDER_GAME];

// Recent endedAt values relative to the test run (the 24h window is real).
function freshHistory() {
  const now = Date.now();
  return FRESH_HISTORY.map((match, i) => ({
    ...match,
    endedAt: new Date(now - (i + 1) * 3600000).toISOString(),
  }));
}

async function stubCloudSave(page, { journalValue = null } = {}) {
  const puts = [];
  await page.unroute('**/cloudsave/**');
  await page.route('**/cloudsave/**', async route => {
    const request = route.request();
    const isJournal = request.url().includes('chess-journal');
    if (request.method() === 'GET') {
      if (isJournal && journalValue) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: journalValue }) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (isJournal && (request.method() === 'PUT' || request.method() === 'POST')) {
      try { puts.push(request.postDataJSON()) } catch { /* non-JSON */ }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  return puts;
}

async function openJournalTab(page) {
  await page.evaluate(() => {
    window.showScreen('profile');
    document.querySelector('[data-profile-tab="journal"]').hidden = false;
    window.agsShowProfileTab('journal');
  });
}

test.describe('My Chess Journal', () => {
  test('generates an entry: coach report, key moments, puzzles — and the record stays private', async ({ page }) => {
    test.slow(); // real engine analysis of two games
    await gotoApp(page);
    const puts = await stubCloudSave(page);
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('me', history, { isChildSession: false }), freshHistory());

    await expect(page.locator('#journal-entries')).toContainText('No journal entries yet');
    await page.locator('#btn-journal-generate').click();

    const entry = page.locator('.journal-entry.latest');
    await expect(entry).toBeVisible({ timeout: 45000 });
    await expect(entry).toContainText('1W–1L–0D');
    await expect(entry.locator('.journal-coach-headline')).toHaveText(/./);
    // The queen-hang must surface as the biggest lesson, with a retry action.
    await expect(entry.locator('.journal-moment.mistake').first()).toContainText('Qxh7');
    await expect(entry.locator('.journal-moment.mistake').first()).toContainText('Try again');
    // …and as a practice puzzle.
    await expect(entry.locator('.journal-puzzle').first()).toBeVisible();
    // A goal is proposed and the reflection editor is private-labelled.
    await expect(entry.locator('.journal-goal')).toContainText('Goal:');
    await expect(entry.locator('.journal-reflection')).toContainText('only you see this');

    // Privacy: every persisted write must carry is_public:false.
    expect(puts.length).toBeGreaterThan(0);
    for (const body of puts) {
      expect(body.__META).toEqual({ is_public: false });
    }
  });

  test('replay drill-down lands on the blunder ply and Back returns to the Journal tab', async ({ page }) => {
    test.slow();
    await gotoApp(page);
    await stubCloudSave(page);
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('me', history, { isChildSession: false }), freshHistory());
    await page.locator('#btn-journal-generate').click();
    await expect(page.locator('.journal-entry.latest')).toBeVisible({ timeout: 45000 });

    await page.locator('.journal-moment.mistake [data-journal-action="replay"]').first().click();
    await expect(page.locator('#screen-spectator')).toBeVisible();
    // The analysis panel critiques the landed-on move — the blunder itself.
    await expect(page.locator('#spectator-analysis')).toBeVisible();
    await expect(page.locator('#spectator-analysis-grade')).toHaveText('Better move available');

    await page.evaluate(() => window.agsStopWatching());
    await expect(page.locator('#screen-profile')).toBeVisible();
    await expect(page.locator('[data-profile-tab="journal"]')).toHaveClass(/active/);
  });

  test('a puzzle drill judges the retried move and records the attempt', async ({ page }) => {
    test.slow();
    await gotoApp(page);
    const puts = await stubCloudSave(page);
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('me', history, { isChildSession: false }), freshHistory());
    await page.locator('#btn-journal-generate').click();
    await expect(page.locator('.journal-entry.latest')).toBeVisible({ timeout: 45000 });

    await page.locator('.journal-puzzle').first().click();
    await expect(page.locator('#screen-game')).toBeVisible();
    // Board is mid-position: the four prefix plies are on the move list.
    await expect(page.locator('#move-list .move-row, #move-list li, #move-list > *')).not.toHaveCount(0);
    await expect(page.locator('#hint-box')).toBeVisible();
    await expect(page.locator('#hint-text')).toContainText('find something better');

    // Repeat the original blunder (Qh5xh7) — the judge must reject it.
    await page.evaluate(() => window.executeMove(3, 7, 1, 7, 'queen'));
    await expect(page.locator('#hint-text')).toContainText('Not quite', { timeout: 20000 });
    await expect.poll(() => puts.length, { timeout: 10000 }).toBeGreaterThan(1); // attempt persisted
  });

  test('child sessions reflect with chips, not free text', async ({ page }) => {
    await gotoApp(page);
    await stubCloudSave(page, {
      journalValue: {
        __META: { is_public: false },
        entries: [{
          id: 'e1',
          createdAt: '2026-07-09T10:00:00Z',
          window: '24h',
          gamesInWindow: 1,
          gamesAnalyzed: 1,
          record: { wins: 1, losses: 0, draws: 0 },
          accuracy: { movesGraded: 8, strongCount: 5, strongRate: 0.62, blunderCount: 0, blunderRate: 0, blundersByPhase: { opening: 0, middlegame: 0, endgame: 0 }, weakestPhase: null },
          keyMoments: { excellent: [], mistakes: [] },
          puzzles: [],
          games: {},
          coach: { headline: 'Nice, steady game.' },
          goal: null,
          previousGoalVerdict: null,
          reflection: { didWell: '', tryNext: '', chips: [] },
        }],
        gradeCache: {},
        updatedAt: '2026-07-09T10:00:00Z',
      },
    });
    await openJournalTab(page);
    await page.evaluate(() => window.agsRenderJournalForTesting('kid', null, { isChildSession: true }));

    const reflection = page.locator('.journal-reflection');
    await expect(reflection).toBeVisible();
    await expect(reflection.locator('.journal-chip').first()).toBeVisible();
    await expect(reflection.locator('textarea')).toHaveCount(0);

    // Chips toggle and save.
    await reflection.locator('.journal-chip').first().click();
    await expect(reflection.locator('.journal-chip.selected')).toHaveCount(1);
  });

  test('an empty window reports honestly instead of writing a hollow entry', async ({ page }) => {
    await gotoApp(page);
    await stubCloudSave(page);
    await openJournalTab(page);
    await page.evaluate(() => window.agsRenderJournalForTesting('me', [], { isChildSession: false }));
    await page.locator('#btn-journal-generate').click();
    await expect(page.locator('#journal-status')).toContainText('No finished games');
    await expect(page.locator('.journal-entry')).toHaveCount(0);
  });
});

test.describe('Coach Mode (vs computer)', () => {
  test('flags a blunder, holds the AI reply, and takes the move back', async ({ page }) => {
    await gotoApp(page);
    // Start a guest vs-computer game (the established pattern from ui-smoke).
    await page.evaluate(() => {
      window.showColorSelect('computer');
      window.selectColor('white');
      window.selectPieceColor('#fffdf5');
      window.startVsComputer('easy');
    });
    await expect(page.locator('#chess-board [data-r]')).toHaveCount(64);

    // The coach toggle lives in the sidebar's "More" panel.
    await page.getByRole('tab', { name: 'More' }).click();
    const coachBtn = page.locator('#btn-coach-mode');
    await expect(coachBtn).toBeVisible();
    await expect(coachBtn).toContainText('Off');
    await coachBtn.click();
    await expect(coachBtn).toContainText('On');

    // Deterministic verdicts: stub the grading seam (app.js only reads
    // grade/loss/playedNotation from it).
    await page.evaluate(() => {
      window.agsGradeMoveInPosition = () => ({ grade: 'Better move available', loss: 250, playedNotation: 'e4' });
    });
    await page.evaluate(() => window.executeMove(6, 4, 4, 4, 'queen')); // 1.e4, "graded" a blunder

    const prompt = page.locator('#coach-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('gives up about 2.5 pawns');
    // AI is held while the prompt is open.
    await expect(page.locator('#turn-indicator')).not.toContainText('thinking');

    await page.locator('#coach-prompt [data-click="coachTakeBack()"]').click();
    await expect(prompt).toBeHidden();
    // The move came back off the board — move list is empty, player to move.
    await expect(page.locator('#move-list > *')).toHaveCount(0);
    await expect(page.locator('#turn-indicator')).toContainText('Your turn');
  });

  test('play on lets the AI answer, and clean moves never prompt', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.showColorSelect('computer');
      window.selectColor('white');
      window.selectPieceColor('#fffdf5');
      window.startVsComputer('easy');
      window.toggleCoachMode();
    });
    await page.evaluate(() => {
      window.agsGradeMoveInPosition = () => ({ grade: 'Better move available', loss: 180, playedNotation: 'e4' });
    });
    await page.evaluate(() => window.executeMove(6, 4, 4, 4, 'queen'));
    await expect(page.locator('#coach-prompt')).toBeVisible();
    await page.locator('#coach-prompt [data-click="coachPlayOn()"]').click();
    await expect(page.locator('#coach-prompt')).toBeHidden();
    // The AI answers: Black's reply fills in on the move row.
    await expect.poll(
      () => page.locator('#move-list .move-black').first().textContent(),
      { timeout: 10000 },
    ).not.toBe('');

    // A clean move sails through without a prompt.
    await page.evaluate(() => {
      window.agsGradeMoveInPosition = () => ({ grade: 'Strong move', loss: 0, playedNotation: 'Nf3' });
    });
    await page.evaluate(() => window.executeMove(7, 6, 5, 5, 'queen')); // 2.Nf3
    await expect(page.locator('#coach-prompt')).toBeHidden();
  });
});

test.describe('Coach Gus journal narrative (Phase 4)', () => {
  test("attaches Gus's note to a fresh entry when the coach endpoint answers", async ({ page }) => {
    test.slow();
    await gotoApp(page);
    await stubCloudSave(page);
    await page.route('**/coach/report*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: true, coach: 'Gambit Gus', note: 'Nxf5 was a beauty — you saw the slip and pounced. Next stop: castling by move ten!' }),
    }));
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('me', history, { isChildSession: false }), freshHistory());
    await page.locator('#btn-journal-generate').click();

    await expect(page.locator('.journal-entry.latest')).toBeVisible({ timeout: 45000 });
    const gusNote = page.locator('.journal-coach-gus');
    await expect(gusNote).toBeVisible({ timeout: 15000 });
    await expect(gusNote).toContainText('Coach Gus:');
    await expect(gusNote).toContainText('Nxf5 was a beauty');
  });

  test('degrades silently when the LLM is unconfigured ({"available":false})', async ({ page }) => {
    test.slow();
    await gotoApp(page);
    await stubCloudSave(page);
    await page.route('**/coach/report*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: false }),
    }));
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('me', history, { isChildSession: false }), freshHistory());
    await page.locator('#btn-journal-generate').click();

    const entry = page.locator('.journal-entry.latest');
    await expect(entry).toBeVisible({ timeout: 45000 });
    // The deterministic report is intact; no Gus note, no error surfaced.
    await expect(entry.locator('.journal-coach-headline')).toHaveText(/./);
    await page.waitForTimeout(500);
    await expect(page.locator('.journal-coach-gus')).toHaveCount(0);
    await expect(page.locator('#journal-status')).toHaveText('');
  });

  test('child sessions never call the coach endpoint', async ({ page }) => {
    test.slow();
    await gotoApp(page);
    await stubCloudSave(page);
    let coachCalls = 0;
    await page.route('**/coach/report*', route => {
      coachCalls++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, note: 'should never appear' }) });
    });
    await openJournalTab(page);
    await page.evaluate(history => window.agsRenderJournalForTesting('kid', history, { isChildSession: true }), freshHistory());
    await page.locator('#btn-journal-generate').click();

    await expect(page.locator('.journal-entry.latest')).toBeVisible({ timeout: 45000 });
    await page.waitForTimeout(500);
    expect(coachCalls).toBe(0);
    await expect(page.locator('.journal-coach-gus')).toHaveCount(0);
  });
});

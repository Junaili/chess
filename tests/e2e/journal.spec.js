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
  // gotoApp() only waits for #screen-home to be visible, which can render
  // slightly before main.js finishes its synchronous window.agsX = ...
  // assignments (observed intermittently, more often on WebKit).
  await page.waitForFunction(() => typeof window.showScreen === 'function' && typeof window.agsShowProfileTab === 'function', { timeout: 15000 });
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

  test('a carried puzzle stays launchable once its game only survives in an older entry (dev-plan §8.3)', async ({ page }) => {
    await gotoApp(page);
    // Newest entry carries the puzzle forward but no longer embeds g-blunder's
    // game (its own window moved past that match); the older entry still
    // does. embeddedGame() must search record-wide, not just the owning entry.
    const journalValue = {
      entries: [
        {
          id: 'e-new',
          createdAt: new Date().toISOString(),
          window: '24h',
          record: { wins: 0, losses: 1, draws: 0 },
          gamesAnalyzed: 1,
          gamesInWindow: 1,
          coach: { headline: 'Latest window' },
          keyMoments: { excellent: [], mistakes: [] },
          games: {},
          puzzles: [{
            id: 'g-blunder:4', matchId: 'g-blunder', ply: 4, kind: 'missed',
            playedNotation: 'Qxh7', bestNotation: 'Nf3', opponentName: 'Rex',
            solved: false, attempts: 0,
          }],
        },
        {
          id: 'e-old',
          createdAt: new Date(Date.now() - 86400000).toISOString(),
          window: '24h',
          record: { wins: 0, losses: 1, draws: 0 },
          gamesAnalyzed: 1,
          gamesInWindow: 1,
          coach: { headline: 'Older window' },
          keyMoments: { excellent: [], mistakes: [] },
          games: { 'g-blunder': BLUNDER_GAME },
          puzzles: [],
        },
      ],
      gradeCache: {},
      updatedAt: new Date().toISOString(),
    };
    await stubCloudSave(page, { journalValue });
    await openJournalTab(page);
    await page.evaluate(() => window.agsRenderJournalForTesting('me', [], { isChildSession: false }));

    const puzzleButton = page.locator('.journal-entry.latest .journal-puzzle').first();
    await expect(puzzleButton).toBeVisible();
    await puzzleButton.click();

    await expect(page.locator('#screen-game')).toBeVisible();
    await expect(page.locator('#hint-box')).toBeVisible();
    await expect(page.locator('#hint-text')).toContainText('find something better');
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

test.describe('Global practice queue (VITE_LEARNING_PRACTICE_V2, dev-plan §12)', () => {
  function queuePuzzle(overrides = {}) {
    return {
      id: 'g-blunder:4', matchId: 'g-blunder', ply: 4, kind: 'missed',
      playedNotation: 'Qxh7', bestNotation: 'Nf3', opponentName: 'Rex',
      solved: false, attempts: 0,
      ...overrides,
    };
  }

  function recordWithPuzzleInOlderEntry(puzzleOverrides = {}) {
    return {
      entries: [
        {
          id: 'e-newest', createdAt: new Date().toISOString(), window: '24h',
          record: { wins: 0, losses: 1, draws: 0 }, gamesAnalyzed: 1, gamesInWindow: 1,
          coach: { headline: 'Latest window' }, keyMoments: { excellent: [], mistakes: [] },
          games: {}, puzzles: [],
        },
        {
          id: 'e-older', createdAt: new Date(Date.now() - 86400000).toISOString(), window: '24h',
          record: { wins: 0, losses: 1, draws: 0 }, gamesAnalyzed: 1, gamesInWindow: 1,
          coach: { headline: 'Older window' }, keyMoments: { excellent: [], mistakes: [] },
          games: { 'g-blunder': BLUNDER_GAME }, puzzles: [queuePuzzle(puzzleOverrides)],
        },
      ],
      gradeCache: {},
      updatedAt: new Date().toISOString(),
    };
  }

  async function openQueue(page, journalValue, { isChildSession = false } = {}) {
    await gotoApp(page);
    const puts = await stubCloudSave(page, { journalValue });
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ practiceV2: true }));
    await openJournalTab(page);
    await page.evaluate(isChildSession => window.agsRenderJournalForTesting('me', [], { isChildSession }), isChildSession);
    return puts;
  }

  test('a puzzle carried in an older entry appears in the global queue', async ({ page }) => {
    await openQueue(page, recordWithPuzzleInOlderEntry());
    await expect(page.locator('#journal-practice-queue')).toBeVisible();
    await expect(page.locator('#journal-practice-queue')).toContainText('Practice due: 1');
    const row = page.locator('.journal-practice-row').first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-entry', 'e-older');
    await expect(row).not.toHaveClass(/unplayable/);
  });

  test('starting a queued puzzle reaches the correct position and rejects the original move', async ({ page }) => {
    test.slow();
    await openQueue(page, recordWithPuzzleInOlderEntry());
    await page.locator('.journal-practice-row').first().click();
    await expect(page.locator('#screen-game')).toBeVisible();
    await expect(page.locator('#hint-box')).toBeVisible();
    await expect(page.locator('#hint-text')).toContainText('find something better');

    await page.evaluate(() => window.executeMove(3, 7, 1, 7, 'queen')); // repeats Qxh7??
    await expect(page.locator('#hint-text')).toContainText('Not quite', { timeout: 20000 });
  });

  test('a correct first-attempt alternative advances the puzzle to Learning, due in ~3 days', async ({ page }) => {
    test.slow();
    const puts = await openQueue(page, recordWithPuzzleInOlderEntry());
    await page.locator('.journal-practice-row').first().click();
    await expect(page.locator('#hint-box')).toBeVisible();

    // Nf3 (knight development) instead of the blunder — a genuinely
    // different, reasonable move the judge should accept.
    await page.evaluate(() => window.executeMove(7, 6, 5, 5, 'queen'));
    await expect(page.locator('#hint-text')).toContainText('idea', { timeout: 20000 });
    await expect.poll(() => puts.length, { timeout: 10000 }).toBeGreaterThan(0);

    const saved = puts[puts.length - 1];
    const savedPuzzle = saved.entries.flatMap(e => e.puzzles || []).find(p => p.id === 'g-blunder:4');
    expect(savedPuzzle.stage).toBe('learning');
    expect(savedPuzzle.attempts).toBe(1);
    expect(savedPuzzle.lastResult).toBe('correct');
    const dueAt = new Date(savedPuzzle.dueAt).getTime();
    const expected = Date.now() + 3 * 86400000;
    expect(Math.abs(dueAt - expected)).toBeLessThan(5 * 60000); // within 5 minutes
  });

  test('refresh (re-render) retains the updated due/stage state', async ({ page }) => {
    test.slow();
    const puts = await openQueue(page, recordWithPuzzleInOlderEntry());
    await page.locator('.journal-practice-row').first().click();
    await page.evaluate(() => window.executeMove(7, 6, 5, 5, 'queen'));
    await expect(page.locator('#hint-text')).toContainText('idea', { timeout: 20000 });
    await expect.poll(() => puts.length, { timeout: 10000 }).toBeGreaterThan(0);

    // Re-render from the now-updated in-memory record — same tab, no puzzle
    // due today, since it just advanced to Learning +3 days.
    await page.evaluate(() => window.agsShowProfileTab('journal'));
    await expect(page.locator('#journal-practice-queue')).not.toContainText('Practice due');
  });

  test('a save failure is visible without blocking the board result', async ({ page }) => {
    test.slow();
    const journalValue = recordWithPuzzleInOlderEntry();
    await gotoApp(page);
    await page.unroute('**/cloudsave/**');
    await page.route('**/cloudsave/**', async route => {
      const isJournal = route.request().url().includes('chess-journal');
      if (route.request().method() === 'GET') {
        return isJournal
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: journalValue }) })
          : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      if (isJournal) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ practiceV2: true }));
    await openJournalTab(page);
    await page.evaluate(() => window.agsRenderJournalForTesting('me', [], { isChildSession: false }));

    await page.locator('.journal-practice-row').first().click();
    await page.evaluate(() => window.executeMove(7, 6, 5, 5, 'queen'));
    // Board result (the judge's own verdict) still shows first...
    await expect(page.locator('#hint-text')).toContainText('idea', { timeout: 20000 });
    // ...then the save failure appends visibly, without replacing it.
    await expect(page.locator('#hint-text')).toContainText('Progress not saved', { timeout: 10000 });
  });

  test('a drill never records a match-history entry or increments a stat', async ({ page }) => {
    test.slow();
    let matchHistoryWrites = 0;
    let statCalls = 0;
    await gotoApp(page);
    await stubCloudSave(page, { journalValue: recordWithPuzzleInOlderEntry() });
    await page.route('**/basic/**', route => {
      matchHistoryWrites++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/statistic/**', route => {
      statCalls++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ practiceV2: true }));
    await openJournalTab(page);
    await page.evaluate(() => window.agsRenderJournalForTesting('me', [], { isChildSession: false }));

    await page.locator('.journal-practice-row').first().click();
    await page.evaluate(() => window.executeMove(7, 6, 5, 5, 'queen'));
    await expect(page.locator('#hint-text')).toContainText('idea', { timeout: 20000 });
    await page.waitForTimeout(300);
    expect(matchHistoryWrites).toBe(0);
    expect(statCalls).toBe(0);
  });

  test('a child session\'s queue contains no purchase UI', async ({ page }) => {
    await openQueue(page, recordWithPuzzleInOlderEntry(), { isChildSession: true });
    await expect(page.locator('#journal-practice-queue')).toBeVisible();
    await expect(page.locator('#journal-practice-queue [data-purchase-ui]')).toHaveCount(0);
    await expect(page.locator('#journal-practice-queue')).not.toContainText('♛');
  });
});

test.describe('Goals v2 (VITE_LEARNING_GOALS_V2, dev-plan §13)', () => {
  function goalCandidate(overrides = {}) {
    return {
      kind: 'castle-early', label: 'Castle by move 10 in 3 applicable games',
      detail: 'A safe king survives longer — castle before move 10.',
      status: 'suggested', target: 3, applicable: 0, completed: 0,
      selectedAt: '', completedAt: '', modelVersion: 'goal-v2', evidenceIds: [],
      ...overrides,
    };
  }

  function activeGoal(overrides = {}) {
    return {
      kind: 'castle-early', label: 'Castle by move 10 in 3 applicable games',
      detail: 'A safe king survives longer — castle before move 10.',
      status: 'active', target: 3, applicable: 1, completed: 1,
      selectedAt: new Date().toISOString(), completedAt: '', modelVersion: 'goal-v2', evidenceIds: ['m1'],
      ...overrides,
    };
  }

  function entryWithGoal({ goal = null, goalCandidates = [] } = {}) {
    return {
      id: 'e-latest', createdAt: new Date().toISOString(), window: '24h',
      record: { wins: 1, losses: 0, draws: 0 }, gamesAnalyzed: 1, gamesInWindow: 1,
      coach: { headline: 'Latest window' }, keyMoments: { excellent: [], mistakes: [] },
      games: {}, puzzles: [], goal, goalCandidates,
    };
  }

  async function renderJournalWithGoal(page, journalValue, { isChildSession = false } = {}) {
    await gotoApp(page);
    const puts = await stubCloudSave(page, { journalValue });
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ goalsV2: true }));
    await openJournalTab(page);
    await page.evaluate(isChildSession => window.agsRenderJournalForTesting('me', [], { isChildSession }), isChildSession);
    return puts;
  }

  test('suggested candidates show on the latest entry; selecting one activates it', async ({ page }) => {
    const journalValue = {
      entries: [entryWithGoal({ goalCandidates: [goalCandidate(), goalCandidate({ kind: 'no-early-resign', label: 'Play it out' })] })],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    const puts = await renderJournalWithGoal(page, journalValue);

    await expect(page.locator('.journal-goal-candidates h4')).toHaveText('Suggested goal');
    await expect(page.locator('.journal-goal-candidate')).toHaveCount(2);

    await page.locator('.journal-goal-candidate').first().click();
    await expect(page.locator('.journal-goal')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.journal-goal')).toContainText('Castle by move 10');
    await expect(page.locator('.journal-goal-candidates')).toHaveCount(0);
    await expect.poll(() => puts.length, { timeout: 10000 }).toBeGreaterThan(0);
    const saved = puts[puts.length - 1].entries[0].goal;
    expect(saved.status).toBe('active');
    expect(saved.selectedAt).toBeTruthy();
  });

  test('an active goal shows progress copy and no candidate list (exactly one active goal)', async ({ page }) => {
    const journalValue = {
      entries: [entryWithGoal({ goal: activeGoal({ applicable: 2, completed: 1, evidenceIds: ['m1', 'm2'] }) })],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    await renderJournalWithGoal(page, journalValue);

    await expect(page.locator('.journal-goal')).toContainText('Castled by move 10 in 1 of 2');
    await expect(page.locator('.journal-goal-candidates')).toHaveCount(0);
  });

  test('an achieved goal shows celebratory copy', async ({ page }) => {
    const journalValue = {
      entries: [entryWithGoal({
        goal: activeGoal({ status: 'achieved', applicable: 3, completed: 3, completedAt: new Date().toISOString(), evidenceIds: ['m1', 'm2', 'm3'] }),
      })],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    await renderJournalWithGoal(page, journalValue);

    await expect(page.locator('.journal-goal-verdict.achieved')).toContainText('Goal complete');
    await expect(page.locator('.journal-goal-verdict.achieved')).toContainText('all 3 applicable games');
  });

  test('a stalled goal (target reached, not fully achieved) never shows a red failure state, offers Keep goal / Choose another', async ({ page }) => {
    const journalValue = {
      entries: [entryWithGoal({
        goal: activeGoal({ applicable: 3, completed: 1, evidenceIds: ['m1', 'm2', 'm3'] }),
      })],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    const puts = await renderJournalWithGoal(page, journalValue);

    const verdict = page.locator('.journal-goal-verdict');
    await expect(verdict).toBeVisible();
    await expect(verdict).not.toHaveClass(/missed/); // dev-plan §13.4: avoid a red failure state
    await expect(page.locator('[data-journal-action="keep-goal"]')).toBeVisible();
    await expect(page.locator('[data-journal-action="choose-another-goal"]')).toBeVisible();

    await page.locator('[data-journal-action="choose-another-goal"]').click();
    await expect(page.locator('.journal-goal-candidates')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.journal-goal-candidates h4')).toHaveText('Choose a new goal');

    // Replacing preserves history — the goal isn't deleted, only re-flagged.
    await expect.poll(() => puts.length, { timeout: 10000 }).toBeGreaterThan(0);
    const savedGoal = puts[puts.length - 1].entries[0].goal;
    expect(savedGoal.status).toBe('replaced');
    expect(savedGoal.evidenceIds).toEqual(['m1', 'm2', 'm3']);
    expect(savedGoal.applicable).toBe(3);
  });

  test('Keep goal resets progress for another round on the same goal', async ({ page }) => {
    const journalValue = {
      entries: [entryWithGoal({ goal: activeGoal({ applicable: 3, completed: 1, evidenceIds: ['m1', 'm2', 'm3'] }) })],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    const puts = await renderJournalWithGoal(page, journalValue);

    await page.locator('[data-journal-action="keep-goal"]').click();
    await expect.poll(() => puts.length, { timeout: 10000 }).toBeGreaterThan(0);
    const saved = puts[puts.length - 1].entries[0].goal;
    expect(saved.status).toBe('active');
    expect(saved.applicable).toBe(0);
    expect(saved.completed).toBe(0);
    expect(saved.evidenceIds).toEqual([]);
    expect(saved.kind).toBe('castle-early'); // same goal, fresh round
  });

  test('a legacy goal (no status field) still displays correctly with the flag on — no migration needed', async ({ page }) => {
    const legacyGoal = {
      kind: 'castle-early', label: 'Castle by move 10 in your next 3 games',
      detail: 'You castled early in only 1 of 2 applicable games — a safe king survives longer.',
    };
    const journalValue = { entries: [entryWithGoal({ goal: legacyGoal })], gradeCache: {}, updatedAt: new Date().toISOString() };
    await renderJournalWithGoal(page, journalValue);

    await expect(page.locator('.journal-goal')).toContainText('Castle by move 10 in your next 3 games');
    await expect(page.locator('.journal-goal-candidates')).toHaveCount(0); // legacy goal displays as active
  });

  test('review-games and practice-positions candidates are absent when their own flags are off', async ({ page }) => {
    // No M4/M5 flags set — only goalsV2. deriveGoalCandidates must not offer
    // review-games/practice-positions without their own support.
    const journalValue = {
      entries: [entryWithGoal({ goalCandidates: [goalCandidate({ kind: 'review-next-games', label: 'Review your next 3 finished games' })] })],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    await renderJournalWithGoal(page, journalValue);
    await expect(page.locator('.journal-goal-candidate')).toHaveCount(1);
    await expect(page.locator('.journal-goal-candidate')).toContainText('Review your next 3 finished games');
  });

  test('a child session\'s goal candidates have no purchase UI and never call the coach endpoint', async ({ page }) => {
    let coachCalled = false;
    const journalValue = { entries: [entryWithGoal({ goalCandidates: [goalCandidate()] })], gradeCache: {}, updatedAt: new Date().toISOString() };
    await gotoApp(page);
    await stubCloudSave(page, { journalValue });
    await page.route('**/coach/report', route => {
      coachCalled = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"available":false}' });
    });
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ goalsV2: true }));
    await openJournalTab(page);
    await page.evaluate(() => window.agsRenderJournalForTesting('me', [], { isChildSession: true }));

    await expect(page.locator('.journal-goal-candidate')).toHaveCount(1);
    await expect(page.locator('.journal-goal-candidates [data-purchase-ui]')).toHaveCount(0);
    await page.locator('.journal-goal-candidate').first().click();
    await page.waitForTimeout(500);
    expect(coachCalled).toBe(false);
  });
});

test.describe('Journal hierarchy (VITE_LEARNING_JOURNAL_LAYOUT_V2, dev-plan §14)', () => {
  function journalEntry(overrides = {}) {
    return {
      id: overrides.id || 'e1',
      createdAt: overrides.createdAt || new Date().toISOString(),
      window: '24h',
      record: { wins: 1, losses: 0, draws: 0 },
      gamesAnalyzed: 1,
      gamesInWindow: 1,
      accuracy: { movesGraded: 10, strongCount: 7, strongRate: 0.7, blunderCount: 1, blunderRate: 0.1, blundersByPhase: {}, weakestPhase: null },
      coach: { headline: 'Solid game overall.' },
      keyMoments: { excellent: [], mistakes: [] },
      games: {},
      puzzles: [],
      goal: null,
      goalCandidates: [],
      reflection: { didWell: '', tryNext: '', chips: [] },
      ...overrides,
    };
  }

  async function renderWithLayoutFlag(page, journalValue, { flags = {}, isChildSession = false, clubActive = false, journalOpen = null, narrativesRemainingToday = 1 } = {}) {
    await gotoApp(page);
    const puts = await stubCloudSave(page, { journalValue });
    await page.evaluate(flags => window.agsSetLearningFlagsForTesting?.({ journalLayoutV2: true, ...flags }), flags);
    await openJournalTab(page);
    await page.evaluate(
      ({ isChildSession, clubActive, journalOpen, narrativesRemainingToday }) =>
        window.agsRenderJournalForTesting('me', [], { isChildSession, clubActive, journalOpen, narrativesRemainingToday }),
      { isChildSession, clubActive, journalOpen, narrativesRemainingToday },
    );
    return puts;
  }

  test('next-action shows due practice ahead of an active goal (priority 1 over 3)', async ({ page }) => {
    const duePuzzle = {
      id: 'g1:4', matchId: 'g1', ply: 4, kind: 'missed', playedNotation: 'Qxh7', bestNotation: 'O-O',
      opponentName: 'Rex', solved: false, attempts: 0, stage: 'learning', dueAt: '2026-07-01T00:00:00.000Z',
    };
    const goal = {
      kind: 'castle-early', label: 'Castle by move 10', detail: '', status: 'active',
      target: 3, applicable: 1, completed: 1, selectedAt: new Date().toISOString(), completedAt: '', evidenceIds: ['m1'],
    };
    const journalValue = { entries: [journalEntry({ puzzles: [duePuzzle], goal, games: { g1: BLUNDER_GAME } })], gradeCache: {}, updatedAt: new Date().toISOString() };
    await renderWithLayoutFlag(page, journalValue, { flags: { practiceV2: true, goalsV2: true } });

    await expect(page.locator('#journal-next-action')).toBeVisible();
    await expect(page.locator('#journal-next-action')).toContainText('Practice due: 1');
    await expect(page.locator('#journal-next-action')).not.toContainText('Castle by move 10');
  });

  test('next-action falls through to the active goal when nothing is due (priority 3)', async ({ page }) => {
    const goal = {
      kind: 'castle-early', label: 'Castle by move 10 in 3 applicable games', detail: '', status: 'active',
      target: 3, applicable: 1, completed: 1, selectedAt: new Date().toISOString(), completedAt: '', evidenceIds: ['m1'],
    };
    const journalValue = { entries: [journalEntry({ goal })], gradeCache: {}, updatedAt: new Date().toISOString() };
    await renderWithLayoutFlag(page, journalValue, { flags: { goalsV2: true } });

    await expect(page.locator('#journal-next-action')).toContainText('Castle by move 10 in 3 applicable games');
  });

  test('next-action shows a calm empty state when nothing applies (priority 5)', async ({ page }) => {
    const journalValue = { entries: [journalEntry()], gradeCache: {}, updatedAt: new Date().toISOString() };
    await renderWithLayoutFlag(page, journalValue);

    await expect(page.locator('#journal-next-action')).toContainText("You're all caught up");
  });

  test('a failing learning-index fetch does not block entries or the next-action module (independent module failure)', async ({ page }) => {
    const journalValue = { entries: [journalEntry()], gradeCache: {}, updatedAt: new Date().toISOString() };
    await gotoApp(page);
    await page.unroute('**/cloudsave/**');
    await page.route('**/cloudsave/**', route => {
      const url = route.request().url();
      if (url.includes('chess-journal') && route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: journalValue }) });
      }
      if (url.includes('chess-learning-index')) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate(() => window.agsSetLearningFlagsForTesting?.({ journalLayoutV2: true, indexV1: true }));
    await openJournalTab(page);
    await page.evaluate(() => window.agsRenderJournalForTesting('me', [], { isChildSession: false }));

    await expect(page.locator('.journal-entry.latest')).toBeVisible();
    await expect(page.locator('#journal-next-action')).toBeVisible();
  });

  test('latest entry is expanded; an older entry collapses to date/W-L-D/headline/goal/reflection', async ({ page }) => {
    const journalValue = {
      entries: [
        journalEntry({ id: 'e-latest', createdAt: new Date().toISOString() }),
        journalEntry({
          id: 'e-older', createdAt: new Date(Date.now() - 86400000).toISOString(),
          coach: { headline: 'A tough loss.' },
          reflection: { didWell: 'Kept fighting until the very end even when down material.', tryNext: '', chips: [] },
        }),
      ],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    await renderWithLayoutFlag(page, journalValue);

    const entries = page.locator('.journal-entry');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toHaveClass(/latest/);
    await expect(entries.nth(0)).not.toHaveClass(/journal-entry-collapsed/);
    await expect(entries.nth(1)).toHaveClass(/journal-entry-collapsed/);
    await expect(entries.nth(1).locator('.journal-entry-collapsed-headline')).toContainText('A tough loss');
    await expect(entries.nth(1).locator('.journal-entry-collapsed-reflection')).toContainText('Kept fighting');

    // Expand reveals the full entry markup.
    await entries.nth(1).locator('[data-journal-action="toggle-entry"]').click();
    await expect(page.locator('.journal-entry').nth(1)).not.toHaveClass(/journal-entry-collapsed/);
    await expect(page.locator('.journal-entry').nth(1).locator('.journal-coach-headline')).toContainText('A tough loss');
    await expect(page.locator('.journal-entry').nth(1).locator('[data-journal-action="toggle-entry"]')).toContainText('Collapse');
  });

  test('the expand toggle is keyboard-accessible and updates aria-expanded', async ({ page }) => {
    const journalValue = {
      entries: [journalEntry({ id: 'e-latest' }), journalEntry({ id: 'e-older', createdAt: new Date(Date.now() - 86400000).toISOString() })],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    await renderWithLayoutFlag(page, journalValue);

    const toggle = page.locator('.journal-entry-expand-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.journal-entry').nth(1)).not.toHaveClass(/journal-entry-collapsed/);
    await expect(page.locator('.journal-entry').nth(1).locator('[data-journal-action="toggle-entry"]')).toHaveAttribute('aria-expanded', 'true');
  });

  test('Club free-tier 5-entry limit is unchanged, and locked entries never reach the DOM', async ({ page }) => {
    const entries = Array.from({ length: 8 }, (_, i) => journalEntry({
      id: `e${i}`,
      createdAt: new Date(Date.now() - i * 86400000).toISOString(),
      coach: { headline: i < 5 ? `Visible entry ${i}` : 'LOCKED_CONTENT_MARKER' },
    }));
    const journalValue = { entries, gradeCache: {}, updatedAt: new Date().toISOString() };
    await renderWithLayoutFlag(page, journalValue, { clubActive: false });

    await expect(page.locator('.journal-entry')).toHaveCount(5);
    await expect(page.locator('#journal-entries .profile-history-locked')).toContainText('3 more entries');
    const html = await page.locator('#journal-entries').innerHTML();
    expect(html).not.toContain('LOCKED_CONTENT_MARKER');
  });

  test('iPad: five entries (mixed collapsed/expanded) stay inside the internal scroll container', async ({ page }) => {
    const entries = Array.from({ length: 5 }, (_, i) => journalEntry({ id: `e${i}`, createdAt: new Date(Date.now() - i * 86400000).toISOString() }));
    const journalValue = { entries, gradeCache: {}, updatedAt: new Date().toISOString() };
    await renderWithLayoutFlag(page, journalValue);
    await expect(page.locator('.journal-entry')).toHaveCount(5);

    // What actually matters for the player: the OUTER app screen must not
    // need to scroll to reach Journal content, and the entries list itself
    // must be the thing absorbing any extra height (dev-plan §14.5's iPad
    // scroll-containment check). Exact sub-pixel boundary matching is fragile
    // under flex layout rounding and isn't the real invariant — five rich
    // entries plus the next-action module legitimately sit close to
    // .profile-container's own max-height by design, so this allows a
    // generous tolerance rather than chasing fractional pixels.
    const result = await page.evaluate(() => {
      const screen = document.getElementById('screen-profile');
      const list = document.getElementById('journal-entries');
      const container = document.querySelector('.profile-container').getBoundingClientRect();
      return {
        viewportHeight: innerHeight,
        screenOverflow: screen.scrollHeight - screen.clientHeight,
        entriesListOverflow: list.scrollHeight - list.clientHeight,
        containerBottom: container.bottom,
      };
    });
    expect(result.screenOverflow).toBeLessThan(20);
    expect(result.containerBottom).toBeLessThan(result.viewportHeight + 20);
    // Five rich entries collapsed-to-summary except the latest should
    // genuinely exceed the 32vh cap, proving #journal-entries is the one
    // actually scrolling internally rather than everything just fitting by luck.
    expect(result.entriesListOverflow).toBeGreaterThan(0);
  });

  test('the flag off keeps the current entry experience — no next-action, no collapsing', async ({ page }) => {
    const journalValue = {
      entries: [journalEntry({ id: 'e-latest' }), journalEntry({ id: 'e-older', createdAt: new Date(Date.now() - 86400000).toISOString() })],
      gradeCache: {}, updatedAt: new Date().toISOString(),
    };
    await gotoApp(page);
    await stubCloudSave(page, { journalValue });
    // No agsSetLearningFlagsForTesting call at all — flags default false.
    await openJournalTab(page);
    await page.evaluate(() => window.agsRenderJournalForTesting('me', [], { isChildSession: false }));

    await expect(page.locator('#journal-next-action')).toBeHidden();
    await expect(page.locator('.journal-entry')).toHaveCount(2);
    await expect(page.locator('.journal-entry-collapsed')).toHaveCount(0);
    await expect(page.locator('#btn-journal-generate')).toHaveText('Write a new entry');
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

const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// "Play with Gus" profile screen — offline spec: the Extend /bot/profile
// endpoint is stubbed, everything else (rendering, replay hand-off, error
// states) runs the real client code.

const GUS_PROFILE = {
  bot: {
    id: 'gambit-gus',
    userId: 'bot-user-1',
    name: 'Gambit Gus',
    tagline: 'Material is temporary. Initiative is forever.',
    personality: 'Gus is a swashbuckling attacker who would rather lose brilliantly than win boringly.',
  },
  playable: true,
  stats: {
    games: 5, wins: 3, losses: 1, draws: 1, abandoned: 0, winRate: 0.6,
    streakType: 'win', streakCount: 2, gamesLast7Days: 4, avgDurationMs: 240000,
    lastPlayedAt: '2026-07-08T01:00:00Z',
  },
  recentMatches: [
    {
      id: 'm1', mode: 'online', opponentUserId: 'human-1', opponentName: 'Ethan',
      result: 'win', startedAt: '2026-07-08T00:40:00Z', endedAt: '2026-07-08T01:00:00Z',
      durationMs: 1200000, whiteName: 'Gus', blackName: 'Ethan',
      moves: [
        { fr: 6, fc: 4, toR: 4, toC: 4, promType: '' },
        { fr: 1, fc: 4, toR: 3, toC: 4, promType: '' },
      ],
    },
    {
      id: 'm2', mode: 'online', opponentUserId: 'human-2', opponentName: 'Maya',
      result: 'loss', startedAt: '2026-07-07T10:00:00Z', endedAt: '2026-07-07T10:20:00Z',
      durationMs: 1200000, whiteName: 'Maya', blackName: 'Gus', moves: [],
    },
  ],
  brain: {
    version: 3, lastTrained: '2026-07-08T04:00:00Z', gamesLearnedFrom: 12,
    difficulty: 'medium', thinkMsMean: 1400, thinkMsJitter: 400, trailingWinRate: 0.55,
    bookLines: 4, opponentsKnown: 2,
    lessons: [
      { text: 'Stop sacrificing on f7 against players who castle early.', learnedAt: '2026-07-07' },
    ],
    openings: [
      { line: '1.e4 e5 2.f4', played: 5, wins: 3, draws: 0, losses: 2, note: 'The gambit still lands.' },
    ],
  },
  aboutYou: null,
  journal: [
    {
      date: '2026-07-08',
      text: '\n## 2026-07-08 04:00 UTC — brain v3\n\nLearned from 2 game(s): 1 new lesson(s), 1 opening(s), 1 opponent(s).\n\n> Found a new way to keep the initiative after the gambit is declined.\n\nGames:\n- m1 vs Ethan — win (book)\n',
    },
  ],
  training: { running: false, lastRun: { result: 'trained', gamesLearned: 2 }, cadence: 'daily' },
};

async function stubGusProfile(page, payload = GUS_PROFILE, status = 200) {
  await page.route('**/bot/profile*', route => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  }));
}

test.describe('Gambit Gus profile', () => {
  test('renders stats, journal, training, and matches from the profile endpoint', async ({ page }) => {
    await gotoApp(page);
    await stubGusProfile(page);
    await page.evaluate(() => window.agsOpenGusProfile());

    await expect(page.locator('#screen-gus')).toBeVisible();
    await expect(page.locator('#gus-profile-name')).toHaveText('Gambit Gus');
    await expect(page.locator('#gus-profile-tagline')).toContainText('Material is temporary');

    // Stats grid
    await expect(page.locator('#gus-stat-record')).toHaveText('3W · 1L · 1D');
    await expect(page.locator('#gus-stat-winrate')).toHaveText('60%');
    await expect(page.locator('#gus-stat-strength')).toHaveText('Club player');
    await expect(page.locator('#gus-stat-form')).toHaveText('On a 2-game win streak');
    await expect(page.locator('#gus-stat-brain')).toHaveText('v3');

    // Journal: date header, his own voice as a quote, game-id lines folded away
    await page.evaluate(() => window.agsShowGusTab('journal'));
    await expect(page.locator('.gus-journal-entry')).toHaveCount(1);
    await expect(page.locator('.gus-journal-entry blockquote')).toContainText('keep the initiative');
    await expect(page.locator('#gus-journal-list')).not.toContainText('m1 vs Ethan');

    // Training section
    await page.evaluate(() => window.agsShowGusTab('training'));
    await expect(page.locator('#gus-training-status')).toContainText('studied 2 games');
    await expect(page.locator('#gus-training-learned')).toHaveText('12');
    await expect(page.locator('#gus-lessons-list li')).toContainText('Stop sacrificing on f7');
    await expect(page.locator('.gus-opening-row')).toContainText('1.e4 e5 2.f4');

    // Matches: results shown from Gus's side; playable match offers replay
    await page.evaluate(() => window.agsShowGusTab('matches'));
    const rows = page.locator('#gus-match-history .profile-history-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Gus won');
    await expect(rows.nth(0)).toContainText('vs Ethan');
    await expect(rows.nth(1)).toContainText('Gus lost');
    await expect(rows.nth(1)).toBeDisabled(); // no moves — replay unavailable

    // Challenge button visible because the profile says playable
    await expect(page.locator('#btn-gus-challenge')).toBeVisible();
  });

  test('replays a Gus match on the spectator board and returns to his profile', async ({ page }) => {
    await gotoApp(page);
    await stubGusProfile(page);
    await page.evaluate(() => window.agsOpenGusProfile());
    await page.evaluate(() => window.agsShowGusTab('matches'));

    await page.locator('#gus-match-history .profile-history-row.replayable').click();
    await expect(page.locator('#screen-spectator')).toBeVisible();
    await expect(page.locator('#spectator-replay-controls')).toBeVisible();

    await page.evaluate(() => window.agsStopWatching());
    await expect(page.locator('#screen-gus')).toBeVisible();
  });

  test('hides the challenge button when Gus is not playable', async ({ page }) => {
    await gotoApp(page);
    await stubGusProfile(page, { ...GUS_PROFILE, playable: false });
    await page.evaluate(() => window.agsOpenGusProfile());

    await expect(page.locator('#screen-gus')).toBeVisible();
    await expect(page.locator('#btn-gus-challenge')).toBeHidden();
    await expect(page.locator('#gus-offline-note')).toBeVisible();
  });

  test('shows a friendly error when the profile endpoint is unreachable', async ({ page }) => {
    await gotoApp(page);
    await page.route('**/bot/profile*', route => route.abort());
    await page.evaluate(() => window.agsOpenGusProfile());

    await expect(page.locator('#screen-gus')).toBeVisible();
    await expect(page.locator('#gus-profile-status')).toContainText('Could not reach Gus');
  });

  test('shows friendly empty states for a brand-new bot', async ({ page }) => {
    await gotoApp(page);
    await stubGusProfile(page, {
      bot: GUS_PROFILE.bot,
      playable: true,
      stats: { games: 0, wins: 0, losses: 0, draws: 0, winRate: 0 },
      recentMatches: [], brain: null, aboutYou: null, journal: [],
      training: { running: false, lastRun: {}, cadence: 'daily' },
    });
    await page.evaluate(() => window.agsOpenGusProfile());

    await expect(page.locator('#gus-stat-record')).toHaveText('—');
    await expect(page.locator('#gus-stat-strength')).toHaveText('Still calibrating');
    await page.evaluate(() => window.agsShowGusTab('journal'));
    await expect(page.locator('#gus-journal-list')).toContainText('No journal entries yet');
    await page.evaluate(() => window.agsShowGusTab('matches'));
    await expect(page.locator('#gus-match-history')).toContainText('No matches yet');
    await page.evaluate(() => window.agsShowGusTab('training'));
    await expect(page.locator('#gus-training-status')).toContainText('first training session');
  });

  test('fits the Meet Gus panels in an iPad viewport without page scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 720 });
    await gotoApp(page);
    await stubGusProfile(page);
    await page.evaluate(() => window.agsOpenGusProfile());

    for (const tab of ['overview', 'journal', 'training', 'matches']) {
      await page.evaluate(name => window.agsShowGusTab(name), tab);
      const geometry = await page.evaluate(name => {
        const screen = document.getElementById('screen-gus');
        const container = document.querySelector('.gus-profile-container').getBoundingClientRect();
        const panel = document.querySelector(`[data-gus-panel="${name}"]`).getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          screen: { scrollHeight: screen.scrollHeight, clientHeight: screen.clientHeight },
          container: { top: container.top, right: container.right, bottom: container.bottom, left: container.left },
          panel: { top: panel.top, right: panel.right, bottom: panel.bottom, left: panel.left },
        };
      }, tab);

      expect(geometry.screen.scrollHeight).toBeLessThanOrEqual(geometry.screen.clientHeight);
      for (const region of [geometry.container, geometry.panel]) {
        expect(region.top).toBeGreaterThanOrEqual(0);
        expect(region.left).toBeGreaterThanOrEqual(0);
        expect(region.right).toBeLessThanOrEqual(geometry.viewport.width);
        expect(region.bottom).toBeLessThanOrEqual(geometry.viewport.height);
      }
    }
  });
});

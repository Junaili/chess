const { test, expect } = require('@playwright/test');
const { gotoApp, openGuestColorSelect, blockBackend, APP_PATH } = require('./helpers.cjs');

// Signed-out navigation smoke — verifies the home entry points and the auth /
// guest screens render and route without throwing. Runs on Chromium (browser)
// and WebKit/iPad (iOS engine).
test.describe('UI smoke (signed out)', () => {
  test('home screen shows the core entry points', async ({ page }) => {
    await gotoApp(page);
    await expect(page.getByRole('heading', { name: /Ethan's Chess/i })).toBeVisible();
    await expect(page.locator('#ags-signin-btn')).toBeVisible();              // Continue with Google
    await expect(page.getByRole('button', { name: 'Create Free Account' })).toBeVisible();
    await expect(page.locator('#ags-open-guest')).toBeVisible();              // Play vs Computer as Guest
  });

  test('loads without uncaught page errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await gotoApp(page);
    await page.waitForTimeout(1000); // let boot-time async work settle
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('guest flow opens the color picker and returns home', async ({ page }) => {
    await gotoApp(page);
    await openGuestColorSelect(page);
    await page.locator('#screen-color-select .btn-back').click();
    await expect(page.locator('#screen-home')).toBeVisible();
  });

  test('login screen opens and returns home', async ({ page }) => {
    await gotoApp(page);
    await page.locator('#ags-auth-actions .auth-login-link').click();
    await expect(page.locator('#screen-login')).toBeVisible();
    await expect(page.locator('#ags-login-identifier')).toBeVisible();
    await page.locator('#screen-login .btn-back').click();
    await expect(page.locator('#screen-home')).toBeVisible();
  });

  test('register screen opens and returns home', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Create Free Account' }).click();
    await expect(page.locator('#screen-register')).toBeVisible();
    await expect(page.locator('#ags-register-email')).toBeVisible();
    await page.locator('#screen-register .btn-back').click();
    await expect(page.locator('#screen-home')).toBeVisible();
  });

  test('every password field can be revealed and hidden without changing its value', async ({ page }) => {
    await gotoApp(page);

    const cases = [
      { screen: 'login', input: '#ags-login-password' },
      { screen: 'register', input: '#ags-register-password' },
      { screen: 'forgot-password', input: '#ags-reset-password', revealReset: true },
    ];

    for (const item of cases) {
      await page.evaluate(({ screen, revealReset }) => {
        window.showScreen(screen);
        if (revealReset) document.getElementById('ags-reset-fields').hidden = false;
      }, item);

      const input = page.locator(item.input);
      const toggle = input.locator('xpath=following-sibling::button[@data-password-toggle]');
      await input.fill('correct-horse-battery-staple');

      await expect(input).toHaveAttribute('type', 'password');
      await expect(toggle).toHaveAttribute('aria-label', 'Show password');
      await toggle.click();
      await expect(input).toHaveAttribute('type', 'text');
      await expect(input).toHaveValue('correct-horse-battery-staple');
      await expect(toggle).toHaveText('Hide');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');

      await toggle.click();
      await expect(input).toHaveAttribute('type', 'password');
      await expect(input).toHaveValue('correct-horse-battery-staple');
      await expect(toggle).toHaveText('Show');
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    }
  });

  test('invite link shows the landing screen and prefills the register email', async ({ page }) => {
    await blockBackend(page);
    await page.goto(`${APP_PATH}?invitedBy=test-inviter-id&email=${encodeURIComponent('invitee@example.com')}&utm_medium=email`);
    await expect(page.locator('#screen-invite')).toBeVisible();
    await expect(page.locator('#invite-landing-title')).toHaveText(/challenged you to chess/i);

    await page.locator('.btn-invite-cta').click();
    await expect(page.locator('#screen-register')).toBeVisible();
    await expect(page.locator('#ags-register-email')).toHaveValue('invitee@example.com');
  });

  test('live-match invite link (?peer=) gates on sign-in-or-guest before joining', async ({ page }) => {
    await blockBackend(page);
    await page.goto(`${APP_PATH}?peer=test-host-peer-id`);
    await expect(page.locator('#screen-invite')).toBeVisible();
    await expect(page.locator('#invite-landing-title')).toHaveText(/waiting for you/i);

    // Live mode: account-creation CTA hidden, Google/guest options shown instead.
    await expect(page.locator('#invite-landing-actions-default')).toBeHidden();
    await expect(page.locator('#invite-landing-actions-live')).toBeVisible();
    await expect(page.locator('.invite-guest-cta')).toBeVisible();

    await page.locator('.invite-guest-cta').click();
    // Guest path marks the session and immediately attempts to join the match.
    await expect(page.locator('#screen-waiting')).toBeVisible();
    const flag = await page.evaluate(() => sessionStorage.getItem('chess_invite_guest'));
    expect(flag).toBe('1');
  });

  test('registration and chat filters reject inappropriate language locally', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Create Free Account' }).click();
    await page.locator('#ags-register-email').fill('test@example.com');
    await page.locator('#ags-register-display-name').fill('f.u.c.k');
    await page.locator('#ags-register-password').fill('not-a-real-password');
    await page.locator('#ags-register-minimum-age').check();
    await page.locator('#ags-register-submit').click();

    await expect(page.locator('#ags-register-message')).toContainText(/inappropriate language/i);
    await expect(page.locator('#ags-register-submit')).toBeEnabled();

    const chatResult = await page.evaluate(() =>
      window.chessContentModeration.moderateOutgoingChat('fuck you')
    );
    expect(chatResult.ok).toBe(false);
    expect(chatResult.error).toMatch(/not sent/i);
  });

  test('board renders 32 pieces when a guest game starts', async ({ page }) => {
    await gotoApp(page);
    await openGuestColorSelect(page);
    await page.locator('#screen-color-select .color-btn.white-btn').click();
    await page.locator('#piece-color-options > *').first().click();
    await page.locator('#screen-difficulty .diff-btn.easy').click();
    await expect(page.locator('#chess-board [data-r]')).toHaveCount(64);
    await expect(page.locator('#chess-board .piece')).toHaveCount(32);
  });

  test('match layout fits the viewport without clipping or page scrolling', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.showColorSelect('computer');
      window.selectColor('white');
      window.selectPieceColor('#fffdf5');
      window.startVsComputer('easy');
    });
    await expect(page.locator('#chess-board [data-r]')).toHaveCount(64);

    const geometry = await page.evaluate(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const rect = selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { top: box.top, right: box.right, bottom: box.bottom, left: box.left };
      };
      const screen = document.getElementById('screen-game');
      return {
        viewport,
        opponent: rect('#opponent-player-strip'),
        board: rect('.board-container'),
        player: rect('#you-player-strip'),
        status: rect('.game-status'),
        sidebar: rect('.game-sidebar.right'),
        scrollHeight: screen.scrollHeight,
        clientHeight: screen.clientHeight,
        activeCardGrid: getComputedStyle(document.querySelector('.player-info.active-player')).gridTemplateAreas,
      };
    });

    for (const region of [geometry.opponent, geometry.board, geometry.player, geometry.status, geometry.sidebar]) {
      expect(region.top).toBeGreaterThanOrEqual(0);
      expect(region.left).toBeGreaterThanOrEqual(0);
      expect(region.right).toBeLessThanOrEqual(geometry.viewport.width);
      expect(region.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    }
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
    expect(geometry.activeCardGrid).toContain('turn');
    await expect(page.locator('#privacy-center-button')).toBeHidden();

    await page.getByRole('tab', { name: 'More' }).click();
    await expect(page.locator('#btn-match-privacy')).toBeVisible();
  });

  test('iPad landscape match and dashboard stay inside a tighter safe viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 720 });
    await gotoApp(page);

    await page.evaluate(() => {
      const screen = document.getElementById('screen-home');
      screen.classList.add('signed-in');
      document.getElementById('ags-account-entry').style.display = 'none';
      document.getElementById('ags-guest-entry').style.display = 'none';
      document.getElementById('ags-signedin-info').style.display = '';
      document.getElementById('ags-stats').style.display = '';
      document.getElementById('ags-stats').textContent = 'W 10 · L 4 · ⭐ 1230';
      document.getElementById('btn-achievements').style.display = '';
      document.getElementById('ags-member-play-actions').style.display = '';
      document.getElementById('ags-friends-panel').style.display = '';
      document.getElementById('home-leaderboard-panel').style.display = '';
    });

    const homeGeometry = await page.evaluate(() => {
      const screen = document.getElementById('screen-home');
      const bounds = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        screen: { scrollHeight: screen.scrollHeight, clientHeight: screen.clientHeight },
        home: bounds('.home-container'),
        summary: bounds('#ags-player-summary'),
        left: bounds('.home-left'),
        leaderboard: bounds('#home-leaderboard-panel'),
      };
    });

    expect(homeGeometry.screen.scrollHeight).toBeLessThanOrEqual(homeGeometry.screen.clientHeight);
    for (const region of [homeGeometry.home, homeGeometry.summary, homeGeometry.left, homeGeometry.leaderboard]) {
      expect(region.top).toBeGreaterThanOrEqual(0);
      expect(region.left).toBeGreaterThanOrEqual(0);
      expect(region.right).toBeLessThanOrEqual(homeGeometry.viewport.width);
      expect(region.bottom).toBeLessThanOrEqual(homeGeometry.viewport.height);
    }

    await expect(page.getByRole('button', { name: 'Invite Outside Friend' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Share Invite Link' }).click();
    await expect(page.locator('#ags-invite-share-row .share-row-title')).toContainText('Invite outside friends');
    await expect(page.locator('#ags-invite-share-row .share-row-copy')).toContainText('Share a link');
    await expect(page.locator('#ags-invite-share-row')).toContainText('Copy');
    await expect(page.locator('#ags-invite-share-row')).toContainText('WhatsApp');
    await expect(page.locator('#ags-invite-share-row')).toContainText('Email');
    await expect(page.locator('#ags-invite-share-row')).toContainText('More');
    await expect(page.locator('#ags-invite-share-row')).not.toContainText('𝕏');

    await page.evaluate(() => {
      window.showColorSelect('computer');
      window.selectColor('white');
      window.selectPieceColor('#fffdf5');
      window.startVsComputer('easy');
    });
    await expect(page.locator('#chess-board [data-r]')).toHaveCount(64);

    const matchGeometry = await page.evaluate(() => {
      const screen = document.getElementById('screen-game');
      const bounds = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        screen: { scrollHeight: screen.scrollHeight, clientHeight: screen.clientHeight },
        opponent: bounds('#opponent-player-strip'),
        board: bounds('.board-container'),
        player: bounds('#you-player-strip'),
        status: bounds('.game-status'),
        sidebar: bounds('.game-sidebar.right'),
      };
    });

    expect(matchGeometry.screen.scrollHeight).toBeLessThanOrEqual(matchGeometry.screen.clientHeight);
    for (const region of [matchGeometry.opponent, matchGeometry.board, matchGeometry.player, matchGeometry.status, matchGeometry.sidebar]) {
      expect(region.top).toBeGreaterThanOrEqual(0);
      expect(region.left).toBeGreaterThanOrEqual(0);
      expect(region.right).toBeLessThanOrEqual(matchGeometry.viewport.width);
      expect(region.bottom).toBeLessThanOrEqual(matchGeometry.viewport.height);
    }
  });

  test('signed-in dashboard contains long lists without page scrolling', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      const screen = document.getElementById('screen-home');
      screen.classList.add('signed-in');
      document.getElementById('ags-account-entry').style.display = 'none';
      document.getElementById('ags-guest-entry').style.display = 'none';
      document.getElementById('ags-signedin-info').style.display = '';
      document.getElementById('ags-stats').style.display = '';
      document.getElementById('ags-stats').textContent = 'W 10 · L 4 · ⭐ 1230';
      document.getElementById('btn-achievements').style.display = '';
      document.getElementById('ags-member-play-actions').style.display = '';
      document.getElementById('ags-friends-panel').style.display = '';
      document.getElementById('home-leaderboard-panel').style.display = '';
      document.getElementById('ags-friends-list').innerHTML = Array.from(
        { length: 14 },
        (_, index) => `<div class="friend-row"><span class="friend-name">Friend ${index + 1}</span></div>`,
      ).join('');
      document.getElementById('lb-list').innerHTML = Array.from(
        { length: 20 },
        (_, index) => `<div class="lb-row"><span>${index + 1}. Player</span><strong>${20 - index}</strong></div>`,
      ).join('');
    });

    const geometry = await page.evaluate(() => {
      const screen = document.getElementById('screen-home');
      const bounds = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        screen: { scrollHeight: screen.scrollHeight, clientHeight: screen.clientHeight },
        home: bounds('.home-container'),
        friends: bounds('#ags-friends-panel'),
        leaderboard: bounds('#home-leaderboard-panel'),
      };
    });

    expect(geometry.screen.scrollHeight).toBeLessThanOrEqual(geometry.screen.clientHeight);
    for (const region of [geometry.home, geometry.friends, geometry.leaderboard]) {
      expect(region.top).toBeGreaterThanOrEqual(0);
      expect(region.left).toBeGreaterThanOrEqual(0);
      expect(region.right).toBeLessThanOrEqual(geometry.viewport.width);
      expect(region.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    }
  });

  test('profile sections stay within the viewport and use internal panels', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.showScreen('profile');
      document.getElementById('profile-chess-stats').style.display = '';
      document.getElementById('profile-account-safety').style.display = '';
      document.querySelector('[data-profile-tab="stats"]').hidden = false;
      document.querySelector('[data-profile-tab="account"]').hidden = false;
      document.getElementById('profile-match-history').innerHTML = Array.from(
        { length: 20 },
        (_, index) => `<div class="profile-history-row"><span>Game ${index + 1}</span></div>`,
      ).join('');
    });

    for (const tab of ['overview', 'stats', 'history', 'account']) {
      await page.evaluate(name => window.agsShowProfileTab(name), tab);
      const geometry = await page.evaluate(name => {
        const screen = document.getElementById('screen-profile');
        const container = document.querySelector('.profile-container').getBoundingClientRect();
        const panel = document.querySelector(`[data-profile-panel="${name}"]`).getBoundingClientRect();
        return {
          viewportHeight: innerHeight,
          screenScrollHeight: screen.scrollHeight,
          screenClientHeight: screen.clientHeight,
          container: { top: container.top, bottom: container.bottom },
          panel: { top: panel.top, bottom: panel.bottom },
        };
      }, tab);

      expect(geometry.screenScrollHeight).toBeLessThanOrEqual(geometry.screenClientHeight);
      expect(geometry.container.top).toBeGreaterThanOrEqual(0);
      expect(geometry.container.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
      expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.container.top);
      expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.container.bottom);
    }
  });

  test('friends show online count, offline overlay, and profile links', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      document.getElementById('ags-friends-panel').style.display = '';
      window.agsRenderFriendsListForTesting([
        {
          userId: 'online-user',
          displayName: 'Online Player',
          presence: { status: 'online', label: 'Online' },
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          userId: `offline-${index}`,
          displayName: `Offline Player ${index + 1}`,
          presence: { status: 'offline', label: 'Offline' },
        })),
      ]);
    });

    await expect(page.locator('.friends-group-divider')).toContainText('Online · 1');
    await expect(page.locator('#ags-count-friends')).toHaveText('13'); // total shown once, in the section header
    await expect(page.locator('#ags-friends-list .friend-row')).toHaveCount(1);
    await expect(page.locator('.offline-friends-trigger')).toContainText('12');

    const trigger = page.locator('.offline-friends-trigger');
    await trigger.click();
    const overlay = page.locator('#offline-friends-overlay');
    await expect(overlay).toBeVisible();
    await expect(page.locator('#offline-friends-list .friend-row')).toHaveCount(12);

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.getByRole('button', { name: 'View Offline Player 1 profile and stats' }).click();
    await expect(page.locator('#screen-profile')).toBeVisible();
    await expect(page.locator('#profile-display-name')).toHaveText('Offline Player 1');

    await page.evaluate(() => {
      window.showScreen('home');
      window.agsRenderFriendsListForTesting([
        {
          userId: 'offline-only',
          displayName: 'Sleeping Player',
          presence: { status: 'offline', label: 'Offline' },
        },
      ]);
    });
    await expect(page.locator('.friends-group-divider')).toHaveCount(0); // no point labeling a section with nothing in it
    await expect(page.locator('.friends-online-empty')).toContainText('No friends online right now');
  });

  test('random matchmaking shows elapsed waiting time and clears it on cancel', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.agsStartMatchmaking = () => {};
      window.agsCancelMatchmaking = () => {};
      window.startRandomMatchmaking();
    });

    const timer = page.locator('#matchmaking-wait');
    await expect(timer).toBeVisible();
    await expect(page.locator('#matchmaking-wait-time')).toHaveText('00:00');
    await expect.poll(
      () => page.locator('#matchmaking-wait-time').textContent(),
      { timeout: 3000 },
    ).toMatch(/^00:0[1-3]$/);

    await page.locator('#btn-waiting-cancel').click();
    await expect(page.locator('#screen-home')).toBeVisible();
    await expect(timer).toBeHidden();
  });

  test('leaderboard view toggle switches the active tab (All Time / This Week)', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      document.getElementById('screen-home').classList.add('signed-in');
      document.getElementById('home-leaderboard-panel').style.display = '';
    });

    const allTimeTab = page.locator('[data-lb-view="rating"]');
    const weeklyTab = page.locator('[data-lb-view="weekly"]');

    // Defaults to All Time.
    await expect(allTimeTab).toHaveClass(/active/);
    await expect(allTimeTab).toHaveAttribute('aria-selected', 'true');
    await expect(weeklyTab).not.toHaveClass(/active/);
    await expect(weeklyTab).toHaveAttribute('aria-selected', 'false');

    await weeklyTab.click();
    await expect(weeklyTab).toHaveClass(/active/);
    await expect(weeklyTab).toHaveAttribute('aria-selected', 'true');
    await expect(allTimeTab).not.toHaveClass(/active/);
    await expect(allTimeTab).toHaveAttribute('aria-selected', 'false');

    await allTimeTab.click();
    await expect(allTimeTab).toHaveClass(/active/);
    await expect(weeklyTab).not.toHaveClass(/active/);
  });
});

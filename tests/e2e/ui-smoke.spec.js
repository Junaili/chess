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
    await expect(page.getByRole('button', { name: 'Play Gambit Gus' })).toBeVisible();
  });

  test('signed-in home uses the updated play labels', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      document.getElementById('screen-home').classList.add('signed-in');
      document.getElementById('ags-member-play-actions').style.display = '';
      document.getElementById('btn-play-random').style.display = '';
    });

    await expect(page.getByRole('button', { name: 'Single Player', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Find a Chess Buddy', exact: true })).toBeVisible();
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

  test('screen transitions expose one active view and clear setup progress', async ({ page }) => {
    await gotoApp(page);
    await openGuestColorSelect(page);

    await expect(page.locator('#screen-color-select')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#screen-home')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#screen-home')).toHaveAttribute('inert', '');
    await expect(page.locator('#screen-color-select .setup-progress')).toHaveAttribute(
      'aria-label',
      'Game setup, step 1 of 3',
    );

    await page.locator('#screen-color-select .color-btn.white-btn').click();
    await expect(page.locator('#screen-piece-color .setup-progress')).toHaveAttribute(
      'aria-label',
      'Game setup, step 2 of 3',
    );
    await page.locator('#piece-color-options > *').first().click();
    await expect(page.locator('#screen-difficulty .setup-progress')).toHaveAttribute(
      'aria-label',
      'Game setup, step 3 of 3',
    );
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

  test('registration keeps its Back control reachable on tablet and desktop', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Create Free Account' }).click();
    await expect(page.locator('#screen-register')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const screen = document.querySelector('#screen-register');
      const back = document.querySelector('#screen-register .btn-back');
      const rect = back?.getBoundingClientRect();
      return {
        scrollHeight: screen?.scrollHeight || 0,
        clientHeight: screen?.clientHeight || 0,
        backBottom: rect?.bottom || 0,
      };
    });
    expect(geometry.backBottom).toBeLessThanOrEqual(geometry.clientHeight + 1);
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
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

  test('live-match invite link (?peer=) requires sign-in before joining', async ({ page }) => {
    await blockBackend(page);
    await page.goto(`${APP_PATH}?peer=test-host-peer-id`);
    await expect(page.locator('#screen-invite')).toBeVisible();
    await expect(page.locator('#invite-landing-title')).toHaveText(/waiting for you/i);

    // Live mode: account creation and sign-in options are shown; guest entry is absent.
    await expect(page.locator('#invite-landing-actions-default')).toBeHidden();
    await expect(page.locator('#invite-landing-actions-live')).toBeVisible();
    await expect(page.locator('.invite-guest-cta')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create an account to join' })).toBeVisible();

    await page.getByRole('button', { name: 'Create an account to join' }).click();
    await expect(page.locator('#screen-register')).toBeVisible();
  });

  test('temporary PeerJS signaling loss keeps an invite room alive after reconnect', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(async () => {
      class FakePeer {
        constructor() {
          this.id = 'stable-host-peer';
          this.open = false;
          this.disconnected = false;
          this.destroyed = false;
          this.reconnectCalls = 0;
          this.listeners = new Map();
        }
        on(name, handler) {
          const handlers = this.listeners.get(name) || [];
          handlers.push(handler);
          this.listeners.set(name, handlers);
          return this;
        }
        emit(name, value) {
          for (const handler of this.listeners.get(name) || []) handler(value);
        }
        reconnect() {
          this.reconnectCalls += 1;
          this.disconnected = false;
          this.open = true;
          queueMicrotask(() => this.emit('open', this.id));
        }
        destroy() {
          this.destroyed = true;
          this.open = false;
        }
      }

      const fakePeer = new FakePeer();
      window.__inviteStabilityPeer = fakePeer;
      window.chessVideoCall = {
        ...window.chessVideoCall,
        createPeer: async () => fakePeer,
      };
      await window.createOnlineRoom();
      fakePeer.open = true;
      fakePeer.emit('open', fakePeer.id);

      // PeerJS emits these in this order for a recoverable signaling loss.
      fakePeer.emit('error', { type: 'network', message: 'Lost connection to server.' });
      fakePeer.open = false;
      fakePeer.disconnected = true;
      fakePeer.emit('disconnected', fakePeer.id);
    });

    await expect(page.locator('#screen-waiting')).toBeVisible();
    await expect(page.locator('#waiting-sub')).toContainText(/waiting for your friend/i);
    // The old error path destroyed the successfully reconnected room at 2s.
    await page.waitForTimeout(2_300);
    const peerState = await page.evaluate(() => ({
      destroyed: window.__inviteStabilityPeer.destroyed,
      reconnectCalls: window.__inviteStabilityPeer.reconnectCalls,
      open: window.__inviteStabilityPeer.open,
    }));
    expect(peerState).toEqual({ destroyed: false, reconnectCalls: 1, open: true });
    await expect(page.locator('#screen-waiting')).toBeVisible();
  });

  test('invite email failures are visible and can be retried successfully', async ({ page }) => {
    let attempts = 0;
    await page.route('**/extend/invite/email', async route => {
      attempts += 1;
      await route.fulfill(attempts === 1
        ? { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Email service is temporarily unavailable.' }) }
        : { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await gotoApp(page);
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'invite-email-test';
      document.getElementById('screen-home').appendChild(host);
      window.agsShareRow(host, 'https://junaili.github.io/chess/?peer=test', {
        emailTo: 'friend@example.com',
        fromName: 'Tester',
      });
    });

    const host = page.locator('#invite-email-test');
    await host.locator('button.share-chip-email').click();
    await expect(host.locator('.share-row-status')).toContainText(/temporarily unavailable/i);
    await expect(host.getByRole('button', { name: /retry email/i })).toBeEnabled();

    await host.getByRole('button', { name: /retry email/i }).click();
    await expect(host.locator('.share-row-status')).toContainText(/sent to friend@example.com/i);
    expect(attempts).toBe(2);
  });

  test('registration and chat filters reject inappropriate language locally', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Create Free Account' }).click();
    await page.locator('#ags-register-birth-year').fill('1990');
    await page.locator('#ags-register-email').fill('test@example.com');
    await page.locator('#ags-register-display-name').fill('f.u.c.k');
    await page.locator('#ags-register-password').fill('not-a-real-password');
    await page.locator('#ags-register-terms').check();
    await page.locator('#ags-register-submit').click();

    await expect(page.locator('#ags-register-message')).toContainText(/inappropriate language/i);
    await expect(page.locator('#ags-register-submit')).toBeEnabled();

    const chatResult = await page.evaluate(() =>
      window.chessContentModeration.moderateOutgoingChat('fuck you')
    );
    expect(chatResult.ok).toBe(false);
    expect(chatResult.error).toMatch(/not sent/i);
  });

  test('under-13 registration shows the ask-a-parent panel and keeps nothing', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Create Free Account' }).click();
    const underThirteenYear = String(new Date().getFullYear() - 8);
    await page.locator('#ags-register-birth-year').fill(underThirteenYear);
    await page.locator('#ags-register-email').fill('kid@example.com');
    await page.locator('#ags-register-display-name').fill('Ethan');
    await page.locator('#ags-register-password').fill('some-password');
    await page.locator('#ags-register-submit').click();

    // The form is replaced by the parent-managed path, nothing typed survives.
    await expect(page.locator('#ags-register-ask-parent')).toBeVisible();
    await expect(page.locator('#ags-register-form')).toBeHidden();
    expect(await page.locator('#ags-register-email').inputValue()).toBe('');
    expect(await page.locator('#ags-register-password').inputValue()).toBe('');

    // Re-opening the register screen does not offer a second try this session.
    await page.locator('#ags-register-ask-parent').getByRole('button', { name: 'Got it' }).click();
    await page.getByRole('button', { name: 'Create Free Account' }).click();
    await expect(page.locator('#ags-register-ask-parent')).toBeVisible();
    await expect(page.locator('#ags-register-form')).toBeHidden();
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

  test('board supports roving keyboard navigation with spoken square labels', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.showColorSelect('computer');
      window.selectColor('white');
      window.selectPieceColor('#fffdf5');
      window.startVsComputer('easy');
    });

    const squares = page.locator('#chess-board [role="gridcell"]');
    await expect(squares).toHaveCount(64);
    await expect(squares.first()).toHaveAttribute('tabindex', '0');
    await expect(squares.nth(1)).toHaveAttribute('tabindex', '-1');
    await expect(squares.first()).toHaveAttribute('aria-label', /a8, black rook/i);

    await squares.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(squares.nth(1)).toBeFocused();
    await expect(squares.first()).toHaveAttribute('tabindex', '-1');
    await expect(squares.nth(1)).toHaveAttribute('tabindex', '0');
  });

  test('tab arrows switch linked profile panels', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.showScreen('profile');
      window.agsShowProfileTab('overview');
    });

    const overview = page.locator('#profile-tab-overview');
    const stats = page.locator('#profile-tab-stats');
    await overview.focus();
    await page.keyboard.press('ArrowRight');

    await expect(stats).toBeFocused();
    await expect(stats).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#profile-panel-stats')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#profile-panel-overview')).toHaveAttribute('aria-hidden', 'true');
  });

  test('dismissible modals trap focus and restore it to their trigger', async ({ page }) => {
    await gotoApp(page);
    const trigger = page.locator('#privacy-center-button');
    await trigger.click();

    const modal = page.locator('#privacy-center-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#app-main')).toHaveAttribute('inert', '');
    await expect(page.locator('#privacy-center-title')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.locator('#app-main')).not.toHaveAttribute('inert', '');
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

  test('profile uses the available viewport and preserves metric hierarchy', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.showScreen('profile');
      document.querySelector('.player-profile-container').classList.add('is-own-profile');
      document.getElementById('profile-display-name').textContent = 'Layout Player';
      document.getElementById('profile-rating').textContent = '1486';
      document.getElementById('profile-rank').textContent = '#12';
      document.getElementById('profile-wins').textContent = '42';
      document.getElementById('profile-losses').textContent = '18';
      document.getElementById('profile-kudos').textContent = '87';
    });

    const geometry = await page.evaluate(() => {
      const screen = document.getElementById('screen-profile');
      const container = document.querySelector('.player-profile-container').getBoundingClientRect();
      const grid = document.getElementById('profile-stats-grid');
      const rating = document.querySelector('.profile-stat--rating').getBoundingClientRect();
      const wins = document.querySelector('.profile-stat--record').getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight },
        screen: { scrollHeight: screen.scrollHeight, clientHeight: screen.clientHeight },
        container: {
          top: container.top,
          right: container.right,
          bottom: container.bottom,
          left: container.left,
          width: container.width,
          height: container.height,
        },
        columns: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
        ratingWidth: rating.width,
        winsWidth: wins.width,
      };
    });

    expect(geometry.container.width).toBeGreaterThan(900);
    expect(geometry.container.height).toBeGreaterThan(geometry.viewport.height * 0.82);
    expect(geometry.columns).toBe(4);
    expect(geometry.ratingWidth).toBeGreaterThan(geometry.winsWidth * 1.8);
    expect(geometry.screen.scrollHeight).toBeLessThanOrEqual(geometry.screen.clientHeight);
    expect(geometry.container.top).toBeGreaterThanOrEqual(0);
    expect(geometry.container.left).toBeGreaterThanOrEqual(0);
    expect(geometry.container.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.container.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  });

  test('phone profile uses two-column supporting metrics without horizontal clipping', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium covers the explicit phone viewport; WebKit runs the iPad layout.');
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page);
    await page.evaluate(() => {
      window.showScreen('profile');
      document.querySelector('.player-profile-container').classList.add('is-own-profile');
      document.getElementById('profile-display-name').textContent = 'Layout Player';
      document.getElementById('profile-rating').textContent = '1486';
      document.getElementById('profile-rank').textContent = '#12';
      document.getElementById('profile-wins').textContent = '42';
      document.getElementById('profile-losses').textContent = '18';
      document.getElementById('profile-kudos').textContent = '87';
    });

    const geometry = await page.evaluate(() => {
      const screen = document.getElementById('screen-profile');
      const container = document.querySelector('.player-profile-container').getBoundingClientRect();
      const panel = document.getElementById('profile-panel-overview').getBoundingClientRect();
      const grid = document.getElementById('profile-stats-grid');
      const rating = document.querySelector('.profile-stat--rating').getBoundingClientRect();
      const wins = document.querySelector('.profile-stat--record').getBoundingClientRect();
      const cardBounds = [...grid.children].map(card => {
        const rect = card.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        screen: { scrollHeight: screen.scrollHeight, clientHeight: screen.clientHeight },
        container: { top: container.top, right: container.right, bottom: container.bottom, left: container.left },
        panel: { left: panel.left, right: panel.right },
        columns: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
        ratingWidth: rating.width,
        winsWidth: wins.width,
        cardBounds,
      };
    });

    expect(geometry.columns).toBe(2);
    expect(geometry.ratingWidth).toBeGreaterThan(geometry.winsWidth * 1.8);
    expect(geometry.screen.scrollHeight).toBeLessThanOrEqual(geometry.screen.clientHeight);
    expect(geometry.container.top).toBeGreaterThanOrEqual(0);
    expect(geometry.container.left).toBeGreaterThanOrEqual(0);
    expect(geometry.container.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.container.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    for (const card of geometry.cardBounds) {
      expect(card.left).toBeGreaterThanOrEqual(geometry.panel.left);
      expect(card.right).toBeLessThanOrEqual(geometry.panel.right);
    }
  });

  test('a player with no completed games gets a useful Chess Stats empty state', async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(() => (
      typeof window.agsOpenProfile === 'function'
      && typeof window.agsSetCurrentUserIdForTesting === 'function'
    ));
    await page.evaluate(async () => {
      window.agsSetCurrentUserIdForTesting('new-player');
      await window.agsOpenProfile('new-player', 'New Player');
      window.agsShowProfileTab('stats');
    });

    await expect(page.locator('#profile-stats-empty')).toBeVisible();
    await expect(page.locator('#profile-stats-empty')).toContainText('starts with game one');
    await expect(page.locator('#profile-stats-empty').getByRole('button', { name: 'Play a Game' })).toBeVisible();
    await expect(page.locator('#profile-chess-stats')).toBeHidden();
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

  test('random matchmaking offers to meet Gus while waiting, and it opens his profile', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.agsStartMatchmaking = () => {};
      window.agsCancelMatchmaking = () => {};
      window.startRandomMatchmaking();
    });

    const learnGusBtn = page.locator('#btn-learn-about-gus');
    await expect(learnGusBtn).toBeVisible();
    await learnGusBtn.click();
    await expect(page.locator('#screen-gus')).toBeVisible();
  });

  test('the meet-Gus link only appears for random matchmaking, not friend invites or a direct Gus challenge', async ({ page }) => {
    await gotoApp(page);
    const learnGusBtn = page.locator('#btn-learn-about-gus');

    await page.evaluate(() => window.showWaitingScreen('host'));
    await expect(learnGusBtn).toBeHidden();

    await page.evaluate(() => window.showWaitingScreen('gus-matchmaking'));
    await expect(learnGusBtn).toBeHidden();

    await page.evaluate(() => window.showWaitingScreen('matchmaking'));
    await expect(learnGusBtn).toBeVisible();
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

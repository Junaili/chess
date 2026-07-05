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
});

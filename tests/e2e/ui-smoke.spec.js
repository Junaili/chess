const { test, expect } = require('@playwright/test');
const { gotoApp, openGuestColorSelect } = require('./helpers.cjs');

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

  test('board renders 32 pieces when a guest game starts', async ({ page }) => {
    await gotoApp(page);
    await openGuestColorSelect(page);
    await page.locator('#screen-color-select .color-btn.white-btn').click();
    await page.locator('#piece-color-options > *').first().click();
    await page.locator('#screen-difficulty .diff-btn.easy').click();
    await expect(page.locator('#chess-board [data-r]')).toHaveCount(64);
    await expect(page.locator('#chess-board .piece')).toHaveCount(32);
  });
});

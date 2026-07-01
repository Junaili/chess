const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

async function openForgotPassword(page) {
  await gotoApp(page);
  await page.evaluate(() => window.showScreen('invite'));
  const login = page.getByRole('button', { name: 'Log in with password' });
  const forgot = page.getByRole('button', { name: 'Forgot password?' });
  await expect(login).toBeVisible();
  await expect(forgot).toBeVisible();
  await forgot.click();
  await expect(page.locator('#screen-forgot-password')).toBeVisible();
}

test.describe('Password recovery', () => {
  test('requests a code and completes the password reset', async ({ page }) => {
    await openForgotPassword(page);

    let forgotPayload;
    let resetPayload;
    await page.route('**/iam/v3/public/namespaces/*/users/forgot', async route => {
      forgotPayload = route.request().postDataJSON();
      await route.fulfill({ status: 204 });
    });
    await page.route('**/iam/v3/public/namespaces/*/users/reset', async route => {
      resetPayload = route.request().postDataJSON();
      await route.fulfill({ status: 204 });
    });

    await page.locator('#ags-forgot-email').fill('player@example.com');
    await page.locator('#ags-forgot-submit').click();
    await expect(page.locator('#ags-forgot-message')).toHaveText('Reset code sent. Check your email.');
    await expect(page.locator('#ags-reset-fields')).toBeVisible();
    expect(forgotPayload.emailAddress).toBe('player@example.com');
    expect(forgotPayload.languageTag).toBeTruthy();

    await page.locator('#ags-reset-code').fill('123456');
    await page.locator('#ags-reset-password').fill('new-password-123');
    await page.locator('#ags-reset-submit').click();
    await expect(page.locator('#screen-login')).toBeVisible();
    await expect(page.locator('#ags-login-message')).toHaveText('Password updated. Sign in with your new password.');
    await expect(page.locator('#ags-login-identifier')).toHaveValue('player@example.com');
    expect(resetPayload).toMatchObject({
      code: '123456',
      emailAddress: 'player@example.com',
      newPassword: 'new-password-123',
    });
    expect(resetPayload.clientId).toBeTruthy();
  });

  test('requires a valid account email before requesting a code', async ({ page }) => {
    await openForgotPassword(page);
    await page.locator('#ags-forgot-email').fill('not-an-email');
    await page.locator('#ags-forgot-submit').click();
    await expect(page.locator('#ags-forgot-message')).toHaveText('Enter the email address for your account.');
    await expect(page.locator('#ags-reset-fields')).toBeHidden();
  });
});

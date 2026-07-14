const { test } = require('@playwright/test');
const { gotoApp, loginWithPassword } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

const creds = testCreds();

test('probe checkout url', async ({ page }) => {
  test.setTimeout(60_000);
  await gotoApp(page, { offline: false });
  await loginWithPassword(page, creds.user1.identifier, creds.user1.password);

  await page.evaluate(() => window.agsOpenClub && window.agsOpenClub());
  await page.locator('#screen-club').waitFor({ state: 'visible', timeout: 20_000 });
  let capturedBody = null;
  await page.route('**/extend/club/web-checkout', async route => {
    const response = await route.fetch();
    capturedBody = await response.json();
    await route.fulfill({ response, json: capturedBody });
  });
  await page.locator('[data-club-buy="club-family-monthly"]').click();
  await page.waitForFunction(() => window.location.href.includes('checkout.stripe.com'), null, { timeout: 20_000 });
  const body = capturedBody;
  console.log('CHECKOUT_URL', body.url);

  await page.waitForTimeout(3000);
  await page.fill('#email', 'seal.jun.fani+testuser3@gmail.com').catch(e => console.log('email fill failed', e.message));
  await page.locator('[data-testid="card-accordion-item-button"], input[value="card"]').first().click({ force: true }).catch(e => console.log('card click failed', e.message));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'scratch-stripe-checkout2.png', fullPage: true });
  for (const f of page.frames()) {
    try {
      const inputs = await f.locator('input').all();
      if (!inputs.length) continue;
      console.log('FRAME', f.name() || f.url().slice(0, 60));
      for (const inp of inputs) {
        console.log('  INPUT name=', await inp.getAttribute('name'), 'placeholder=', await inp.getAttribute('placeholder'), 'id=', await inp.getAttribute('id'), 'autocomplete=', await inp.getAttribute('autocomplete'));
      }
    } catch (e) { /* detached / cross-origin race */ }
  }
});

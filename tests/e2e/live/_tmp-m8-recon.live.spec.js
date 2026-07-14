const { test } = require('@playwright/test');
const { gotoApp, loginWithPassword } = require('../helpers.cjs');
const { testCreds } = require('../env.cjs');

const creds = testCreds();

test('recon', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await gotoApp(pageA, { offline: false });
  await gotoApp(pageB, { offline: false });
  await loginWithPassword(pageA, creds.user1.identifier, creds.user1.password);
  await loginWithPassword(pageB, creds.user2.identifier, creds.user2.password);

  async function recon(page) {
    return page.evaluate(async () => {
      const userId = window.agsCurrentUserId;
      const token = window.agsGetToken ? window.agsGetToken() : null;
      const statusRes = await fetch('/extend/club/status', {
        credentials: 'include',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      }).catch(() => null);
      const status = statusRes && statusRes.ok ? await statusRes.json() : { httpStatus: statusRes?.status };
      const familyActionsVisible = document.getElementById('ags-family-actions')?.style.display;
      const emptyVisible = document.getElementById('ags-family-empty')?.style.display;
      const familyName = document.getElementById('ags-family-name')?.textContent;
      const memberCount = document.getElementById('ags-count-family')?.textContent;
      return { userId, status, familyActionsVisible, emptyVisible, familyName, memberCount };
    });
  }
  const infoA = await recon(pageA);
  const infoB = await recon(pageB);

  console.log('USER_A', JSON.stringify(infoA));
  console.log('USER_B', JSON.stringify(infoB));

  await ctxA.close();
  await ctxB.close();
});

const { test, expect } = require('@playwright/test');
const { gotoApp } = require('./helpers.cjs');

// Regression for the friend-by-email 401: Extend calls (lookup/invite/welcome/
// referral) must refresh the AGS session and retry once when the access token
// has expired, instead of surfacing a 401. Exercises the pure retry helper
// (window.__withRefreshRetry, exposed only in dev/test builds).
test.describe('Extend call refresh-on-401 retry', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(() => typeof window.__withRefreshRetry === 'function');
  });

  test('refreshes once and retries after a 401, then succeeds', async ({ page }) => {
    const result = await page.evaluate(async () => {
      let calls = 0, refreshed = 0;
      const doRequest = async () => { calls++; return { status: calls === 1 ? 401 : 200 }; };
      const refresh = async () => { refreshed++; return { ok: true }; };
      const res = await window.__withRefreshRetry(doRequest, refresh);
      return { status: res.status, calls, refreshed };
    });
    expect(result).toEqual({ status: 200, calls: 2, refreshed: 1 });
  });

  test('does not refresh or retry when the first call succeeds', async ({ page }) => {
    const result = await page.evaluate(async () => {
      let calls = 0, refreshed = 0;
      const doRequest = async () => { calls++; return { status: 200 }; };
      const refresh = async () => { refreshed++; return { ok: true }; };
      const res = await window.__withRefreshRetry(doRequest, refresh);
      return { status: res.status, calls, refreshed };
    });
    expect(result).toEqual({ status: 200, calls: 1, refreshed: 0 });
  });

  test('does not retry when the refresh fails (still logged out)', async ({ page }) => {
    const result = await page.evaluate(async () => {
      let calls = 0, refreshed = 0;
      const doRequest = async () => { calls++; return { status: 401 }; };
      const refresh = async () => { refreshed++; return { ok: false }; };
      const res = await window.__withRefreshRetry(doRequest, refresh);
      return { status: res.status, calls, refreshed };
    });
    expect(result).toEqual({ status: 401, calls: 1, refreshed: 1 });
  });
});

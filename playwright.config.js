// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const { loadTestEnv } = require('./tests/e2e/env.cjs');

// Pull TEST_USER_* / live-test credentials from .env.test (git-ignored) into
// process.env so live specs can read them. Offline specs ignore these.
loadTestEnv();

// The vite dev server serves the app under /chess/ and proxies all AGS calls
// (/iam, /lobby, …) to the real backend, so live integration tests hit AGS
// without CORS issues. baseURL is the origin; specs navigate to '/chess/'.
const PORT = 8808;
const ORIGIN = `https://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  // Online/live flows talk to a shared backend; keep them serial to avoid
  // cross-test interference. Offline specs are still parallel-safe per file.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: ORIGIN,
    ignoreHTTPSErrors: true,            // dev server uses a self-signed cert
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // Desktop browser engine.
    {
      name: 'chromium',
      testIgnore: '**/live/**',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
    // iOS / iPad engine: WebKit is the same engine the Capacitor app runs in a
    // WKWebView, so this is the closest cross-engine proxy for the native app.
    {
      name: 'webkit-ipad',
      testIgnore: '**/live/**',
      use: { ...devices['iPad (gen 7) landscape'] },
    },
    // Live AGS integration — credential-gated, Chromium only (fake media for
    // the video-chat path), runs the specs under tests/e2e/live/.
    {
      name: 'live',
      testMatch: '**/live/**',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: `${ORIGIN}/chess/`,
    reuseExistingServer: !process.env.CI,
    ignoreHTTPSErrors: true,
    timeout: 60_000,
  },
});

const { expect } = require('@playwright/test');

const APP_PATH = '/chess/';

// AGS / realtime endpoints the dev server proxies. Offline specs abort these so
// the app boots in its signed-out, fully-local "Play vs Computer" mode.
const BACKEND_PATTERNS = [
  '**/iam/**', '**/basic/**', '**/cloudsave/**', '**/friends/**',
  '**/presence/**', '**/lobby/**', '**/social/**', '**/leaderboard/**',
  '**/match2/**', '**/session/**', '**/game-telemetry/**', '**/achievement/**',
  '**/peerjs/**', 'https://0.peerjs.com/**', 'https://api4.ipify.org/**',
];

async function blockBackend(page) {
  for (const pattern of BACKEND_PATTERNS) {
    await page.route(pattern, route => route.abort());
  }
}

// Navigate to the app. By default the AGS backend is blocked (offline mode).
async function gotoApp(page, { offline = true } = {}) {
  if (offline) await blockBackend(page);
  await page.goto(APP_PATH);
  await expect(page.locator('#screen-home')).toBeVisible();
}

// 'e2' -> { r, c } in the engine's row/col coordinates (row 0 = rank 8).
function algebraicToRC(square) {
  const file = 'abcdefgh'.indexOf(square[0]);
  const rank = Number(square[1]);
  return { r: 8 - rank, c: file };
}

function squareLocator(page, square) {
  const { r, c } = algebraicToRC(square);
  return page.locator(`#chess-board [data-r="${r}"][data-c="${c}"]`);
}

// Click a source square then a destination square. Handles the promotion modal
// if it appears (defaults to queen).
async function playMove(page, from, to, promote = 'queen') {
  await squareLocator(page, from).click();
  await squareLocator(page, to).click();
  const modal = page.locator('#promotion-modal');
  if (await modal.isVisible().catch(() => false)) {
    const option = modal.locator(`[data-piece="${promote}"]`);
    if (await option.count()) await option.first().click();
    else await page.locator('#promotion-options > *').first().click();
  }
}

// Open the signed-out "Play vs Computer as Guest" entry and reach color select.
async function openGuestColorSelect(page, guestName = 'Tester') {
  await page.locator('#ags-open-guest').click();
  await expect(page.locator('#ags-guest-options')).toBeVisible();
  if (guestName) await page.locator('#player-name-input').fill(guestName);
  await page.getByRole('button', { name: 'Continue to Game Setup' }).click();
  await expect(page.locator('#screen-color-select')).toBeVisible();
}

// Drive the home -> color -> piece-color -> difficulty -> board flow.
// `entry` is 'guest' (signed-out) or 'member' (signed-in, uses Play vs Computer).
async function startVsComputer(page, { color = 'white', difficulty = 'easy', entry = 'guest' } = {}) {
  // confirmNewGame()/resignGame() use window.confirm — auto-accept any dialog.
  page.on('dialog', dialog => dialog.accept().catch(() => {}));

  if (entry === 'member') {
    await page.getByRole('button', { name: 'Play vs Computer', exact: true }).click();
    await expect(page.locator('#screen-color-select')).toBeVisible();
  } else {
    await openGuestColorSelect(page);
  }

  await page.locator(`#screen-color-select .color-btn.${color}-btn`).click();
  await expect(page.locator('#screen-piece-color')).toBeVisible();

  // Piece-color swatches are generated dynamically — any choice is fine.
  await page.locator('#piece-color-options > *').first().click();
  await expect(page.locator('#screen-difficulty')).toBeVisible();

  await page.locator(`#screen-difficulty .diff-btn.${difficulty}`).click();
  await expect(page.locator('#screen-game')).toBeVisible();
  await expect(page.locator('#chess-board [data-r]')).toHaveCount(64);
}

// Open the login screen, submit username/password, and wait for either the
// signed-in card or the legal-acceptance gate. Returns 'signed-in' | 'legal'.
async function loginWithPassword(page, identifier, password) {
  await page.locator('#ags-auth-actions .auth-login-link').click(); // "Already have an account? Sign in"
  await expect(page.locator('#screen-login')).toBeVisible();
  await page.locator('#ags-login-identifier').fill(identifier);
  await page.locator('#ags-login-password').fill(password);
  await page.locator('#ags-login-submit').click();

  const signedIn = page.locator('#ags-signedin-info');
  const legal = page.locator('#screen-legal');
  await expect.poll(
    async () => (await signedIn.isVisible()) || (await legal.isVisible()),
    { message: 'signed-in card or legal-acceptance gate should become visible', timeout: 30_000 },
  ).toBe(true);

  if (await legal.isVisible()) {
    await page.locator('#ags-legal-confirm').check();
    await page.locator('#ags-legal-accept').click();
    await expect(signedIn).toBeVisible({ timeout: 20_000 });
    return 'legal';
  }
  return 'signed-in';
}

module.exports = {
  APP_PATH,
  blockBackend,
  gotoApp,
  algebraicToRC,
  squareLocator,
  playMove,
  openGuestColorSelect,
  startVsComputer,
  loginWithPassword,
};

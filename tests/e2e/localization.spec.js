const { test, expect } = require('@playwright/test')
const { gotoApp } = require('./helpers.cjs')

test.describe('Localization', () => {
  test('switches and persists Indonesian and Malay UI', async ({ page }) => {
    await gotoApp(page)

    const language = page.locator('#app-language-select')
    await language.selectOption('id')
    await expect(page.locator('html')).toHaveAttribute('lang', 'id-ID')
    await expect(page.locator('#screen-home h1')).toContainText('Catur Ethan')
    await expect(page.locator('#ags-open-guest')).toHaveText('Main melawan Gambit Gus')

    // Regression: switching straight between two non-English locales used to
    // leave stale text behind on some nodes (root cause was unrelated to
    // which two locales — a caching bug in the DOM walker) — every node that
    // held Indonesian text a moment ago must actually become Malay here, not
    // just the ones this test happens to assert on individually.
    await language.selectOption('ms')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ms-MY')
    await expect(page.locator('#screen-home h1')).toContainText('Catur Ethan')
    await expect(page.locator('#ags-open-guest')).toHaveText('Main dengan Gambit Gus')
    await expect(page.locator('#btn-play-random')).toHaveText('Cari Rakan Catur')

    await page.reload()
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 })
    await expect(page.locator('#app-language-select')).toHaveValue('ms')
    await expect(page.locator('#screen-home h1')).toContainText('Catur Ethan')
  })

  test('translates cataloged runtime copy and preserves opted-out player content', async ({ page }) => {
    await gotoApp(page)
    await page.locator('#app-language-select').selectOption('id')
    await page.evaluate(() => {
      const translated = document.createElement('p')
      translated.id = 'dynamic-localized-copy'
      translated.textContent = 'Loading achievements…'
      document.body.appendChild(translated)

      const playerCopy = document.createElement('p')
      playerCopy.id = 'dynamic-player-copy'
      playerCopy.dataset.i18nIgnore = ''
      playerCopy.textContent = 'Player'
      document.body.appendChild(playerCopy)
    })

    await expect(page.locator('#dynamic-localized-copy')).toHaveText('Memuat pencapaian…')
    await expect(page.locator('#dynamic-player-copy')).toHaveText('Player')
  })

  test('passes the selected language to AGS IAM email requests', async ({ page }) => {
    await gotoApp(page)
    await page.locator('#app-language-select').selectOption('ms')
    let requestBody = null
    await page.route('**/iam/v3/public/namespaces/*/users/forgot', route => {
      requestBody = route.request().postDataJSON()
      return route.fulfill({ status: 204, body: '' })
    })

    await page.locator('#ags-auth-actions .auth-login-link').click()
    await page.locator('#ags-login-forgot').click()
    await page.locator('#ags-forgot-email').fill('player@example.com')
    await page.locator('#ags-forgot-submit').click()

    await expect.poll(() => requestBody?.languageTag).toBe('ms-MY')
  })

  test('requests and renders the selected AGS Platform catalog localization', async ({ page }) => {
    await gotoApp(page)
    await page.locator('#app-language-select').selectOption('id')
    let catalogLanguage = null
    await page.route('**/items/byCriteria*', route => {
      catalogLanguage = new URL(route.request().url()).searchParams.get('language')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [{
          itemId: 'localized-board',
          sku: 'cos-board-localized',
          localizations: {
            en: { title: 'Localized Board', description: 'English description.' },
            id: { title: 'Papan Lokal', description: 'Deskripsi Indonesia.' },
          },
          regionData: [{ price: 100, currencyCode: 'ETHC' }],
        }] }),
      })
    })
    await page.route('**/entitlements*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }),
    }))
    await page.route('**/club/status*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false, coins: 250, activeSkus: [], canPurchase: true }),
    }))

    await page.evaluate(() => { window.agsCurrentUserId = 'locale-test-user' })
    await page.evaluate(() => window.agsOpenCoinStore())

    await expect.poll(() => catalogLanguage).toBe('id')
    await expect(page.locator('.cosmetic-card-name')).toHaveText('Papan Lokal')
    await expect(page.locator('.cosmetic-card-desc')).toHaveText('Deskripsi Indonesia.')
  })
})

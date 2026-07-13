const { test, expect } = require('@playwright/test')
const { APP_PATH, gotoApp } = require('./helpers.cjs')

test('player can decline and later enable optional analytics', async ({ page }) => {
  await gotoApp(page, { privacyChoice: null })

  const banner = page.locator('#privacy-consent-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'No thanks' }).click()
  await expect(banner).toBeHidden()

  await page.getByRole('button', { name: 'Privacy & Support' }).click()
  await expect(page.locator('#privacy-center-modal')).toBeVisible()
  await expect(page.locator('#privacy-choice-status')).toContainText('disabled')
  await expect(page.getByRole('link', { name: 'jun@accelbyte.ai' })).toHaveAttribute('href', /mailto:jun@accelbyte\.ai/)

  await page.locator('#privacy-analytics-toggle').check()
  await page.getByRole('button', { name: 'Save Choice' }).click()
  await expect(page.locator('#privacy-center-modal')).toBeHidden()

  await page.getByRole('button', { name: 'Privacy & Support' }).click()
  await expect(page.locator('#privacy-choice-status')).toContainText('enabled')
})

test('first-visit consent stays below the signed-in dashboard', async ({ page }) => {
  await gotoApp(page, { privacyChoice: null })
  await page.evaluate(() => {
    document.getElementById('screen-home').classList.add('signed-in')
    for (const id of ['ags-account-entry', 'ags-auth-actions', 'ags-signin-btn', 'ags-guest-entry']) {
      document.getElementById(id).style.display = 'none'
    }
    document.getElementById('ags-signedin-info').style.display = 'flex'
    document.getElementById('ags-signedin-name').textContent = 'JunHotmail'
  })
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('#screen-home .home-left')?.getBoundingClientRect()
    const banner = document.querySelector('#privacy-consent-banner')?.getBoundingClientRect()
    return { panelBottom: panel?.bottom || 0, bannerTop: banner?.top || 0 }
  })
  expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.bannerTop + 1)
})

test('published legal page contains privacy, terms, community, and support', async ({ page }) => {
  await page.goto(`${APP_PATH}legal/index.html#privacy`)
  await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Terms of Use' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Community Standards' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Support', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Email Jun at jun@accelbyte.ai' })).toHaveAttribute('href', 'mailto:jun@accelbyte.ai')
})

function injectLegalReaderTrigger(page) {
  return page.evaluate(() => {
    const button = document.createElement('button')
    button.textContent = 'Open test legal reader'
    document.getElementById('screen-home').appendChild(button)
    button.addEventListener('click', () => window.agsOpenLegalDocument({
      policyName: 'Privacy Policy',
      policyVersionDisplay: '1.0',
      localeCode: 'en-US',
      localizedPolicyVersionId: 'test-privacy',
      attachmentLocation: 'https://localhost:8808/chess/test-privacy.md',
    }, button))
  })
}

// The in-app reader fetches from AGS's CloudFront CDN via CapacitorHttp,
// which is a native HTTP client (not subject to browser CORS) — on native
// only. This test forces isNativePlatform() so it can still exercise the
// reader's own rendering/scroll/focus mechanics in a plain browser; the web
// (non-native) case is covered separately below, since real web users never
// reach a working fetch here (see src/legal.js fetchLegalAttachment).
test('legal documents open and complete inside the app without a popup (native)', async ({ page, context }) => {
  await page.route('**/test-privacy.md', route => route.fulfill({
    status: 200,
    contentType: 'text/markdown',
    headers: { 'access-control-allow-origin': '*' },
    body: `# Privacy Policy\n\n${'This is an important policy paragraph.\n\n'.repeat(80)}`,
  }))
  await gotoApp(page)
  await page.evaluate(() => { window.Capacitor = { isNativePlatform: () => true } })

  const trigger = page.getByRole('button', { name: 'Open test legal reader' })
  await injectLegalReaderTrigger(page)

  const pageCount = context.pages().length
  await trigger.click()
  const overlay = page.locator('#legal-reader-overlay')
  await expect(overlay).toBeVisible()
  await expect(page.locator('#legal-reader-title')).toHaveText('Privacy Policy')
  await expect(page.locator('#legal-reader-content')).toContainText('important policy paragraph')
  expect(context.pages()).toHaveLength(pageCount)

  const finish = page.locator('#legal-reader-finish')
  await expect(finish).toBeDisabled()
  await page.locator('#legal-reader-scroll').evaluate(element => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(finish).toBeEnabled()
  await finish.click()
  await expect(overlay).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(context.pages()).toHaveLength(pageCount)
})

// Regression test for the reported bug: on web, fetching a legal attachment
// straight from CloudFront always fails with a CORS error the browser logs
// itself, regardless of how gracefully the resulting rejection is handled —
// so the fix is to never attempt that fetch on web at all (see
// fetchLegalAttachment's early return) rather than merely catching the error.
test('the in-app reader never fetches the CloudFront attachment on web (no CORS error)', async ({ page }) => {
  const consoleErrors = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  let attachmentFetched = false
  await page.route('**/test-privacy.md', route => {
    attachmentFetched = true
    route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Privacy Policy' })
  })
  await gotoApp(page)
  // No window.Capacitor mock here — this is the real default for a web build.

  const trigger = page.getByRole('button', { name: 'Open test legal reader' })
  await injectLegalReaderTrigger(page)
  await trigger.click()

  await expect(page.locator('#legal-reader-error')).toBeVisible()
  expect(attachmentFetched).toBe(false)
  expect(consoleErrors.some(text => /CORS|Access-Control/i.test(text))).toBe(false)
})

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

  await page.locator('#privacy-analytics-toggle').check()
  await page.getByRole('button', { name: 'Save Choice' }).click()
  await expect(page.locator('#privacy-center-modal')).toBeHidden()

  await page.getByRole('button', { name: 'Privacy & Support' }).click()
  await expect(page.locator('#privacy-choice-status')).toContainText('enabled')
})

test('published legal page contains privacy, terms, community, and support', async ({ page }) => {
  await page.goto(`${APP_PATH}legal/index.html#privacy`)
  await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Terms of Use' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Community Standards' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Support', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open a support request' })).toHaveAttribute('href', /github\.com\/junaili\/chess\/issues\/new/)
})

test('legal documents open and complete inside the app without a popup', async ({ page, context }) => {
  await page.route('**/test-privacy.md', route => route.fulfill({
    status: 200,
    contentType: 'text/markdown',
    headers: { 'access-control-allow-origin': '*' },
    body: `# Privacy Policy\n\n${'This is an important policy paragraph.\n\n'.repeat(80)}`,
  }))
  await gotoApp(page)

  const trigger = page.getByRole('button', { name: 'Open test legal reader' })
  await page.evaluate(() => {
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

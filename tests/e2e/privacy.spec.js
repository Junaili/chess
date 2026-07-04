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

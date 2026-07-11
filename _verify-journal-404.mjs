import { chromium } from 'playwright'

const identifier = process.env.TEST_USER_1_IDENTIFIER
const password = process.env.TEST_USER_1_PASSWORD

const browser = await chromium.launch({ ignoreHTTPSErrors: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await context.newPage()

const consoleErrors = []
const pageErrors = []
const requests404 = []
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', err => pageErrors.push(err.message))
page.on('response', res => { if (res.status() === 404) requests404.push(res.url()) })

await page.goto('https://localhost:8808/chess/', { waitUntil: 'networkidle' })

await page.evaluate(() => window.agsOpenLogin && window.agsOpenLogin())
await page.fill('#ags-login-identifier', identifier)
await page.fill('#ags-login-password', password)
await page.evaluate(() => window.agsPasswordLogin && window.agsPasswordLogin())
await page.waitForTimeout(3000)

console.log('logged in, current screen:', await page.evaluate(() => document.querySelector('.screen.active')?.id))

consoleErrors.length = 0
pageErrors.length = 0
requests404.length = 0

// Open own profile the way the "My Account" button does
await page.evaluate(() => window.agsOpenMyProfile && window.agsOpenMyProfile())
await page.waitForTimeout(2000)

console.log('=== after opening own profile ===')
console.log('404s:', JSON.stringify(requests404, null, 2))
console.log('console errors:', JSON.stringify(consoleErrors, null, 2))
console.log('page errors:', JSON.stringify(pageErrors, null, 2))

// Inspect the profile modal / journal tab DOM state
const profileVisible = await page.evaluate(() => {
  const modal = document.getElementById('profile-modal') || document.querySelector('.profile-modal')
  return modal ? getComputedStyle(modal).display : 'NO MODAL FOUND'
})
console.log('profile modal display:', profileVisible)

const journalTabHTML = await page.evaluate(() => {
  const el = document.getElementById('profile-journal') || document.querySelector('[id*="journal"]')
  return el ? el.outerHTML.slice(0, 500) : 'NO JOURNAL ELEMENT FOUND'
})
console.log('journal tab snippet:', journalTabHTML)

await browser.close()

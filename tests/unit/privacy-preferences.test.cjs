const assert = require('node:assert/strict')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const modulePromise = import(pathToFileURL(
  path.resolve(__dirname, '../../src/privacy-preferences.mjs'),
))

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

test('analytics defaults off until the player makes a choice', async () => {
  const { readPrivacyPreferences, hasAnalyticsConsent } = await modulePromise
  const storage = memoryStorage()
  assert.deepEqual(readPrivacyPreferences(storage), {
    analytics: false,
    decided: false,
    updatedAt: '',
  })
  assert.equal(hasAnalyticsConsent(storage), false)
})

test('stores explicit analytics consent and withdrawal', async () => {
  const {
    readPrivacyPreferences,
    writePrivacyPreferences,
    hasAnalyticsConsent,
  } = await modulePromise
  const storage = memoryStorage()

  writePrivacyPreferences({ analytics: true }, storage)
  assert.equal(readPrivacyPreferences(storage).decided, true)
  assert.equal(hasAnalyticsConsent(storage), true)

  writePrivacyPreferences({ analytics: false }, storage)
  assert.equal(readPrivacyPreferences(storage).decided, true)
  assert.equal(hasAnalyticsConsent(storage), false)
})

test('invalid saved preferences fail closed', async () => {
  const { PRIVACY_PREFERENCES_KEY, readPrivacyPreferences } = await modulePromise
  const storage = memoryStorage({ [PRIVACY_PREFERENCES_KEY]: '{not-json' })
  assert.equal(readPrivacyPreferences(storage).analytics, false)
  assert.equal(readPrivacyPreferences(storage).decided, false)
})

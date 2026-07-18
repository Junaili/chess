const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'learning-notification-preferences.mjs')
))

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

test('loadLearningPreferences: no account scope or no storage returns safe defaults', async () => {
  const { loadLearningPreferences } = await modulePromise
  assert.equal(loadLearningPreferences('', memoryStorage()).inAppEnabled, true)
  assert.equal(loadLearningPreferences('user-1', null).inAppEnabled, true)
})

test('saveLearningPreferences then loadLearningPreferences round-trips', async () => {
  const { saveLearningPreferences, loadLearningPreferences } = await modulePromise
  const storage = memoryStorage()
  saveLearningPreferences('user-1', { inAppEnabled: false, nativeEnabled: true, preferredLocalTime: '18:00' }, storage)
  const loaded = loadLearningPreferences('user-1', storage)
  assert.equal(loaded.inAppEnabled, false)
  assert.equal(loaded.nativeEnabled, true)
  assert.equal(loaded.preferredLocalTime, '18:00')
  assert.ok(loaded.updatedAt)
})

test('preferences are scoped per account — one account never sees another\'s', async () => {
  const { saveLearningPreferences, loadLearningPreferences } = await modulePromise
  const storage = memoryStorage()
  saveLearningPreferences('user-1', { inAppEnabled: false }, storage)
  saveLearningPreferences('user-2', { inAppEnabled: true }, storage)
  assert.equal(loadLearningPreferences('user-1', storage).inAppEnabled, false)
  assert.equal(loadLearningPreferences('user-2', storage).inAppEnabled, true)
})

test('corrupt stored JSON falls back to safe defaults, never throws', async () => {
  const { loadLearningPreferences } = await modulePromise
  const storage = memoryStorage({ 'chess_learning_notification_preferences_v1:user-1': '{not-json' })
  const loaded = loadLearningPreferences('user-1', storage)
  assert.equal(loaded.inAppEnabled, true)
  assert.equal(loaded.nativeEnabled, false)
})

test('clearLearningPreferences removes only that account\'s entry', async () => {
  const { saveLearningPreferences, loadLearningPreferences, clearLearningPreferences } = await modulePromise
  const storage = memoryStorage()
  saveLearningPreferences('user-1', { inAppEnabled: false }, storage)
  saveLearningPreferences('user-2', { inAppEnabled: false }, storage)
  clearLearningPreferences('user-1', storage)
  assert.equal(loadLearningPreferences('user-1', storage).inAppEnabled, true) // back to default
  assert.equal(loadLearningPreferences('user-2', storage).inAppEnabled, false) // untouched
})

test('a throwing storage never propagates — save/load degrade to defaults', async () => {
  const { saveLearningPreferences, loadLearningPreferences } = await modulePromise
  const throwingStorage = {
    getItem: () => { throw new Error('boom') },
    setItem: () => { throw new Error('boom') },
    removeItem: () => { throw new Error('boom') },
  }
  assert.doesNotThrow(() => saveLearningPreferences('user-1', { inAppEnabled: false }, throwingStorage))
  assert.doesNotThrow(() => loadLearningPreferences('user-1', throwingStorage))
})

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'learning-notification-ledger.mjs')
))

const NOW = new Date('2026-07-17T19:00:00.000Z')

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

test('loadLearningLedger: no account scope or no storage returns safe defaults', async () => {
  const { loadLearningLedger } = await modulePromise
  assert.deepEqual(loadLearningLedger('', memoryStorage()).externalDeliveries, [])
  assert.deepEqual(loadLearningLedger('user-1', null).externalDeliveries, [])
})

test('recordDismissedForToday persists and is readable back', async () => {
  const { recordDismissedForToday, loadLearningLedger } = await modulePromise
  const storage = memoryStorage()
  recordDismissedForToday('user-1', 'practice_due', NOW, storage)
  const ledger = loadLearningLedger('user-1', storage)
  assert.ok(Date.parse(ledger.byKind.practice_due.dismissedUntil) > NOW.getTime())
})

test('recordExternalDelivery accumulates across calls for the same account', async () => {
  const { recordExternalDelivery, loadLearningLedger } = await modulePromise
  const storage = memoryStorage()
  recordExternalDelivery('user-1', 'practice_due', NOW, storage)
  recordExternalDelivery('user-1', 'review_unfinished', new Date(NOW.getTime() + 1000), storage)
  const ledger = loadLearningLedger('user-1', storage)
  assert.equal(ledger.externalDeliveries.length, 2)
  assert.equal(ledger.byKind.review_unfinished.lastShownAt, new Date(NOW.getTime() + 1000).toISOString())
})

test('recordIgnored then recordCompleted resets the ignored count', async () => {
  const { recordIgnored, recordCompleted, loadLearningLedger } = await modulePromise
  const storage = memoryStorage()
  recordIgnored('user-1', 'recap_ready', NOW, storage)
  recordIgnored('user-1', 'recap_ready', NOW, storage)
  assert.equal(loadLearningLedger('user-1', storage).byKind.recap_ready.consecutiveIgnored, 2)
  recordCompleted('user-1', 'recap_ready', storage)
  assert.equal(loadLearningLedger('user-1', storage).byKind.recap_ready.consecutiveIgnored, 0)
})

test('ledger is scoped per account — one account never sees another\'s deliveries', async () => {
  const { recordExternalDelivery, loadLearningLedger } = await modulePromise
  const storage = memoryStorage()
  recordExternalDelivery('user-1', 'practice_due', NOW, storage)
  assert.equal(loadLearningLedger('user-2', storage).externalDeliveries.length, 0)
})

test('recordPendingReminder then clearPendingReminder round-trips the single pending slot', async () => {
  const { recordPendingReminder, clearPendingReminder, loadLearningLedger } = await modulePromise
  const storage = memoryStorage()
  recordPendingReminder('user-1', { nativeId: 41001, kind: 'practice_due', deliverAt: NOW.toISOString() }, storage)
  assert.deepEqual(loadLearningLedger('user-1', storage).pending, { nativeId: 41001, kind: 'practice_due', deliverAt: NOW.toISOString() })
  clearPendingReminder('user-1', storage)
  assert.equal(loadLearningLedger('user-1', storage).pending, null)
})

test('corrupt stored JSON falls back to safe defaults, never throws', async () => {
  const { loadLearningLedger } = await modulePromise
  const storage = memoryStorage({ 'chess_learning_notification_ledger_v1:user-1': 'not json at all' })
  assert.doesNotThrow(() => loadLearningLedger('user-1', storage))
  assert.deepEqual(loadLearningLedger('user-1', storage).externalDeliveries, [])
})

test('clearLearningLedger removes only that account\'s entry', async () => {
  const { recordExternalDelivery, loadLearningLedger, clearLearningLedger } = await modulePromise
  const storage = memoryStorage()
  recordExternalDelivery('user-1', 'practice_due', NOW, storage)
  recordExternalDelivery('user-2', 'practice_due', NOW, storage)
  clearLearningLedger('user-1', storage)
  assert.equal(loadLearningLedger('user-1', storage).externalDeliveries.length, 0)
  assert.equal(loadLearningLedger('user-2', storage).externalDeliveries.length, 1)
})

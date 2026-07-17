// Private CloudSave read/write for the "chess-learning-index" record
// (dev-plan §6.2, §6.3, §11.1). Mirrors src/journal.js's private-record IO
// pattern exactly: getRecord-only reads (never probe the public getter —
// this record must never exist publicly), update-or-create writes.
//
// Lazy by construction: only src/review.js imports this file, and
// review.js itself only loads behind the M3 feature flag — so this module
// (and the @accelbyte/sdk-cloudsave import it pulls in) never reaches an
// owner who hasn't opened Review or an own-profile History with the M4 flag.

import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'
import { sdk } from './ags-client.js'
import { normalizeLearningRecord, buildLearningRecordValue, mergeReviewIntoRecord } from './learning-contract.mjs'

const LEARNING_INDEX_KEY = 'chess-learning-index'

function cloudSaveApi() {
  const { coreConfig } = sdk.assembly()
  return PublicPlayerRecordApi(sdk, { coreConfig: { ...coreConfig, useSchemaValidation: false } })
}

// In-memory cache of the last record fetched, keyed by userId — a switch to
// a different userId (profile change, or a fresh login after logout)
// naturally invalidates it without needing a special-cased clear.
let cache = null // { userId, record }
// Per-page write queue (dev-plan §6.3): serializes concurrent upsertReview()
// calls so they don't race each other's read-modify-write cycle. The shared
// chain itself must never reject — only the promise returned to an
// individual caller does — or one failed save would wedge every save after it.
let queue = Promise.resolve()

async function fetchLearningRecord(userId) {
  try {
    const res = await cloudSaveApi().getRecord_ByUserId_ByKey(userId, LEARNING_INDEX_KEY)
    return normalizeLearningRecord(res.data?.value)
  } catch (e) {
    if (e?.response?.status !== 404) console.warn('[learning] fetch:', e?.response?.data || e?.message)
    return normalizeLearningRecord(null)
  }
}

async function saveLearningRecord(userId, record) {
  const value = buildLearningRecordValue(record)
  const api = cloudSaveApi()
  try {
    await api.updateRecord_ByUserId_ByKey(userId, LEARNING_INDEX_KEY, value)
  } catch (e) {
    if (e?.response?.status !== 404) throw e
    await api.createRecord_ByUserId_ByKey(userId, LEARNING_INDEX_KEY, value)
  }
  return normalizeLearningRecord(value)
}

// loadLearningIndex: the read path History's badge-patching uses (dev-plan
// §11.3). Callers are responsible for only calling this for
// userId === currentUserId (dev-plan §11.4) — this module has no notion of
// "current user" of its own to enforce that itself.
export async function loadLearningIndex(userId) {
  if (cache?.userId === userId) return cache.record
  const record = await fetchLearningRecord(userId)
  cache = { userId, record }
  return record
}

// upsertReview: read-modify-write through the serialized queue. Returns a
// promise that rejects if THIS write failed (so a caller can show "Could not
// save"), while the shared queue keeps processing later writes regardless.
export function upsertReview(userId, review) {
  const result = queue.then(async () => {
    const current = cache?.userId === userId ? cache.record : await fetchLearningRecord(userId)
    const merged = mergeReviewIntoRecord(current, review)
    const saved = await saveLearningRecord(userId, merged)
    cache = { userId, record: saved }
    return saved
  })
  queue = result.catch(() => {})
  return result
}

// resetLearningCache: drop the in-memory record on logout/account
// deletion/profile change (dev-plan §11.4). Does not touch the write queue —
// an in-flight save should still complete; nothing after this reads the
// dropped cache the wrong way, since the very next loadLearningIndex() call
// simply refetches under whatever userId it's given.
export function resetLearningCache() {
  cache = null
}

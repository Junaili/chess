// Account-scoped local preference storage for the chess-improvement
// notification system (notification dev-plan §13.6). Device-local by design
// — delivery itself is device-local, so there is deliberately no CloudSave
// record here (§13.6: "Do not add a CloudSave preference record until
// cross-device reminders exist"). Follows the same injectable-storage
// pattern as src/privacy-preferences.mjs so it's unit-testable without a
// browser: pass a storage-shaped object in tests, omit it in production to
// default to globalThis.localStorage.

import { normalizeLearningPreferences } from './learning-notification-policy.mjs'

const KEY_PREFIX = 'chess_learning_notification_preferences_v1'

function storageOrNull(storage) {
  if (storage) return storage
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

function storageKey(accountScope) {
  return `${KEY_PREFIX}:${accountScope}`
}

export function loadLearningPreferences(accountScope, storage) {
  const target = storageOrNull(storage)
  if (!accountScope || !target) return normalizeLearningPreferences(null)
  try {
    const raw = target.getItem(storageKey(accountScope))
    return normalizeLearningPreferences(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeLearningPreferences(null)
  }
}

export function saveLearningPreferences(accountScope, preferences, storage) {
  const normalized = normalizeLearningPreferences({ ...preferences, updatedAt: new Date().toISOString() })
  const target = storageOrNull(storage)
  if (accountScope && target) {
    try {
      target.setItem(storageKey(accountScope), JSON.stringify(normalized))
    } catch {
      // Preference choice still applies for this session when storage is unavailable.
    }
  }
  return normalized
}

export function clearLearningPreferences(accountScope, storage) {
  const target = storageOrNull(storage)
  if (!accountScope || !target) return
  try { target.removeItem(storageKey(accountScope)) } catch {}
}

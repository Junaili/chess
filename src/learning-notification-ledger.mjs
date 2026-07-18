// Account-scoped local delivery-ledger storage for the chess-improvement
// notification system (notification dev-plan §13.7). Same injectable-storage
// pattern as src/privacy-preferences.mjs / learning-notification-preferences.mjs.
// The actual dedupe/cap/backoff math lives in the pure
// normalizeLearningLedger/appendExternalDelivery/applyIgnoredOutcome/
// applyCompletedOutcome functions in learning-notification-policy.mjs — this
// module is only the read/persist wrapper around them.

import {
  normalizeLearningLedger, appendExternalDelivery, applyIgnoredOutcome, applyCompletedOutcome,
} from './learning-notification-policy.mjs'

const KEY_PREFIX = 'chess_learning_notification_ledger_v1'

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

export function loadLearningLedger(accountScope, storage) {
  const target = storageOrNull(storage)
  if (!accountScope || !target) return normalizeLearningLedger(null)
  try {
    const raw = target.getItem(storageKey(accountScope))
    return normalizeLearningLedger(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeLearningLedger(null)
  }
}

function persist(accountScope, ledger, storage) {
  const target = storageOrNull(storage)
  if (accountScope && target) {
    try {
      target.setItem(storageKey(accountScope), JSON.stringify(ledger))
    } catch {
      // Ledger state still applies for this session when storage is unavailable.
    }
  }
  return ledger
}

export function saveLearningLedger(accountScope, ledger, storage) {
  return persist(accountScope, normalizeLearningLedger(ledger), storage)
}

// recordDismissedForToday: in-app "Not now" (dev-plan §11.1) — reuses the
// same byKind.dismissedUntil field the policy module's selectInAppCandidate
// already reads.
export function recordDismissedForToday(accountScope, kind, now = new Date(), storage) {
  const ledger = loadLearningLedger(accountScope, storage)
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  const existing = ledger.byKind[kind] || {}
  const next = { ...ledger, byKind: { ...ledger.byKind, [kind]: { ...existing, dismissedUntil: endOfDay.toISOString() } } }
  return persist(accountScope, next, storage)
}

export function recordExternalDelivery(accountScope, kind, now = new Date(), storage) {
  return persist(accountScope, appendExternalDelivery(loadLearningLedger(accountScope, storage), kind, now), storage)
}

export function recordIgnored(accountScope, kind, now = new Date(), storage) {
  return persist(accountScope, applyIgnoredOutcome(loadLearningLedger(accountScope, storage), kind, now), storage)
}

export function recordCompleted(accountScope, kind, storage) {
  return persist(accountScope, applyCompletedOutcome(loadLearningLedger(accountScope, storage), kind), storage)
}

// recordPendingReminder / clearPendingReminder: the single "at most one
// pending native learning reminder" slot (dev-plan §10.3, §13.7) — set right
// after a successful native schedule, cleared on cancellation, completion,
// logout, or account deletion.
export function recordPendingReminder(accountScope, pending, storage) {
  const ledger = loadLearningLedger(accountScope, storage)
  return persist(accountScope, { ...ledger, pending }, storage)
}

export function clearPendingReminder(accountScope, storage) {
  const ledger = loadLearningLedger(accountScope, storage)
  return persist(accountScope, { ...ledger, pending: null }, storage)
}

export function clearLearningLedger(accountScope, storage) {
  const target = storageOrNull(storage)
  if (!accountScope || !target) return
  try { target.removeItem(storageKey(accountScope)) } catch {}
}

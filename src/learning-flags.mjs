// Compile-time rollout flags for the History + Journal learning loop
// (dev-plan/history-journal-learning-loop-development-plan.md §5.5).
// Every flag defaults false in production until its milestone is approved.
// Kept eager and tiny because reviewFeature/history-view gating in main.js
// needs the resolved value before any lazy learning module loads.

export const LEARNING_FLAG_ENV_VARS = {
  historyV2: 'VITE_LEARNING_HISTORY_V2',
  reviewV2: 'VITE_LEARNING_REVIEW_V2',
  indexV1: 'VITE_LEARNING_INDEX_V1',
  practiceV2: 'VITE_LEARNING_PRACTICE_V2',
  goalsV2: 'VITE_LEARNING_GOALS_V2',
  journalLayoutV2: 'VITE_LEARNING_JOURNAL_LAYOUT_V2',
  // Notification system (notification dev-plan §13.2): notificationsV1 gates
  // candidate evaluation and in-app UI; nativeRemindersV1 additionally gates
  // the Capacitor local-notification plugin/permission/scheduling and
  // requires notificationsV1 to also be on (checked by the caller, not here).
  notificationsV1: 'VITE_LEARNING_NOTIFICATIONS_V1',
  nativeRemindersV1: 'VITE_LEARNING_NATIVE_REMINDERS_V1',
}

export const LEARNING_FLAG_KEYS = Object.keys(LEARNING_FLAG_ENV_VARS)

function isTruthyFlagValue(value) {
  return value === '1' || value === 1 || value === true || value === 'true'
}

// resolveLearningFlags: pure so it can run identically under Vite's
// import.meta.env and under plain Node in unit tests. `overrides` is the
// DEV-only test seam's payload (src/main.js's window.agsSetLearningFlagsForTesting);
// it wins over env for any key it defines and is ignored otherwise.
export function resolveLearningFlags(env = {}, overrides = null) {
  const flags = {}
  for (const key of LEARNING_FLAG_KEYS) {
    flags[key] = isTruthyFlagValue(env[LEARNING_FLAG_ENV_VARS[key]])
  }
  if (overrides && typeof overrides === 'object') {
    for (const key of LEARNING_FLAG_KEYS) {
      if (key in overrides) flags[key] = !!overrides[key]
    }
  }
  return flags
}

// ─── Percentage-based rollout gating (notification dev-plan §17 N4) ────────
// A boolean flag above is the master switch; once it's on, a rollout
// percentage further restricts which signed-in users are actually exposed —
// this is what lets N4's staged rollout (10% → 50% → 100%, then repeat for
// native reminders) advance by changing a number, not by shipping a new
// build at every stage. Only the two milestone-gated notification flags
// have a rollout percentage; every other learning flag stays all-or-nothing.
export const LEARNING_ROLLOUT_PCT_ENV_VARS = {
  notificationsV1: 'VITE_LEARNING_NOTIFICATIONS_ROLLOUT_PCT',
  nativeRemindersV1: 'VITE_LEARNING_NATIVE_REMINDERS_ROLLOUT_PCT',
}

// 32-bit FNV-1a — not a security hash, just a stable per-user 0-99 bucket so
// the same account always lands in the same rollout cohort. Same algorithm
// as computeMatchFingerprint in learning-contract.mjs, kept as an
// independent copy here since that module pulls in review's dependency
// graph and this one must stay eager-safe.
function stableBucket(userId) {
  let hash = 0x811c9dc5
  const str = String(userId || '')
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 100
}

// resolveLearningRolloutPercents: missing/invalid/out-of-range env values
// default to 100 (full rollout) — a flag that's already on for everyone
// keeps behaving that way unless ops explicitly dials a percentage down,
// so N0–N3's "flag on = on for every signed-in user" behavior is preserved
// by default.
export function resolveLearningRolloutPercents(env = {}) {
  const percents = {}
  for (const key of Object.keys(LEARNING_ROLLOUT_PCT_ENV_VARS)) {
    const raw = Number(env[LEARNING_ROLLOUT_PCT_ENV_VARS[key]])
    percents[key] = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100
  }
  return percents
}

// isInRolloutPercent: deterministic — the same userId+percent always
// returns the same answer, so a player's exposure never flickers between
// reconciliations within the same rollout stage.
export function isInRolloutPercent(userId, percent) {
  const pct = Number.isFinite(percent) ? percent : 100
  if (pct >= 100) return true
  if (pct <= 0) return false
  return stableBucket(userId) < pct
}

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

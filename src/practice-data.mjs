// Pure practice-queue derivation and scheduling for the global Journal
// practice queue (dev-plan §12). No DOM, no network, no engine — src/journal.js
// owns rendering and the CloudSave read/write around it. Deliberately its own
// file rather than folded into journal-data.mjs (dev-plan §12.1's escape
// hatch) since scheduling is a distinct concern from windowing/goals/coach copy.

import { findEmbeddedGame } from './journal-data.mjs'

export const PRACTICE_QUEUE_DISPLAY_CAP = 30

const STAGES = ['new', 'learning', 'review', 'mastered']
const DAY_MS = 86400000

// normalizePuzzleScheduling: legacy/pre-M5 puzzles default to due-now so they
// surface for practice immediately rather than silently vanishing (dev-plan §6.4).
export function normalizePuzzleScheduling(puzzle, nowIso) {
  return {
    ...puzzle,
    stage: STAGES.includes(puzzle?.stage) ? puzzle.stage : 'new',
    dueAt: typeof puzzle?.dueAt === 'string' && puzzle.dueAt ? puzzle.dueAt : nowIso,
    correctStreak: Number.isFinite(puzzle?.correctStreak) ? puzzle.correctStreak : 0,
    lastAttemptAt: typeof puzzle?.lastAttemptAt === 'string' ? puzzle.lastAttemptAt : '',
    lastResult: typeof puzzle?.lastResult === 'string' ? puzzle.lastResult : '',
  }
}

// applyPuzzleAttempt: the single pure entry point for "the player just
// attempted this puzzle" — produces the fully updated puzzle object per
// dev-plan §12.3's scheduling matrix and §12.4's persisted-fields list.
//
// firstAttempt distinguishes "solved it cold" from "solved after a retry/hint
// (or after repeating the original bad move, which the caller already
// rejects before this is reached)" — only a cold-solve at New promotes on the
// fast 3-day track, and only a cold-solve at Review proves independent
// recall worth promoting to Mastered. A correct-after-retry at Learning or
// Review isn't in the plan's table explicitly; treated the same as
// "not yet proven" (stays/returns to Learning) rather than inventing a new
// state, since retry-assisted correctness doesn't demonstrate recall either.
export function applyPuzzleAttempt(puzzle, { solved, firstAttempt }, now = new Date()) {
  const nowIso = now.toISOString()
  const normalized = normalizePuzzleScheduling(puzzle, nowIso)
  const stage = normalized.stage
  const streak = normalized.correctStreak

  let next
  if (!solved) {
    next = { stage: 'learning', dueAt: new Date(now.getTime() + DAY_MS).toISOString(), correctStreak: 0 }
  } else if (stage === 'new') {
    const days = firstAttempt ? 3 : 1
    next = { stage: 'learning', dueAt: new Date(now.getTime() + days * DAY_MS).toISOString(), correctStreak: streak + 1 }
  } else if (stage === 'learning') {
    next = firstAttempt
      ? { stage: 'review', dueAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(), correctStreak: streak + 1 }
      : { stage: 'learning', dueAt: new Date(now.getTime() + DAY_MS).toISOString(), correctStreak: 0 }
  } else if (stage === 'review') {
    next = firstAttempt
      ? { stage: 'mastered', dueAt: '', correctStreak: streak + 1 }
      : { stage: 'learning', dueAt: new Date(now.getTime() + DAY_MS).toISOString(), correctStreak: 0 }
  } else {
    // mastered + solved again (replayed manually): not normally re-served,
    // so just record the attempt without moving it.
    next = { stage: 'mastered', dueAt: normalized.dueAt, correctStreak: streak + 1 }
  }

  return {
    ...normalized,
    ...next,
    solved: normalized.solved || solved, // legacy compatibility boolean — sticky true
    attempts: (normalized.attempts || 0) + 1,
    lastAttemptAt: nowIso,
    lastResult: solved ? 'correct' : 'incorrect',
  }
}

function severityRank(kind) {
  return kind === 'missed' ? 0 : 1 // a real blunder outranks a missed opportunity
}

// priorityRank: dev-plan §12.1's recommended order — overdue+incorrect,
// overdue+learning, new (by severity), then any other overdue item.
function priorityRank(item, nowIso) {
  const isOverdue = item.dueAt <= nowIso
  if (isOverdue && item.lastResult === 'incorrect') return 0
  if (isOverdue && item.stage === 'learning') return 1
  if (item.stage === 'new') return 2
  if (isOverdue) return 3
  return 4
}

export function sortPracticeQueue(items, nowIso) {
  return [...items].sort((a, b) => {
    const rankA = priorityRank(a, nowIso)
    const rankB = priorityRank(b, nowIso)
    if (rankA !== rankB) return rankA - rankB
    if (rankA === 2) {
      const severityDiff = severityRank(a.kind) - severityRank(b.kind)
      if (severityDiff) return severityDiff
    }
    return (a.dueAt || '').localeCompare(b.dueAt || '')
  })
}

// buildPracticeQueue: flatten puzzles across ALL retained entries (already
// newest-first), dedupe by puzzle id preferring the newest entry's copy,
// resolve a playable source game record-wide, normalize scheduling, sort,
// and cap DISPLAYED items to 30 — never delete anything (dev-plan §12.1).
export function buildPracticeQueue(entries, { now = new Date() } = {}) {
  const nowIso = now.toISOString()
  const seen = new Map()
  for (const entry of entries || []) {
    for (const puzzle of entry.puzzles || []) {
      if (!puzzle?.id || seen.has(puzzle.id)) continue
      seen.set(puzzle.id, { ...normalizePuzzleScheduling(puzzle, nowIso), sourceEntryId: entry.id })
    }
  }
  const all = [...seen.values()].map(item => ({
    ...item,
    playable: !!findEmbeddedGame(entries, item.matchId),
  }))
  const masteredCount = all.filter(i => i.stage === 'mastered').length
  const active = all.filter(i => i.stage !== 'mastered')
  const dueCount = active.filter(i => i.dueAt <= nowIso).length
  const sortedActive = sortPracticeQueue(active, nowIso)
  return {
    displayed: sortedActive.slice(0, PRACTICE_QUEUE_DISPLAY_CAP),
    dueCount,
    activeCount: active.length,
    masteredCount,
    totalCount: all.length,
    // Earliest still-pending due date, for the "no due but active" UI state
    // (dev-plan §12.2) — null when there's nothing left to schedule.
    nextDueAt: active.reduce((min, i) => (min === null || i.dueAt < min ? i.dueAt : min), null),
  }
}

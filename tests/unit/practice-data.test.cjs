const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const practicePromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'practice-data.mjs')
))

const NOW = new Date('2026-07-15T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()

function puzzle(overrides = {}) {
  return {
    id: 'g1:4',
    matchId: 'g1',
    ply: 4,
    kind: 'missed',
    playedNotation: 'Qxh7',
    bestNotation: 'O-O',
    opponentName: 'Rex',
    solved: false,
    attempts: 0,
    ...overrides,
  }
}

function entry(overrides = {}) {
  return {
    id: 'e1',
    puzzles: [],
    games: {},
    ...overrides,
  }
}

const PLAYABLE_GAME = { id: 'g1', myColor: 'white', moves: [{ fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' }] }

// ─── normalizePuzzleScheduling ─────────────────────────────────────────────

test('normalizePuzzleScheduling: a legacy (pre-M5) puzzle defaults due now, stage new (dev-plan §6.4)', async () => {
  const { normalizePuzzleScheduling } = await practicePromise
  const legacy = puzzle() // no stage/dueAt/correctStreak/lastAttemptAt/lastResult at all
  const normalized = normalizePuzzleScheduling(legacy, NOW_ISO)
  assert.equal(normalized.stage, 'new')
  assert.equal(normalized.dueAt, NOW_ISO)
  assert.equal(normalized.correctStreak, 0)
  assert.equal(normalized.lastAttemptAt, '')
  assert.equal(normalized.lastResult, '')
})

test('normalizePuzzleScheduling: an unknown stage value falls back to new', async () => {
  const { normalizePuzzleScheduling } = await practicePromise
  const normalized = normalizePuzzleScheduling(puzzle({ stage: 'bogus' }), NOW_ISO)
  assert.equal(normalized.stage, 'new')
})

test('normalizePuzzleScheduling: preserves valid existing scheduling fields', async () => {
  const { normalizePuzzleScheduling } = await practicePromise
  const normalized = normalizePuzzleScheduling(
    puzzle({ stage: 'review', dueAt: '2026-08-01T00:00:00.000Z', correctStreak: 3 }),
    NOW_ISO,
  )
  assert.equal(normalized.stage, 'review')
  assert.equal(normalized.dueAt, '2026-08-01T00:00:00.000Z')
  assert.equal(normalized.correctStreak, 3)
})

// ─── applyPuzzleAttempt: scheduling matrix (dev-plan §12.3) ────────────────

test('scheduling: New + correct first attempt -> Learning +3 days', async () => {
  const { applyPuzzleAttempt } = await practicePromise
  const result = applyPuzzleAttempt(puzzle({ stage: 'new' }), { solved: true, firstAttempt: true }, NOW)
  assert.equal(result.stage, 'learning')
  assert.equal(result.dueAt, new Date(NOW.getTime() + 3 * 86400000).toISOString())
})

test('scheduling: New + correct after retry -> Learning +1 day', async () => {
  const { applyPuzzleAttempt } = await practicePromise
  const result = applyPuzzleAttempt(puzzle({ stage: 'new' }), { solved: true, firstAttempt: false }, NOW)
  assert.equal(result.stage, 'learning')
  assert.equal(result.dueAt, new Date(NOW.getTime() + 86400000).toISOString())
})

test('scheduling: any stage + incorrect -> Learning +1 day, streak resets', async () => {
  const { applyPuzzleAttempt } = await practicePromise
  for (const stage of ['new', 'learning', 'review', 'mastered']) {
    const result = applyPuzzleAttempt(puzzle({ stage, correctStreak: 5 }), { solved: false, firstAttempt: true }, NOW)
    assert.equal(result.stage, 'learning', `stage ${stage} -> incorrect`)
    assert.equal(result.dueAt, new Date(NOW.getTime() + 86400000).toISOString())
    assert.equal(result.correctStreak, 0)
  }
})

test('scheduling: Learning + correct first attempt -> Review +7 days', async () => {
  const { applyPuzzleAttempt } = await practicePromise
  const result = applyPuzzleAttempt(puzzle({ stage: 'learning' }), { solved: true, firstAttempt: true }, NOW)
  assert.equal(result.stage, 'review')
  assert.equal(result.dueAt, new Date(NOW.getTime() + 7 * 86400000).toISOString())
})

test('scheduling: Review + correct first attempt -> Mastered, no due date', async () => {
  const { applyPuzzleAttempt } = await practicePromise
  const result = applyPuzzleAttempt(puzzle({ stage: 'review' }), { solved: true, firstAttempt: true }, NOW)
  assert.equal(result.stage, 'mastered')
  assert.equal(result.dueAt, '')
})

test('scheduling: attempts increments, lastAttemptAt/lastResult always set, solved is sticky true', async () => {
  const { applyPuzzleAttempt } = await practicePromise
  const first = applyPuzzleAttempt(puzzle({ attempts: 2 }), { solved: false, firstAttempt: false }, NOW)
  assert.equal(first.attempts, 3)
  assert.equal(first.lastAttemptAt, NOW.toISOString())
  assert.equal(first.lastResult, 'incorrect')
  assert.equal(first.solved, false)

  const second = applyPuzzleAttempt(first, { solved: true, firstAttempt: false }, NOW)
  assert.equal(second.solved, true)
  assert.equal(second.lastResult, 'correct')
})

// ─── buildPracticeQueue ─────────────────────────────────────────────────────

test('buildPracticeQueue: dedupes by puzzle id, preferring the newest entry\'s copy', async () => {
  const { buildPracticeQueue } = await practicePromise
  const entries = [
    entry({ id: 'newest', puzzles: [puzzle({ id: 'g1:4', attempts: 5, opponentName: 'Newer copy' })], games: { g1: PLAYABLE_GAME } }),
    entry({ id: 'older', puzzles: [puzzle({ id: 'g1:4', attempts: 0, opponentName: 'Older copy' })], games: { g1: PLAYABLE_GAME } }),
  ]
  const queue = buildPracticeQueue(entries, { now: NOW })
  assert.equal(queue.displayed.length, 1)
  assert.equal(queue.displayed[0].attempts, 5)
  assert.equal(queue.displayed[0].opponentName, 'Newer copy')
  assert.equal(queue.displayed[0].sourceEntryId, 'newest')
})

test('buildPracticeQueue: resolves a playable source game record-wide (dev-plan §8.3 reuse)', async () => {
  const { buildPracticeQueue } = await practicePromise
  const entries = [
    entry({ id: 'newest', puzzles: [puzzle({ id: 'g1:4' })], games: {} }), // no longer embeds g1
    entry({ id: 'older', puzzles: [], games: { g1: PLAYABLE_GAME } }), // still does
  ]
  const queue = buildPracticeQueue(entries, { now: NOW })
  assert.equal(queue.displayed[0].playable, true)
})

test('buildPracticeQueue: unplayable item is retained (not dropped), just flagged', async () => {
  const { buildPracticeQueue } = await practicePromise
  const entries = [entry({ id: 'e1', puzzles: [puzzle({ id: 'g1:4' })], games: {} })]
  const queue = buildPracticeQueue(entries, { now: NOW })
  assert.equal(queue.displayed.length, 1)
  assert.equal(queue.displayed[0].playable, false)
})

test('buildPracticeQueue: mastered items are excluded from the due count and active count', async () => {
  const { buildPracticeQueue } = await practicePromise
  const entries = [entry({
    id: 'e1',
    puzzles: [
      puzzle({ id: 'p1', stage: 'mastered', dueAt: '' }),
      puzzle({ id: 'p2', stage: 'learning', dueAt: '2026-07-01T00:00:00.000Z' }), // overdue
    ],
    games: { g1: PLAYABLE_GAME },
  })]
  const queue = buildPracticeQueue(entries, { now: NOW })
  assert.equal(queue.masteredCount, 1)
  assert.equal(queue.activeCount, 1)
  assert.equal(queue.dueCount, 1)
  assert.equal(queue.displayed.some(i => i.stage === 'mastered'), false)
})

test('buildPracticeQueue: never deletes puzzles beyond the display cap of 30', async () => {
  const { buildPracticeQueue, PRACTICE_QUEUE_DISPLAY_CAP } = await practicePromise
  const puzzles = Array.from({ length: 40 }, (_, i) => puzzle({ id: `p${i}`, matchId: 'g1', dueAt: '2026-07-01T00:00:00.000Z' }))
  const entries = [entry({ id: 'e1', puzzles, games: { g1: PLAYABLE_GAME } })]
  const queue = buildPracticeQueue(entries, { now: NOW })
  assert.equal(queue.displayed.length, PRACTICE_QUEUE_DISPLAY_CAP)
  assert.equal(queue.activeCount, 40) // all 40 still counted, none discarded
})

test('buildPracticeQueue: empty/no entries produces an empty, well-shaped queue', async () => {
  const { buildPracticeQueue } = await practicePromise
  const queue = buildPracticeQueue([], { now: NOW })
  assert.deepEqual(queue.displayed, [])
  assert.equal(queue.dueCount, 0)
  assert.equal(queue.activeCount, 0)
  assert.equal(queue.masteredCount, 0)
  assert.equal(queue.nextDueAt, null)
})

// ─── sortPracticeQueue ordering (dev-plan §12.1 priority) ──────────────────

test('sortPracticeQueue: overdue+incorrect ranks above overdue+learning, new, and other overdue', async () => {
  const { sortPracticeQueue } = await practicePromise
  const items = [
    { id: 'other-overdue', stage: 'review', dueAt: '2026-07-01T00:00:00.000Z', lastResult: 'correct', kind: 'missed' },
    { id: 'new-item', stage: 'new', dueAt: NOW_ISO, lastResult: '', kind: 'missed' },
    { id: 'overdue-learning', stage: 'learning', dueAt: '2026-07-01T00:00:00.000Z', lastResult: 'correct', kind: 'missed' },
    { id: 'overdue-incorrect', stage: 'learning', dueAt: '2026-07-01T00:00:00.000Z', lastResult: 'incorrect', kind: 'missed' },
  ]
  const sorted = sortPracticeQueue(items, NOW_ISO)
  assert.deepEqual(sorted.map(i => i.id), ['overdue-incorrect', 'overdue-learning', 'new-item', 'other-overdue'])
})

test('sortPracticeQueue: among New items, a missed blunder outranks a missed punish opportunity', async () => {
  const { sortPracticeQueue } = await practicePromise
  const items = [
    { id: 'punish', stage: 'new', dueAt: NOW_ISO, lastResult: '', kind: 'punish' },
    { id: 'missed', stage: 'new', dueAt: NOW_ISO, lastResult: '', kind: 'missed' },
  ]
  const sorted = sortPracticeQueue(items, NOW_ISO)
  assert.deepEqual(sorted.map(i => i.id), ['missed', 'punish'])
})

test('sortPracticeQueue: ties break by oldest due date first', async () => {
  const { sortPracticeQueue } = await practicePromise
  const items = [
    { id: 'later', stage: 'new', dueAt: '2026-07-10T00:00:00.000Z', lastResult: '', kind: 'missed' },
    { id: 'earlier', stage: 'new', dueAt: '2026-07-05T00:00:00.000Z', lastResult: '', kind: 'missed' },
  ]
  const sorted = sortPracticeQueue(items, NOW_ISO)
  assert.deepEqual(sorted.map(i => i.id), ['earlier', 'later'])
})

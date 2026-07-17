const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const viewPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'history-view.mjs')
))

function match(overrides = {}) {
  return {
    id: overrides.id || `m-${Math.random().toString(36).slice(2, 8)}`,
    mode: 'online',
    result: 'win',
    endReason: 'checkmate',
    myColor: 'white',
    endedAt: '2026-07-09T10:00:00Z',
    durationMs: 90000,
    opponentName: 'Maya',
    moves: [
      { fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' }, // e4
      { fr: 1, fc: 4, toR: 3, toC: 4, promType: 'queen' }, // e5
      { fr: 7, fc: 3, toR: 3, toC: 7, promType: 'queen' }, // Qh5
      { fr: 0, fc: 1, toR: 2, toC: 2, promType: 'queen' }, // Nc6
    ],
    ...overrides,
  }
}

// ─── historyRowView ────────────────────────────────────────────────────────

test('historyRowView: full match produces every label', async () => {
  const { historyRowView } = await viewPromise
  const row = historyRowView(match())
  assert.equal(row.resultLabel, 'Win')
  assert.equal(row.resultClass, 'win')
  assert.equal(row.opponent, 'Maya')
  assert.equal(row.modeLabel, 'Online')
  assert.equal(row.colorLabel, 'White')
  assert.equal(row.moveCountLabel, '2 moves')
  assert.equal(row.endReasonLabel, 'Checkmate')
  assert.equal(row.openingLabel, '1. e4')
  assert.equal(row.durationLabel, '1:30')
  assert.equal(row.canReplay, true)
  assert.notEqual(row.dateLabel, 'Unknown time')
})

test('historyRowView: legacy optional fields omit labels cleanly (dev-plan §6.1)', async () => {
  const { historyRowView } = await viewPromise
  const legacy = match({ myColor: undefined, endReason: undefined, mode: 'legacy-mode', durationMs: undefined })
  const row = historyRowView(legacy)
  assert.equal(row.colorLabel, '')
  assert.equal(row.endReasonLabel, '')
  assert.equal(row.modeLabel, 'Match') // unknown mode -> "Match"
  assert.equal(row.durationLabel, '') // missing duration omitted, not "0:00"
})

test('historyRowView: zero and negative durations are omitted, not rendered as 0:00', async () => {
  const { historyRowView } = await viewPromise
  assert.equal(historyRowView(match({ durationMs: 0 })).durationLabel, '')
  assert.equal(historyRowView(match({ durationMs: -500 })).durationLabel, '')
  assert.equal(historyRowView(match({ durationMs: NaN })).durationLabel, '')
})

test('historyRowView: invalid endedAt renders "Unknown time" instead of a bad date', async () => {
  const { historyRowView } = await viewPromise
  assert.equal(historyRowView(match({ endedAt: 'not-a-date' })).dateLabel, 'Unknown time')
  assert.equal(historyRowView(match({ endedAt: '' })).dateLabel, 'Unknown time')
})

test('historyRowView: missing or empty moves cannot replay', async () => {
  const { historyRowView } = await viewPromise
  assert.equal(historyRowView(match({ moves: [] })).canReplay, false)
  assert.equal(historyRowView(match({ moves: undefined })).canReplay, false)
  assert.equal(historyRowView(match({ moves: [] })).moveCountLabel, '')
})

test('historyRowView: a match without an id is never replayable, even with moves', async () => {
  const { historyRowView } = await viewPromise
  const row = historyRowView(match({ id: '' }))
  assert.equal(row.canReplay, false)
})

test('historyRowView: unknown result falls back to a neutral class', async () => {
  const { historyRowView } = await viewPromise
  const row = historyRowView(match({ result: undefined }))
  assert.equal(row.resultClass, 'completed')
  assert.equal(row.resultLabel, 'Completed')
})

// ─── firstMoveLabel ────────────────────────────────────────────────────────

test('firstMoveLabel: uses the RECORDING PLAYER color, not always White (dev-plan §9.5)', async () => {
  const { firstMoveLabel } = await viewPromise
  // As White, my first move is ply 0 (1.e4) — a named opening.
  assert.equal(firstMoveLabel(match({ myColor: 'white' })), '1. e4')
  // In the SAME game recorded as Black, my first move is ply 1 (1...e5), a
  // reply rather than an opening move — the shared White-keyed opening table
  // has no entry for it, so this must come back empty rather than silently
  // reusing White's "1. e4" label for a Black-recorded game.
  assert.equal(firstMoveLabel(match({ myColor: 'black' })), '')
})

test('firstMoveLabel: reads the ply the recording color actually owns, not always ply 0', async () => {
  const { firstMoveLabel } = await viewPromise
  // Two games with swapped move lists: the label must track whichever ply
  // belongs to `myColor`, proving it isn't hardcoded to index 0.
  const asWhite = match({ myColor: 'white', moves: [
    { fr: 6, fc: 3, toR: 4, toC: 3, promType: 'queen' }, // 1.d4 — my move
    { fr: 1, fc: 4, toR: 3, toC: 4, promType: 'queen' },
  ] })
  const asBlackFacingD4 = match({ myColor: 'black', moves: [
    { fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' }, // 1.e4 — opponent's move
    { fr: 1, fc: 3, toR: 3, toC: 3, promType: 'queen' }, // 1...d5 — my move
  ] })
  assert.equal(firstMoveLabel(asWhite), '1. d4')
  assert.equal(firstMoveLabel(asBlackFacingD4), '') // my move (...d5) has no table entry — correctly not "1. e4"
})

test('firstMoveLabel: unknown color or no moves returns empty, never throws', async () => {
  const { firstMoveLabel } = await viewPromise
  assert.equal(firstMoveLabel(match({ myColor: 'spectator', moves: [] })), '')
  assert.equal(firstMoveLabel(match({ moves: [] })), '')
  assert.equal(firstMoveLabel({}), '')
})

// ─── filterHistory ─────────────────────────────────────────────────────────

test('filterHistory: composes result + color + mode together', async () => {
  const { filterHistory } = await viewPromise
  const matches = [
    match({ id: 'a', result: 'win', myColor: 'white', mode: 'online' }),
    match({ id: 'b', result: 'win', myColor: 'black', mode: 'online' }),
    match({ id: 'c', result: 'loss', myColor: 'white', mode: 'online' }),
    match({ id: 'd', result: 'win', myColor: 'white', mode: 'computer' }),
  ]
  const result = filterHistory(matches, { result: 'win', color: 'white', mode: 'online' })
  assert.deepEqual(result.map(m => m.id), ['a'])
})

test('filterHistory: "all" on every axis returns everything unchanged', async () => {
  const { filterHistory } = await viewPromise
  const matches = [match({ id: 'a' }), match({ id: 'b' })]
  assert.deepEqual(filterHistory(matches, { result: 'all', color: 'all', mode: 'all' }).map(m => m.id), ['a', 'b'])
  assert.deepEqual(filterHistory(matches).map(m => m.id), ['a', 'b'])
  assert.deepEqual(filterHistory(matches, {}).map(m => m.id), ['a', 'b'])
})

test('filterHistory: tolerates missing/undefined input', async () => {
  const { filterHistory } = await viewPromise
  assert.deepEqual(filterHistory(null, { result: 'win' }), [])
  assert.deepEqual(filterHistory(undefined), [])
})

// ─── historyFilterCounts ───────────────────────────────────────────────────

test('historyFilterCounts: tallies each result over the unfiltered list', async () => {
  const { historyFilterCounts } = await viewPromise
  const matches = [
    match({ result: 'win' }), match({ result: 'win' }),
    match({ result: 'loss' }), match({ result: 'draw' }),
  ]
  assert.deepEqual(historyFilterCounts(matches), { all: 4, win: 2, loss: 1, draw: 1 })
})

// ─── pageHistory ───────────────────────────────────────────────────────────

function fixtureMatches(n) {
  return Array.from({ length: n }, (_, i) => match({ id: `m${i}` }))
}

test('pageHistory: reaches all 50 matches in fixed-size steps without duplication', async () => {
  const { pageHistory } = await viewPromise
  const matches = fixtureMatches(50)

  const page1 = pageHistory(matches, 20, 20)
  assert.equal(page1.visible.length, 20)
  assert.equal(page1.hasMore, true)
  assert.equal(page1.nextVisibleCount, 40)

  const page2 = pageHistory(matches, page1.nextVisibleCount, 20)
  assert.equal(page2.visible.length, 40)
  assert.equal(page2.hasMore, true)
  assert.equal(page2.nextVisibleCount, 50)
  // No duplication: page2 must be a strict superset prefix of page1.
  assert.deepEqual(page2.visible.slice(0, 20).map(m => m.id), page1.visible.map(m => m.id))

  const page3 = pageHistory(matches, page2.nextVisibleCount, 20)
  assert.equal(page3.visible.length, 50)
  assert.equal(page3.hasMore, false)
  assert.equal(page3.nextVisibleCount, 50)
  assert.deepEqual(new Set(page3.visible.map(m => m.id)).size, 50) // no duplicates
})

test('pageHistory: fewer matches than one page shows everything with no "load more"', async () => {
  const { pageHistory } = await viewPromise
  const matches = fixtureMatches(5)
  const page = pageHistory(matches, 20, 20)
  assert.equal(page.visible.length, 5)
  assert.equal(page.hasMore, false)
  assert.equal(page.totalCount, 5)
})

test('pageHistory: empty input never throws', async () => {
  const { pageHistory } = await viewPromise
  const page = pageHistory([], 20, 20)
  assert.equal(page.visible.length, 0)
  assert.equal(page.hasMore, false)
})

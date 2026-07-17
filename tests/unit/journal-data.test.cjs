const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const journalPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'journal-data.mjs')
))

const NOW = Date.parse('2026-07-09T12:00:00Z')

function match(overrides = {}) {
  return {
    id: overrides.id || `m-${Math.random().toString(36).slice(2, 8)}`,
    mode: 'online',
    result: 'win',
    endReason: 'checkmate',
    myColor: 'white',
    endedAt: '2026-07-09T10:00:00Z',
    opponentName: 'Maya',
    whiteName: 'Me',
    blackName: 'Maya',
    moves: [],
    ...overrides,
  }
}

// A player-ply grade as produced by gradeMoveInPosition (player perspective).
function grade(overrides = {}) {
  return {
    moveIndex: 0,
    grade: 'Playable',
    loss: 50,
    playedNotation: 'Nf3',
    bestNotation: 'e4',
    playedScore: 0,
    bestScore: 50,
    preScore: 0,
    matchedBest: false,
    ...overrides,
  }
}

// ─── Windowing ───────────────────────────────────────────────────────────────

test('filterMatchesByWindow: 24h default, 7d, and since-last', async () => {
  const { filterMatchesByWindow } = await journalPromise
  const matches = [
    match({ id: 'today', endedAt: '2026-07-09T09:00:00Z' }),
    match({ id: 'three-days', endedAt: '2026-07-06T09:00:00Z' }),
    match({ id: 'old', endedAt: '2026-06-01T09:00:00Z' }),
    match({ id: 'no-date', endedAt: '' }),
  ]
  assert.deepEqual(filterMatchesByWindow(matches, '24h', { now: NOW }).map(m => m.id), ['today'])
  assert.deepEqual(filterMatchesByWindow(matches, '7d', { now: NOW }).map(m => m.id), ['today', 'three-days'])
  assert.deepEqual(
    filterMatchesByWindow(matches, 'since-last', { now: NOW, sinceIso: '2026-07-05T00:00:00Z' }).map(m => m.id),
    ['today', 'three-days'],
  )
  // since-last with no previous entry falls back to 24h
  assert.deepEqual(filterMatchesByWindow(matches, 'since-last', { now: NOW }).map(m => m.id), ['today'])
})

// ─── Per-game summaries + moment detection ───────────────────────────────────

test('summarizeGradedGame counts grades and buckets blunders by phase', async () => {
  const { summarizeGradedGame } = await journalPromise
  const grades = [
    grade({ moveIndex: 0, grade: 'Strong move', matchedBest: true, loss: 0 }),
    grade({ moveIndex: 2, grade: 'Playable' }),
    grade({ moveIndex: 28, grade: 'Better move available', loss: 300, playedNotation: 'Qd3', bestNotation: 'Nf5' }),
  ]
  const { summary, moments } = summarizeGradedGame(grades, 30)
  assert.equal(summary.movesGraded, 3)
  assert.equal(summary.strongCount, 1)
  assert.equal(summary.playableCount, 1)
  assert.equal(summary.blunderCount, 1)
  assert.equal(summary.blundersByPhase.endgame, 1)
  const mistake = moments.find(m => m.kind === 'mistake')
  assert.equal(mistake.ply, 28)
  assert.equal(mistake.loss, 300)
  assert.equal(mistake.bestNotation, 'Nf5')
})

test('detects "punished a blunder": opponent gift taken with the best reply', async () => {
  const { summarizeGradedGame } = await journalPromise
  const grades = [
    grade({ moveIndex: 10, grade: 'Playable', playedScore: 20 }),
    // preScore jumped 200cp above our previous playedScore → opponent gifted;
    // we matched the engine's best → punished.
    grade({ moveIndex: 12, grade: 'Strong move', preScore: 220, playedScore: 230, matchedBest: true, loss: 0, playedNotation: 'Nxf5' }),
  ]
  const { moments } = summarizeGradedGame(grades, 20)
  const punished = moments.find(m => m.kind === 'punished')
  assert.ok(punished, 'expected a punished moment')
  assert.equal(punished.ply, 12)
  assert.equal(punished.gain, 200)
})

test('detects a missed gift when the player does not punish', async () => {
  const { summarizeGradedGame } = await journalPromise
  const grades = [
    grade({ moveIndex: 10, grade: 'Playable', playedScore: 0 }),
    grade({ moveIndex: 12, grade: 'Better move available', preScore: 250, playedScore: 30, loss: 220, matchedBest: false }),
  ]
  const { moments } = summarizeGradedGame(grades, 20)
  assert.ok(moments.some(m => m.kind === 'missed-gift' && m.ply === 12))
})

test('detects swing moves and excludes Forced plies', async () => {
  const { summarizeGradedGame } = await journalPromise
  const swing = summarizeGradedGame([
    grade({ moveIndex: 4, grade: 'Strong move', preScore: 0, playedScore: 180, matchedBest: true, loss: 0 }),
  ], 20)
  assert.ok(swing.moments.some(m => m.kind === 'swing' && m.gain === 180))

  const forced = summarizeGradedGame([
    grade({ moveIndex: 4, grade: 'Forced', preScore: 0, playedScore: 250, loss: 0 }),
  ], 20)
  assert.equal(forced.moments.length, 0)
})

// ─── Key moments ─────────────────────────────────────────────────────────────

test('selectKeyMoments ranks mistakes by loss and prefers punished over swing', async () => {
  const { selectKeyMoments } = await journalPromise
  const gradedGames = [
    {
      match: match({ id: 'g1' }),
      summary: {},
      moments: [
        { kind: 'mistake', ply: 8, loss: 120, playedNotation: 'a3', bestNotation: 'Nc3' },
        { kind: 'mistake', ply: 20, loss: 400, playedNotation: 'Qd3', bestNotation: 'Nf5' },
        { kind: 'swing', ply: 14, gain: 160, playedNotation: 'Bxf7' },
      ],
    },
    {
      match: match({ id: 'g2' }),
      summary: {},
      moments: [{ kind: 'punished', ply: 12, gain: 200, playedNotation: 'Nxf5' }],
    },
  ]
  const { mistakes, excellent } = selectKeyMoments(gradedGames)
  assert.equal(mistakes[0].loss, 400)
  assert.equal(mistakes[0].matchId, 'g1')
  assert.equal(excellent[0].kind, 'punished')
  assert.equal(excellent[0].matchId, 'g2')
  assert.equal(excellent[1].kind, 'swing')
})

// ─── Puzzles ─────────────────────────────────────────────────────────────────

test('buildPuzzleDeck creates missed + punish puzzles and carries over unsolved', async () => {
  const { buildPuzzleDeck } = await journalPromise
  const gradedGames = [{
    match: match({ id: 'g1' }),
    summary: {},
    moments: [
      { kind: 'mistake', ply: 20, loss: 400, playedNotation: 'Qd3', bestNotation: 'Nf5' },
      { kind: 'missed-gift', ply: 12, gain: 250, loss: 220, playedNotation: 'h3', bestNotation: 'Nxe5' },
    ],
  }]
  const previous = [
    { id: 'old:4', matchId: 'old', ply: 4, kind: 'missed', solved: false, attempts: 2 },
    { id: 'old:8', matchId: 'old', ply: 8, kind: 'missed', solved: true, attempts: 1 },
  ]
  const deck = buildPuzzleDeck(gradedGames, previous)
  assert.ok(deck.some(p => p.id === 'g1:20' && p.kind === 'missed'))
  assert.ok(deck.some(p => p.id === 'g1:12' && p.kind === 'punish'))
  assert.ok(deck.some(p => p.id === 'old:4'), 'unsolved puzzle carries over')
  assert.ok(!deck.some(p => p.id === 'old:8'), 'solved puzzle retires')
})

// ─── Goals ───────────────────────────────────────────────────────────────────

const NO_CASTLE_MOVES = Array.from({ length: 30 }, (_, i) => ({ fr: 6, fc: i % 8, toR: 5, toC: i % 8, promType: 'queen' }))
const WHITE_CASTLE_KINGSIDE = { fr: 7, fc: 4, toR: 7, toC: 6, promType: 'queen' }

test('deriveGoal proposes castle-early when castling is rare', async () => {
  const { deriveGoal } = await journalPromise
  const matches = [
    match({ moves: NO_CASTLE_MOVES }),
    match({ moves: NO_CASTLE_MOVES }),
  ]
  const goal = deriveGoal(matches, { blunderCount: 2, weakestPhase: 'endgame' })
  assert.equal(goal.kind, 'castle-early')
})

test('deriveGoal falls through to phase blunders, then blunder-rate', async () => {
  const { deriveGoal } = await journalPromise
  const castled = [WHITE_CASTLE_KINGSIDE, ...NO_CASTLE_MOVES]
  const matches = [match({ moves: castled }), match({ moves: castled })]
  const phaseGoal = deriveGoal(matches, { blunderCount: 3, weakestPhase: 'endgame' })
  assert.equal(phaseGoal.kind, 'phase-blunders')
  assert.equal(phaseGoal.phase, 'endgame')

  const fallback = deriveGoal(matches, { blunderCount: 0, weakestPhase: null })
  assert.equal(fallback.kind, 'blunder-rate')
})

test('verifyGoal: castle-early stays unresolved until 3 applicable games, then resolves', async () => {
  const { verifyGoal } = await journalPromise
  const goal = { kind: 'castle-early' }
  const castled = match({ moves: [WHITE_CASTLE_KINGSIDE] })
  const none = verifyGoal(goal, [], null, null)
  assert.equal(none.achieved, null)

  const one = verifyGoal(goal, [castled], null, null)
  assert.equal(one.achieved, null, 'one applicable game must not resolve the goal')

  const two = verifyGoal(goal, [castled, castled], null, null)
  assert.equal(two.achieved, null, 'two applicable games must not resolve the goal')

  const threeAchieved = verifyGoal(goal, [castled, castled, castled], null, null)
  assert.equal(threeAchieved.achieved, true)

  const notCastled = match({ moves: NO_CASTLE_MOVES })
  const threeFailed = verifyGoal(goal, [notCastled, notCastled, notCastled], null, null)
  assert.equal(threeFailed.achieved, false)
})

test('verifyGoal: castle-early ignores short games that never reached move 10', async () => {
  const { verifyGoal } = await journalPromise
  const goal = { kind: 'castle-early' }
  const shortGame = match({ moves: NO_CASTLE_MOVES.slice(0, 4) }) // ends well before move 10
  const result = verifyGoal(goal, [shortGame, shortGame, shortGame], null, null)
  assert.equal(result.achieved, null, 'no applicable games should ever resolve the goal')
})

test('castleGoalResult: applicability and completion (dev-plan §8.2)', async () => {
  const { castleGoalResult } = await journalPromise
  // Castled on move 1 (before move 10): applicable and complete.
  assert.deepEqual(
    castleGoalResult(match({ moves: [WHITE_CASTLE_KINGSIDE] })),
    { applicable: true, completed: true },
  )
  // Reached move 10 without castling: applicable and incomplete.
  assert.deepEqual(
    castleGoalResult(match({ moves: NO_CASTLE_MOVES })),
    { applicable: true, completed: false },
  )
  // Game ended before move 10: excluded, not a failure.
  assert.deepEqual(
    castleGoalResult(match({ moves: NO_CASTLE_MOVES.slice(0, 4) })),
    { applicable: false, completed: false },
  )
  // No color/moves data: excluded.
  assert.deepEqual(castleGoalResult({ moves: [] }), { applicable: false, completed: false })
})

test('verifyGoal: phase-blunders compares rates across entries', async () => {
  const { verifyGoal } = await journalPromise
  const goal = { kind: 'phase-blunders', phase: 'endgame' }
  const prev = { movesGraded: 20, blundersByPhase: { endgame: 4, opening: 0, middlegame: 0 } }
  const better = { movesGraded: 30, blundersByPhase: { endgame: 3, opening: 0, middlegame: 0 } }
  const verdict = verifyGoal(goal, [match()], better, prev)
  assert.equal(verdict.achieved, true) // 20% → 10%
})

// ─── Trend ───────────────────────────────────────────────────────────────────

test('computeTrend compares rates and flags window mismatch', async () => {
  const { computeTrend } = await journalPromise
  const aggregate = { strongRate: 0.5, blunderRate: 0.1 }
  const previous = { id: 'e1', window: '7d', accuracy: { strongRate: 0.4, blunderRate: 0.2 } }
  const trend = computeTrend(aggregate, previous, '24h')
  assert.ok(Math.abs(trend.strongRateDelta - 0.1) < 1e-9)
  assert.ok(Math.abs(trend.blunderRateDelta + 0.1) < 1e-9)
  assert.equal(trend.windowMismatch, true)
  assert.equal(computeTrend(aggregate, null, '24h'), null)
})

// ─── Opening signal ──────────────────────────────────────────────────────────

test('openingSignal fires only on a lopsided repeated first move', async () => {
  const { openingSignal } = await journalPromise
  const e4 = { fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' }
  const losses = [1, 2, 3].map(() => match({ result: 'loss', moves: [e4] }))
  assert.match(openingSignal(losses), /0–3 with 1\. e4/)
  assert.equal(openingSignal(losses.slice(0, 2)), '') // under 3 games — no signal
  const mixed = [match({ result: 'win', moves: [e4] }), ...losses.slice(0, 2)]
  assert.equal(openingSignal(mixed), '')
})

// ─── Entry + coach report ────────────────────────────────────────────────────

test('buildJournalEntry embeds referenced games and celebrates before the lesson', async () => {
  const { buildJournalEntry } = await journalPromise
  const m1 = match({ id: 'g1', result: 'win', moves: [WHITE_CASTLE_KINGSIDE] })
  const m2 = match({ id: 'g2', result: 'loss', moves: NO_CASTLE_MOVES })
  const m3 = match({ id: 'g3', result: 'draw', moves: NO_CASTLE_MOVES })
  const keyMoments = {
    excellent: [{ kind: 'punished', matchId: 'g1', ply: 12, gain: 200, playedNotation: 'Nxf5', opponentName: 'Maya' }],
    mistakes: [{ kind: 'mistake', matchId: 'g2', ply: 20, loss: 400, playedNotation: 'Qd3', bestNotation: 'Nf5', opponentName: 'Maya' }],
  }
  const entry = buildJournalEntry({
    window: '24h',
    now: NOW,
    matches: [m1, m2, m3],
    gradedGames: [
      { match: m1, summary: { movesGraded: 10, strongCount: 6, playableCount: 3, blunderCount: 1, blundersByPhase: { opening: 0, middlegame: 0, endgame: 1 } }, moments: [] },
    ],
    previousEntry: null,
    keyMoments,
    puzzles: [{ id: 'g2:20', matchId: 'g2', ply: 20, kind: 'missed', solved: false, attempts: 0 }],
    goal: { kind: 'castle-early', label: 'Castle by move 10', detail: 'Safety first.' },
    previousGoalVerdict: null,
  })

  assert.deepEqual(entry.record, { wins: 1, losses: 1, draws: 1 })
  assert.equal(entry.gamesInWindow, 3)
  assert.deepEqual(Object.keys(entry.games).sort(), ['g1', 'g2']) // g3 unreferenced — not embedded
  assert.ok(entry.coach.bestMomentText.includes('Nxf5'))
  assert.ok(entry.coach.lessonText.includes('Qd3'))
  assert.ok(entry.coach.goalProposalText.includes('Castle by move 10'))
  assert.equal(entry.reflection.didWell, '')
})

test('findEmbeddedGame: resolves a carried puzzle whose game only survives in an older entry', async () => {
  const { findEmbeddedGame } = await journalPromise
  const oldGame = { id: 'g1', myColor: 'white', moves: [WHITE_CASTLE_KINGSIDE] }
  // Newest entry no longer embeds g1 (its window moved on); the older entry
  // still does — dev-plan §8.3's exact carried-puzzle scenario.
  const entries = [
    { id: 'newest', games: { g2: { id: 'g2', myColor: 'white', moves: NO_CASTLE_MOVES } } },
    { id: 'older', games: { g1: oldGame } },
  ]
  assert.equal(findEmbeddedGame(entries, 'g1'), oldGame)
  assert.equal(findEmbeddedGame(entries, 'g2').id, 'g2')
})

test('findEmbeddedGame: newest entry wins when both embed the same match', async () => {
  const { findEmbeddedGame } = await journalPromise
  const newer = { id: 'g1', myColor: 'white', moves: [WHITE_CASTLE_KINGSIDE] }
  const older = { id: 'g1', myColor: 'white', moves: NO_CASTLE_MOVES }
  const entries = [{ games: { g1: newer } }, { games: { g1: older } }]
  assert.equal(findEmbeddedGame(entries, 'g1'), newer)
})

test('findEmbeddedGame: degrades gracefully when no retained entry embeds the match', async () => {
  const { findEmbeddedGame } = await journalPromise
  const entries = [{ games: {} }, { games: { other: { moves: [1] } } }]
  assert.equal(findEmbeddedGame(entries, 'missing'), null)
  assert.equal(findEmbeddedGame([], 'g1'), null)
  assert.equal(findEmbeddedGame(null, 'g1'), null)
  assert.equal(findEmbeddedGame(entries, null), null)
  // An entry with an empty/malformed moves array must not count as embedded.
  const withEmptyMoves = [{ games: { g1: { moves: [] } } }]
  assert.equal(findEmbeddedGame(withEmptyMoves, 'g1'), null)
})

// ─── Record shape (privacy-critical) ─────────────────────────────────────────

test('buildJournalRecordValue is private, capped, and strips old embedded games', async () => {
  const {
    buildJournalRecordValue, JOURNAL_ENTRY_CAP, JOURNAL_EMBEDDED_GAME_ENTRY_CAP, JOURNAL_GRADE_CACHE_CAP,
  } = await journalPromise
  const entries = Array.from({ length: JOURNAL_ENTRY_CAP + 5 }, (_, i) => ({
    id: `e${i}`,
    games: { g1: { moves: [] } },
    puzzles: [{ id: 'p1' }],
  }))
  const gradeCache = Object.fromEntries(Array.from({ length: JOURNAL_GRADE_CACHE_CAP + 10 }, (_, i) =>
    [`m${i}`, { gradedAt: i, summary: {} }]))

  const value = buildJournalRecordValue({ entries, gradeCache })
  assert.deepEqual(value.__META, { is_public: false }) // the journal must NEVER be public
  assert.equal(value.entries.length, JOURNAL_ENTRY_CAP)
  assert.ok(Object.keys(value.entries[0].games).length === 1)
  assert.deepEqual(value.entries[JOURNAL_EMBEDDED_GAME_ENTRY_CAP].games, {}) // old entries slim down
  assert.equal(Object.keys(value.gradeCache).length, JOURNAL_GRADE_CACHE_CAP)
  assert.ok(value.gradeCache.m59, 'keeps the most recently graded games')
  assert.ok(!value.gradeCache.m0, 'prunes the oldest cache entries')
})

test('normalizeJournalRecord tolerates junk', async () => {
  const { normalizeJournalRecord } = await journalPromise
  assert.deepEqual(normalizeJournalRecord(null), { entries: [], gradeCache: {}, updatedAt: '' })
  const normalized = normalizeJournalRecord({ entries: [null, { id: 'e1' }, {}], gradeCache: 'junk' })
  assert.equal(normalized.entries.length, 1)
  assert.deepEqual(normalized.gradeCache, {})
})

// ─── Badges ──────────────────────────────────────────────────────────────────

test('detectProcessBadges: clean game, castle crew, blunder buster', async () => {
  const { detectProcessBadges } = await journalPromise
  const cleanGame = { match: match(), summary: { movesGraded: 12, blunderCount: 0, strongCount: 8, playableCount: 4, blundersByPhase: { opening: 0, middlegame: 0, endgame: 0 } }, moments: [] }
  const castled = match({ moves: [WHITE_CASTLE_KINGSIDE] })

  const codes = detectProcessBadges({
    gradedGames: [cleanGame],
    matches: [castled, castled, castled, castled, castled],
    journalRecord: {
      entries: [{ puzzles: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, solved: true })) }],
    },
  })
  assert.ok(codes.includes('chess-clean-game'))
  assert.ok(codes.includes('chess-castle-crew'))
  assert.ok(codes.includes('chess-blunder-buster'))

  const none = detectProcessBadges({ gradedGames: [], matches: [], journalRecord: { entries: [] } })
  assert.deepEqual(none, [])
})

// ─── Coach Gus request payload (privacy-critical) ────────────────────────────

test('buildCoachReportRequest carries SAN + aggregates and never any names or ids', async () => {
  const { buildCoachReportRequest } = await journalPromise
  const entry = {
    id: 'journal-1',
    window: '24h',
    record: { wins: 1, losses: 1, draws: 0 },
    accuracy: { movesGraded: 24, strongRate: 0.5, blunderCount: 2, weakestPhase: 'endgame' },
    keyMoments: {
      excellent: [{ kind: 'punished', matchId: 'g1', ply: 12, gain: 200, playedNotation: 'Nxf5', opponentName: 'Maya Realname' }],
      mistakes: [{ kind: 'mistake', matchId: 'g2', ply: 20, loss: 780, playedNotation: 'Qxh7', bestNotation: 'Nc3', phase: 'middlegame', opponentName: 'Rex Realname' }],
    },
    goal: { kind: 'castle-early', label: 'Castle by move 10 in your next 3 games', detail: 'Safety first.' },
    previousGoalVerdict: { goal: { label: 'Cut endgame mistakes' }, achieved: true, detail: '4 to 1' },
    reflection: { didWell: 'my secret thoughts', tryNext: 'more secrets', chips: [] },
    games: { g1: { opponentName: 'Maya Realname', moves: [] } },
  }
  const payload = buildCoachReportRequest(entry)

  assert.equal(payload.window, '24h')
  assert.deepEqual(payload.record, { wins: 1, losses: 1, draws: 0 })
  assert.equal(payload.bestMoments[0].san, 'Nxf5')
  assert.equal(payload.bestMoments[0].gainPawns, 2)
  assert.equal(payload.mistakes[0].bestSan, 'Nc3')
  assert.equal(payload.mistakes[0].lossPawns, 7.8)
  assert.equal(payload.goal, 'Castle by move 10 in your next 3 games')
  assert.equal(payload.previousGoal.achieved, true)

  // The privacy line: nothing identifying, and no reflections, ever.
  const serialized = JSON.stringify(payload)
  assert.ok(!serialized.includes('Realname'), 'opponent names must never leave the client')
  assert.ok(!serialized.includes('secret'), 'reflections must never leave the client')
  assert.ok(!serialized.includes('journal-1'), 'entry ids are not needed server-side')
})

test('buildCoachReportRequest tolerates sparse entries', async () => {
  const { buildCoachReportRequest } = await journalPromise
  const payload = buildCoachReportRequest({ window: '7d', record: {}, accuracy: {}, keyMoments: {} })
  assert.equal(payload.window, '7d')
  assert.deepEqual(payload.bestMoments, [])
  assert.deepEqual(payload.mistakes, [])
  assert.equal(payload.previousGoal, null)
})

// ─── Goals v2 (dev-plan §13) ────────────────────────────────────────────────

test('deriveGoalCandidates: never auto-activates — every candidate starts "suggested"', async () => {
  const { deriveGoalCandidates } = await journalPromise
  const matches = [match({ moves: NO_CASTLE_MOVES }), match({ moves: NO_CASTLE_MOVES })]
  const candidates = deriveGoalCandidates({ matches })
  assert.ok(candidates.length > 0)
  for (const c of candidates) {
    assert.equal(c.status, 'suggested')
    assert.equal(c.selectedAt, '')
    assert.equal(c.applicable, 0)
  }
})

test('deriveGoalCandidates: at most 3, in priority order, fallback always present', async () => {
  const { deriveGoalCandidates } = await journalPromise
  const castled = [WHITE_CASTLE_KINGSIDE, ...NO_CASTLE_MOVES]
  const matches = [
    match({ id: 'a', moves: NO_CASTLE_MOVES, endReason: 'resignation' }),
    match({ id: 'b', moves: NO_CASTLE_MOVES.slice(0, 6), endReason: 'resignation' }), // short + early resign
    match({ id: 'c', moves: castled }),
  ]
  const candidates = deriveGoalCandidates({ matches, reviewSupport: true, practiceSupport: true })
  assert.ok(candidates.length <= 3)
  assert.equal(candidates[0].kind, 'castle-early') // highest priority, applicable
})

test('deriveGoalCandidates: review-games/practice-positions are excluded when their flags are off', async () => {
  const { deriveGoalCandidates } = await journalPromise
  const candidates = deriveGoalCandidates({ matches: [], reviewSupport: false, practiceSupport: false })
  assert.ok(!candidates.some(c => c.kind === 'review-games'))
  assert.ok(!candidates.some(c => c.kind === 'practice-positions'))
  // The fallback must still be present — the pool is never empty.
  assert.ok(candidates.some(c => c.kind === 'review-next-games'))
})

test('deriveGoalCandidates: review-games/practice-positions ARE offered when enabled', async () => {
  const { deriveGoalCandidates } = await journalPromise
  const candidates = deriveGoalCandidates({ matches: [], reviewSupport: true, practiceSupport: true })
  assert.ok(candidates.some(c => c.kind === 'review-games' || c.kind === 'practice-positions'))
})

test('matchEvidenceForGoal: castle-early excludes short games from applicability', async () => {
  const { matchEvidenceForGoal } = await journalPromise
  const shortGame = match({ id: 'short', moves: NO_CASTLE_MOVES.slice(0, 4) })
  const fullGame = match({ id: 'full', moves: NO_CASTLE_MOVES })
  const evidence = matchEvidenceForGoal('castle-early', [shortGame, fullGame])
  assert.deepEqual(evidence.find(e => e.id === 'short'), { id: 'short', applicable: false, completed: false })
  assert.deepEqual(evidence.find(e => e.id === 'full'), { id: 'full', applicable: true, completed: false })
})

test('matchEvidenceForGoal: no-early-resign and review-next-games require a real move list', async () => {
  const { matchEvidenceForGoal } = await journalPromise
  const noMoves = match({ id: 'empty', moves: [] })
  assert.deepEqual(matchEvidenceForGoal('no-early-resign', [noMoves]), [])
  assert.deepEqual(matchEvidenceForGoal('review-next-games', [noMoves]), [])
})

test('applyGoalEvidence: progress does not resolve (achieve) before target evidence accumulates', async () => {
  const { deriveGoalCandidates, selectGoal, applyGoalEvidence } = await journalPromise
  let goal = selectGoal(deriveGoalCandidates({ matches: [] }).find(c => c.kind === 'review-next-games') || deriveGoalCandidates({ matches: [] })[0])
  goal = applyGoalEvidence(goal, [{ id: 'm1', applicable: true, completed: true }])
  assert.equal(goal.status, 'active')
  goal = applyGoalEvidence(goal, [{ id: 'm2', applicable: true, completed: true }])
  assert.equal(goal.status, 'active')
  goal = applyGoalEvidence(goal, [{ id: 'm3', applicable: true, completed: true }])
  assert.equal(goal.status, 'achieved') // exactly at target (3)
})

test('applyGoalEvidence: overlapping recap windows cannot double-count the same evidence id', async () => {
  const { selectGoal, applyGoalEvidence } = await journalPromise
  let goal = selectGoal({ kind: 'castle-early', label: '', detail: '', target: 3, applicable: 0, completed: 0, selectedAt: '', completedAt: '', evidenceIds: [] })
  const window1 = [{ id: 'm1', applicable: true, completed: true }, { id: 'm2', applicable: true, completed: true }]
  goal = applyGoalEvidence(goal, window1)
  assert.equal(goal.applicable, 2)
  // A later "7 days" window re-includes m1 and m2 (already counted) plus one
  // genuinely new match — only the new one should add to the tally.
  const window2 = [{ id: 'm1', applicable: true, completed: true }, { id: 'm2', applicable: true, completed: true }, { id: 'm3', applicable: true, completed: false }]
  goal = applyGoalEvidence(goal, window2)
  assert.equal(goal.applicable, 3)
  assert.equal(goal.completed, 2)
  assert.equal(goal.evidenceIds.length, 3)
})

test('applyGoalEvidence: is a no-op for a non-active goal (suggested/achieved/replaced)', async () => {
  const { applyGoalEvidence } = await journalPromise
  const suggested = { kind: 'castle-early', status: 'suggested', applicable: 0, completed: 0, target: 3, evidenceIds: [] }
  assert.deepEqual(applyGoalEvidence(suggested, [{ id: 'm1', applicable: true, completed: true }]), suggested)
  const achieved = { kind: 'castle-early', status: 'achieved', applicable: 3, completed: 3, target: 3, evidenceIds: ['m1', 'm2', 'm3'] }
  assert.deepEqual(applyGoalEvidence(achieved, [{ id: 'm4', applicable: true, completed: true }]), achieved)
})

test('normalizeGoalForDisplay: legacy goal (no status field) displays as active', async () => {
  const { normalizeGoalForDisplay } = await journalPromise
  const legacy = { kind: 'castle-early', label: 'Castle by move 10', detail: 'Safety first.' }
  assert.equal(normalizeGoalForDisplay(legacy).status, 'active')
  assert.equal(normalizeGoalForDisplay(null), null)
})

test('replaceActiveGoal: preserves the goal object, only changes status (history preserved)', async () => {
  const { selectGoal, replaceActiveGoal } = await journalPromise
  const active = selectGoal({ kind: 'castle-early', label: 'X', detail: 'Y', target: 3, applicable: 1, completed: 1, evidenceIds: ['m1'] })
  const replaced = replaceActiveGoal(active)
  assert.equal(replaced.status, 'replaced')
  assert.equal(replaced.applicable, 1) // evidence/progress preserved, not wiped
  assert.deepEqual(replaced.evidenceIds, ['m1'])
  // A non-active goal is untouched.
  const suggested = { kind: 'x', status: 'suggested' }
  assert.deepEqual(replaceActiveGoal(suggested), suggested)
})

test('goalResolutionState: active-but-target-reached-without-success reads as "stalled", not a stored status change', async () => {
  const { goalResolutionState } = await journalPromise
  const stalled = { status: 'active', applicable: 3, completed: 1, target: 3 }
  assert.equal(goalResolutionState(stalled), 'stalled')
  assert.equal(stalled.status, 'active') // goalResolutionState never mutates
  const stillGoing = { status: 'active', applicable: 1, completed: 1, target: 3 }
  assert.equal(goalResolutionState(stillGoing), 'active')
  assert.equal(goalResolutionState({ status: 'achieved' }), 'achieved')
  assert.equal(goalResolutionState({ status: 'replaced' }), 'replaced')
  assert.equal(goalResolutionState(null), null)
})

// ─── deriveNextAction (dev-plan §14.1 priority table) ──────────────────────

test('deriveNextAction: due practice always wins (priority 1)', async () => {
  const { deriveNextAction } = await journalPromise
  const result = deriveNextAction({
    dueCount: 2,
    activeGoal: { kind: 'castle-early', status: 'active', target: 3, applicable: 1, completed: 1 },
    newMatchCount: 5,
  })
  assert.equal(result.kind, 'practice')
  assert.equal(result.dueCount, 2)
})

test('deriveNextAction: an active goal outranks a new-match recap (priority 3 over 4)', async () => {
  const { deriveNextAction } = await journalPromise
  const result = deriveNextAction({
    dueCount: 0,
    activeGoal: { kind: 'castle-early', status: 'active', target: 3, applicable: 1, completed: 1 },
    newMatchCount: 5,
  })
  assert.equal(result.kind, 'goal')
  assert.equal(result.goal.kind, 'castle-early')
})

test('deriveNextAction: an achieved/replaced goal does not block the recap fallback', async () => {
  const { deriveNextAction } = await journalPromise
  const achieved = deriveNextAction({ dueCount: 0, activeGoal: { status: 'achieved' }, newMatchCount: 3 })
  assert.equal(achieved.kind, 'recap')
  const replaced = deriveNextAction({ dueCount: 0, activeGoal: { status: 'replaced' }, newMatchCount: 3 })
  assert.equal(replaced.kind, 'recap')
})

test('deriveNextAction: new matches trigger a recap suggestion (priority 4)', async () => {
  const { deriveNextAction } = await journalPromise
  const result = deriveNextAction({ dueCount: 0, activeGoal: null, newMatchCount: 4 })
  assert.equal(result.kind, 'recap')
  assert.equal(result.count, 4)
})

test('deriveNextAction: falls back to a calm empty state when nothing applies (priority 5)', async () => {
  const { deriveNextAction } = await journalPromise
  assert.deepEqual(deriveNextAction({}), { kind: 'empty' })
  assert.deepEqual(deriveNextAction({ dueCount: 0, activeGoal: null, newMatchCount: 0 }), { kind: 'empty' })
})

test('deriveNextAction: a legacy goal (no status field) counts as active, same as goalResolutionState', async () => {
  const { deriveNextAction } = await journalPromise
  const result = deriveNextAction({ dueCount: 0, activeGoal: { kind: 'castle-early', label: 'X', detail: 'Y' }, newMatchCount: 2 })
  assert.equal(result.kind, 'goal')
})

test('deriveNextAction: tolerates missing/undefined input entirely', async () => {
  const { deriveNextAction } = await journalPromise
  assert.deepEqual(deriveNextAction(), { kind: 'empty' })
})

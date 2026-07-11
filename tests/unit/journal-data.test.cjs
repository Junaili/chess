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

test('verifyGoal: castle-early checks new games; null when no data', async () => {
  const { verifyGoal } = await journalPromise
  const goal = { kind: 'castle-early' }
  const good = verifyGoal(goal, [match({ moves: [WHITE_CASTLE_KINGSIDE] })], null, null)
  assert.equal(good.achieved, true)
  const bad = verifyGoal(goal, [match({ moves: NO_CASTLE_MOVES })], null, null)
  assert.equal(bad.achieved, false)
  const none = verifyGoal(goal, [], null, null)
  assert.equal(none.achieved, null)
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

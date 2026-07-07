const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.resolve(__dirname, '../../src/match-stats.mjs'),
))

function baseMatch(overrides = {}) {
  return {
    id: 'm1',
    mode: 'online',
    opponentUserId: 'opp-1',
    opponentName: 'Alice',
    result: 'win',
    endReason: 'checkmate',
    myColor: 'white',
    durationMs: 60000,
    moves: [
      { fr: 6, fc: 4, toR: 4, toC: 4 }, // e2e4 (white)
      { fr: 1, fc: 4, toR: 3, toC: 4 }, // e7e5 (black)
    ],
    capturedByWhite: [],
    capturedByBlack: [],
    ...overrides,
  }
}

test('computeEloUpdate: equal ratings, a win gains exactly half the K-factor', async () => {
  const { computeEloUpdate } = await modulePromise
  assert.equal(computeEloUpdate(1200, 1200, 1), 1216) // 1200 + 32 * (1 - 0.5)
})

test('computeEloUpdate: equal ratings, a loss drops exactly half the K-factor', async () => {
  const { computeEloUpdate } = await modulePromise
  assert.equal(computeEloUpdate(1200, 1200, 0), 1184)
})

test('computeEloUpdate: equal ratings, a draw is a no-op', async () => {
  const { computeEloUpdate } = await modulePromise
  assert.equal(computeEloUpdate(1200, 1200, 0.5), 1200)
})

test('computeEloUpdate: beating a much stronger opponent gains close to the full K-factor', async () => {
  const { computeEloUpdate } = await modulePromise
  const gain = computeEloUpdate(1200, 1600, 1) - 1200
  assert.ok(gain > 28 && gain <= 32, `expected gain near 32, got ${gain}`)
})

test('computeEloUpdate: losing to a much weaker opponent loses close to the full K-factor', async () => {
  const { computeEloUpdate } = await modulePromise
  const loss = 1200 - computeEloUpdate(1200, 800, 0)
  assert.ok(loss > 28 && loss <= 32, `expected loss near 32, got ${loss}`)
})

test('computeMatchStats: win rate by color splits white/black correctly', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', myColor: 'white', result: 'win' }),
    baseMatch({ id: 'm2', myColor: 'white', result: 'loss' }),
    baseMatch({ id: 'm3', myColor: 'black', result: 'win' }),
  ])
  assert.deepEqual(
    { wins: stats.winRateByColor.white.wins, losses: stats.winRateByColor.white.losses },
    { wins: 1, losses: 1 },
  )
  assert.equal(stats.winRateByColor.black.wins, 1)
  assert.equal(stats.winRateByColor.black.rate, 1)
})

test('computeMatchStats: matches without myColor are excluded from color stats but still counted elsewhere', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'legacy', myColor: undefined, result: 'win' }),
  ])
  assert.equal(stats.totalGames, 1)
  assert.equal(stats.winRateByColor.white.games, 0)
  assert.equal(stats.winRateByColor.black.games, 0)
  assert.equal(stats.winRateByOpponentType.vsHuman.games, 1)
})

test('computeMatchStats: vs bot vs vs human split by mode', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', mode: 'computer', result: 'win' }),
    baseMatch({ id: 'm2', mode: 'online', result: 'loss' }),
  ])
  assert.equal(stats.winRateByOpponentType.vsBot.wins, 1)
  assert.equal(stats.winRateByOpponentType.vsHuman.losses, 1)
})

test('computeMatchStats: a matchmaking-found opponent (incl. the cold-start bot) counts as human for now', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', mode: 'online', opponentName: 'Gambit Gus', opponentUserId: 'bot-account-id', result: 'win' }),
  ])
  assert.equal(stats.winRateByOpponentType.vsHuman.wins, 1)
  assert.equal(stats.winRateByOpponentType.vsBot.games, 0)
  assert.equal(stats.headToHead.length, 1)
})

test('computeMatchStats: head-to-head aggregates per opponent and nemesis needs >= 3 games', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', opponentUserId: 'opp-1', opponentName: 'Alice', result: 'loss' }),
    baseMatch({ id: 'm2', opponentUserId: 'opp-1', opponentName: 'Alice', result: 'loss' }),
    baseMatch({ id: 'm3', opponentUserId: 'opp-2', opponentName: 'Bob', result: 'win' }),
  ])
  const alice = stats.headToHead.find(h => h.opponentUserId === 'opp-1')
  assert.equal(alice.losses, 2)
  // Only 2 games vs Alice — below the 3-game nemesis threshold.
  assert.equal(stats.nemesis, null)
})

test('computeMatchStats: nemesis is the worst-record opponent with >= 3 games', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', opponentUserId: 'opp-1', opponentName: 'Alice', result: 'loss' }),
    baseMatch({ id: 'm2', opponentUserId: 'opp-1', opponentName: 'Alice', result: 'loss' }),
    baseMatch({ id: 'm3', opponentUserId: 'opp-1', opponentName: 'Alice', result: 'win' }),
    baseMatch({ id: 'm4', opponentUserId: 'opp-2', opponentName: 'Bob', result: 'win' }),
    baseMatch({ id: 'm5', opponentUserId: 'opp-2', opponentName: 'Bob', result: 'win' }),
    baseMatch({ id: 'm6', opponentUserId: 'opp-2', opponentName: 'Bob', result: 'win' }),
  ])
  assert.equal(stats.nemesis.opponentUserId, 'opp-1')
})

test('computeMatchStats: favorite opening keys off the recording player\'s own first move', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', myColor: 'white', moves: [{ fr: 6, fc: 4, toR: 4, toC: 4 }] }),
    baseMatch({ id: 'm2', myColor: 'white', moves: [{ fr: 6, fc: 4, toR: 4, toC: 4 }] }),
    baseMatch({ id: 'm3', myColor: 'white', moves: [{ fr: 6, fc: 3, toR: 4, toC: 3 }] }),
  ])
  assert.equal(stats.favoriteOpening.key, 'e2e4')
  assert.equal(stats.favoriteOpening.count, 2)
})

test('computeMatchStats: castling detected from the king\'s two-square home-row move', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({
      id: 'm1',
      myColor: 'white',
      moves: [
        { fr: 7, fc: 4, toR: 7, toC: 6 }, // white kingside castle
        { fr: 1, fc: 4, toR: 3, toC: 4 },
      ],
    }),
    baseMatch({
      id: 'm2',
      myColor: 'white',
      moves: [
        { fr: 6, fc: 4, toR: 4, toC: 4 }, // ordinary pawn move, no castle
      ],
    }),
  ])
  assert.equal(stats.castlingRate.kingside, 1)
  assert.equal(stats.castlingRate.never, 1)
})

test('computeMatchStats: comeback win when own captures are worth less than the opponent\'s', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({
      id: 'm1', myColor: 'white', result: 'win',
      capturedByWhite: ['pawn'],          // I captured 1 point of material
      capturedByBlack: ['queen', 'rook'], // opponent captured 14 points
    }),
  ])
  assert.equal(stats.comebackWins, 1)
})

test('computeMatchStats: time played aggregates duration across matches', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', durationMs: 30000 }),
    baseMatch({ id: 'm2', durationMs: 90000 }),
  ])
  assert.equal(stats.timePlayed.totalMs, 120000)
  assert.equal(stats.timePlayed.avgMs, 60000)
  assert.equal(stats.timePlayed.longest.id, 'm2')
  assert.equal(stats.timePlayed.shortest.id, 'm1')
})

test('computeMatchStats: empty match list returns zeroed stats without throwing', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([])
  assert.equal(stats.totalGames, 0)
  assert.equal(stats.nemesis, null)
  assert.equal(stats.favoriteOpening, null)
})

test('bucketMoveIndexByPhase: splits plies into thirds', async () => {
  const { bucketMoveIndexByPhase } = await modulePromise
  assert.equal(bucketMoveIndexByPhase(0, 30), 'opening')
  assert.equal(bucketMoveIndexByPhase(9, 30), 'opening')
  assert.equal(bucketMoveIndexByPhase(10, 30), 'middlegame')
  assert.equal(bucketMoveIndexByPhase(19, 30), 'middlegame')
  assert.equal(bucketMoveIndexByPhase(20, 30), 'endgame')
  assert.equal(bucketMoveIndexByPhase(29, 30), 'endgame')
  assert.equal(bucketMoveIndexByPhase(0, 0), 'opening') // degenerate game
})

test('summarizeCoachingGrades: counts only the subject color and finds the weakest phase', async () => {
  const { summarizeCoachingGrades } = await modulePromise
  const grades = [
    { moveIndex: 0, mover: 'white', grade: 'Strong move' },
    { moveIndex: 1, mover: 'black', grade: 'Better move available' }, // opponent — ignored
    { moveIndex: 2, mover: 'white', grade: 'Better move available' }, // opening blunder
    { moveIndex: 3, mover: 'black', grade: 'Playable' },
    { moveIndex: 12, mover: 'white', grade: 'Better move available' }, // middlegame blunder
    { moveIndex: 14, mover: 'white', grade: 'Better move available' }, // middlegame blunder
    { moveIndex: 28, mover: 'white', grade: 'Playable' },
  ]
  const summary = summarizeCoachingGrades(grades, 30, 'white')
  assert.equal(summary.movesGraded, 5)
  assert.equal(summary.strongCount, 1)
  assert.equal(summary.playableCount, 1)
  assert.equal(summary.blunderCount, 3)
  assert.equal(summary.weakestPhase, 'middlegame')
  assert.match(summary.headline, /3 moves gave away real advantage/)
  assert.match(summary.headline, /middlegame/)
})

test('summarizeCoachingGrades: clean game produces an encouraging headline', async () => {
  const { summarizeCoachingGrades } = await modulePromise
  const summary = summarizeCoachingGrades(
    [{ moveIndex: 0, mover: 'black', grade: 'Strong move' }], 2, 'black')
  assert.equal(summary.blunderCount, 0)
  assert.equal(summary.weakestPhase, null)
  assert.match(summary.headline, /solid game/i)
})

test('combineCoachingSummaries: rolls up games, computes strong rate and focus phase', async () => {
  const { summarizeCoachingGrades, combineCoachingSummaries } = await modulePromise
  const g1 = summarizeCoachingGrades([
    { moveIndex: 0, mover: 'white', grade: 'Strong move' },
    { moveIndex: 2, mover: 'white', grade: 'Better move available' },
  ], 6, 'white')
  const g2 = summarizeCoachingGrades([
    { moveIndex: 0, mover: 'white', grade: 'Better move available' },
    { moveIndex: 2, mover: 'white', grade: 'Strong move' },
  ], 6, 'white')
  const combined = combineCoachingSummaries([g1, g2])
  assert.equal(combined.gamesAnalyzed, 2)
  assert.equal(combined.movesGraded, 4)
  assert.equal(combined.blunderCount, 2)
  assert.equal(combined.strongRate, 0.5)
  assert.equal(combined.weakestPhase, 'opening')
  assert.match(combined.headline, /opening is the best place to focus practice/)
})

test('combineCoachingSummaries: empty input yields a calm empty-state headline', async () => {
  const { combineCoachingSummaries } = await modulePromise
  const combined = combineCoachingSummaries([])
  assert.equal(combined.gamesAnalyzed, 0)
  assert.match(combined.headline, /no recent games/i)
})

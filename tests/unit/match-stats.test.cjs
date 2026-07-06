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

test('computeMatchStats: the matchmaking bot (Gambit Gus) counts as vs-bot despite mode "online"', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', mode: 'online', opponentName: 'Gambit Gus', opponentUserId: 'bot-account-id', result: 'win' }),
    baseMatch({ id: 'm2', mode: 'online', opponentName: 'Alice', opponentUserId: 'opp-1', result: 'loss' }),
  ])
  assert.equal(stats.winRateByOpponentType.vsBot.wins, 1)
  assert.equal(stats.winRateByOpponentType.vsHuman.games, 1)
  assert.equal(stats.winRateByOpponentType.vsHuman.losses, 1)
})

test('computeMatchStats: the matchmaking bot is excluded from head-to-head and nemesis', async () => {
  const { computeMatchStats } = await modulePromise
  const stats = computeMatchStats([
    baseMatch({ id: 'm1', mode: 'online', opponentName: 'Gambit Gus', opponentUserId: 'bot-account-id', result: 'loss' }),
    baseMatch({ id: 'm2', mode: 'online', opponentName: 'Gambit Gus', opponentUserId: 'bot-account-id', result: 'loss' }),
    baseMatch({ id: 'm3', mode: 'online', opponentName: 'Gambit Gus', opponentUserId: 'bot-account-id', result: 'loss' }),
  ])
  assert.equal(stats.headToHead.length, 0)
  assert.equal(stats.nemesis, null)
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

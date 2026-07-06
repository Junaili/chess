const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.resolve(__dirname, '../../src/match-resume.mjs'),
))

test('computeDeadline: adds exactly the 10-minute resume window', async () => {
  const { computeDeadline, RESUME_WINDOW_MS } = await modulePromise
  const disconnectedAt = '2026-07-06T12:00:00.000Z'
  const deadline = computeDeadline(disconnectedAt)
  assert.equal(new Date(deadline).getTime() - new Date(disconnectedAt).getTime(), RESUME_WINDOW_MS)
})

test('isPastDeadline: false when no deadline set (still connected)', async () => {
  const { isPastDeadline } = await modulePromise
  assert.equal(isPastDeadline(null), false)
  assert.equal(isPastDeadline(undefined), false)
})

test('isPastDeadline: true only once now is after the deadline', async () => {
  const { isPastDeadline } = await modulePromise
  const deadline = '2026-07-06T12:10:00.000Z'
  assert.equal(isPastDeadline(deadline, '2026-07-06T12:09:59.000Z'), false)
  assert.equal(isPastDeadline(deadline, '2026-07-06T12:10:00.000Z'), false)
  assert.equal(isPastDeadline(deadline, '2026-07-06T12:10:01.000Z'), true)
})

test('isResumable: false without a matchId', async () => {
  const { isResumable } = await modulePromise
  assert.equal(isResumable(null), false)
  assert.equal(isResumable({}), false)
})

test('isResumable: true while no deadline has been set yet', async () => {
  const { isResumable } = await modulePromise
  assert.equal(isResumable({ matchId: 'm1', deadline: null }), true)
})

test('isResumable: true before the deadline, false after', async () => {
  const { isResumable } = await modulePromise
  const record = { matchId: 'm1', deadline: '2026-07-06T12:10:00.000Z' }
  assert.equal(isResumable(record, '2026-07-06T12:05:00.000Z'), true)
  assert.equal(isResumable(record, '2026-07-06T12:15:00.000Z'), false)
})

test('deriveMatchRoles: the lexicographically-lower userId is always host, for both players', async () => {
  const { deriveMatchRoles } = await modulePromise
  const a = deriveMatchRoles('user-aaaa', 'user-bbbb')
  const b = deriveMatchRoles('user-bbbb', 'user-aaaa')
  assert.equal(a.hostUserId, 'user-aaaa')
  assert.equal(b.hostUserId, 'user-aaaa')
  assert.equal(a.iAmHost, true)
  assert.equal(b.iAmHost, false)
  assert.equal(a.peerId, b.peerId)
})

test('deriveMatchRoles: peerId strips hyphens from the host userId', async () => {
  const { deriveMatchRoles } = await modulePromise
  const { peerId } = deriveMatchRoles('aaa-111', 'zzz-999')
  assert.equal(peerId, 'aaa111')
})

test('pickAuthoritativeMoves: adopts whichever side has more moves recorded', async () => {
  const { pickAuthoritativeMoves } = await modulePromise
  const shorter = [{ fr: 6, fc: 4, toR: 4, toC: 4 }]
  const longer = [
    { fr: 6, fc: 4, toR: 4, toC: 4 },
    { fr: 1, fc: 4, toR: 3, toC: 4 },
  ]
  assert.equal(pickAuthoritativeMoves(shorter, longer), longer)
  assert.equal(pickAuthoritativeMoves(longer, shorter), longer)
})

test('pickAuthoritativeMoves: tolerates missing/non-array input from either side', async () => {
  const { pickAuthoritativeMoves } = await modulePromise
  const moves = [{ fr: 6, fc: 4, toR: 4, toC: 4 }]
  assert.equal(pickAuthoritativeMoves(null, moves), moves)
  assert.equal(pickAuthoritativeMoves(moves, undefined), moves)
  assert.deepEqual(pickAuthoritativeMoves(null, null), [])
})

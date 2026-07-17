const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const contractPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'learning-contract.mjs')
))

function review(overrides = {}) {
  return {
    matchId: 'm1',
    matchFingerprint: 'v1:4:aaaaaaaa',
    status: 'ready',
    analysisVersion: 'quick-v1',
    analyzedAt: '2026-07-15T18:00:00.000Z',
    completedAt: '',
    updatedAt: '2026-07-15T18:00:00.000Z',
    movesGraded: 10,
    lessonCount: 1,
    positiveCount: 0,
    firstLessonPly: 4,
    primaryTheme: 'general',
    takeaway: '',
    ...overrides,
  }
}

const MOVES = [
  { fr: 6, fc: 4, toR: 4, toC: 4, promType: 'queen' },
  { fr: 1, fc: 4, toR: 3, toC: 4, promType: 'queen' },
]

// ─── computeMatchFingerprint ───────────────────────────────────────────────

test('computeMatchFingerprint: deterministic and changes when moves change', async () => {
  const { computeMatchFingerprint } = await contractPromise
  const a = computeMatchFingerprint(MOVES)
  const b = computeMatchFingerprint(MOVES)
  assert.equal(a, b)
  assert.match(a, /^v1:2:[0-9a-f]{8}$/)

  const different = computeMatchFingerprint([...MOVES, { fr: 7, fc: 3, toR: 3, toC: 7, promType: 'queen' }])
  assert.notEqual(a, different)
})

test('computeMatchFingerprint: empty/missing moves never throws', async () => {
  const { computeMatchFingerprint } = await contractPromise
  assert.equal(computeMatchFingerprint([]), 'v1:0:811c9dc5')
  assert.equal(computeMatchFingerprint(undefined), 'v1:0:811c9dc5')
})

// ─── trimTakeaway ───────────────────────────────────────────────────────────

test('trimTakeaway: trims whitespace and caps at 120 characters', async () => {
  const { trimTakeaway, TAKEAWAY_MAX_LENGTH } = await contractPromise
  assert.equal(trimTakeaway('  hello  '), 'hello')
  assert.equal(trimTakeaway(''), '')
  assert.equal(trimTakeaway(null), '')
  assert.equal(trimTakeaway(undefined), '')
  const long = 'x'.repeat(200)
  assert.equal(trimTakeaway(long).length, TAKEAWAY_MAX_LENGTH)
})

// ─── normalizeLearningRecord ────────────────────────────────────────────────

test('normalizeLearningRecord: tolerates junk input', async () => {
  const { normalizeLearningRecord } = await contractPromise
  assert.deepEqual(normalizeLearningRecord(null), { schemaVersion: 1, reviews: [], updatedAt: '' })
  assert.deepEqual(normalizeLearningRecord(undefined), { schemaVersion: 1, reviews: [], updatedAt: '' })
  assert.deepEqual(normalizeLearningRecord('garbage'), { schemaVersion: 1, reviews: [], updatedAt: '' })
  assert.deepEqual(normalizeLearningRecord({ reviews: 'not-an-array' }), { schemaVersion: 1, reviews: [], updatedAt: '' })
  assert.deepEqual(normalizeLearningRecord({ reviews: [null, 42, {}, { matchId: '' }] }), { schemaVersion: 1, reviews: [], updatedAt: '' })
})

test('normalizeLearningRecord: legacy/malformed review fields degrade to safe defaults', async () => {
  const { normalizeLearningRecord } = await contractPromise
  const result = normalizeLearningRecord({
    reviews: [{
      matchId: 'm1',
      status: 'bogus-status',
      movesGraded: 'not-a-number',
      firstLessonPly: null,
      primaryTheme: 'made-up-theme',
      takeaway: 123, // non-string input is coerced, not blanked — never throws
    }],
  })
  const r = result.reviews[0]
  assert.equal(r.status, undefined)
  assert.equal(r.movesGraded, 0)
  assert.equal(r.firstLessonPly, -1)
  assert.equal(r.primaryTheme, 'general')
  assert.equal(r.takeaway, '123')
})

test('normalizeLearningRecord: caps to the 50 most recent entries', async () => {
  const { normalizeLearningRecord, LEARNING_INDEX_CAP } = await contractPromise
  const reviews = Array.from({ length: 60 }, (_, i) => review({ matchId: `m${i}` }))
  const result = normalizeLearningRecord({ reviews })
  assert.equal(result.reviews.length, LEARNING_INDEX_CAP)
})

test('normalizeLearningRecord: preserves unknown fields on a review', async () => {
  const { normalizeLearningRecord } = await contractPromise
  const result = normalizeLearningRecord({ reviews: [{ ...review(), futureField: 'kept' }] })
  assert.equal(result.reviews[0].futureField, 'kept')
})

// ─── buildLearningRecordValue ───────────────────────────────────────────────

test('buildLearningRecordValue: always private, capped, and sorted newest-updated-first', async () => {
  const { buildLearningRecordValue, LEARNING_INDEX_CAP } = await contractPromise
  const reviews = [
    review({ matchId: 'old', updatedAt: '2026-07-01T00:00:00.000Z' }),
    review({ matchId: 'new', updatedAt: '2026-07-15T00:00:00.000Z' }),
  ]
  const value = buildLearningRecordValue({ reviews })
  assert.deepEqual(value.__META, { is_public: false })
  assert.equal(value.reviews[0].matchId, 'new')
  assert.equal(value.reviews[1].matchId, 'old')

  const overflow = buildLearningRecordValue({ reviews: Array.from({ length: 60 }, (_, i) => review({ matchId: `m${i}` })) })
  assert.equal(overflow.reviews.length, LEARNING_INDEX_CAP)
})

test('buildLearningRecordValue: private metadata present even for an empty record', async () => {
  const { buildLearningRecordValue } = await contractPromise
  const value = buildLearningRecordValue({ reviews: [] })
  assert.deepEqual(value.__META, { is_public: false })
  assert.deepEqual(value.reviews, [])
})

// ─── mergeReviewIntoRecord ──────────────────────────────────────────────────

test('mergeReviewIntoRecord: newest updatedAt wins on a timestamp conflict', async () => {
  const { mergeReviewIntoRecord } = await contractPromise
  const record = { reviews: [review({ matchId: 'm1', status: 'reviewed', updatedAt: '2026-07-15T18:00:00.000Z', takeaway: 'newer' })] }
  const staleIncoming = review({ matchId: 'm1', status: 'ready', updatedAt: '2026-07-15T17:00:00.000Z', takeaway: '' })
  const merged = mergeReviewIntoRecord(record, staleIncoming)
  assert.equal(merged.reviews.find(r => r.matchId === 'm1').status, 'reviewed')
  assert.equal(merged.reviews.find(r => r.matchId === 'm1').takeaway, 'newer')
})

test('mergeReviewIntoRecord: a genuinely newer write replaces the old one', async () => {
  const { mergeReviewIntoRecord } = await contractPromise
  const record = { reviews: [review({ matchId: 'm1', status: 'ready', updatedAt: '2026-07-15T17:00:00.000Z' })] }
  const newerIncoming = review({ matchId: 'm1', status: 'reviewed', updatedAt: '2026-07-15T18:00:00.000Z', takeaway: 'done' })
  const merged = mergeReviewIntoRecord(record, newerIncoming)
  assert.equal(merged.reviews.find(r => r.matchId === 'm1').status, 'reviewed')
  assert.equal(merged.reviews.find(r => r.matchId === 'm1').takeaway, 'done')
})

test('mergeReviewIntoRecord: different matchIds coexist', async () => {
  const { mergeReviewIntoRecord } = await contractPromise
  const record = { reviews: [review({ matchId: 'm1' })] }
  const merged = mergeReviewIntoRecord(record, review({ matchId: 'm2' }))
  assert.equal(merged.reviews.length, 2)
})

test('mergeReviewIntoRecord: no matchId is a no-op', async () => {
  const { mergeReviewIntoRecord } = await contractPromise
  const record = { reviews: [review({ matchId: 'm1' })] }
  assert.deepEqual(mergeReviewIntoRecord(record, null), record)
  assert.deepEqual(mergeReviewIntoRecord(record, {}), record)
})

// ─── reviewBadge ────────────────────────────────────────────────────────────

test('reviewBadge: matching fingerprint + ready -> Lesson ready', async () => {
  const { reviewBadge, computeMatchFingerprint } = await contractPromise
  const match = { id: 'm1', moves: MOVES }
  const record = { reviews: [review({ matchId: 'm1', status: 'ready', matchFingerprint: computeMatchFingerprint(MOVES) })] }
  assert.deepEqual(reviewBadge(record, match), { label: 'Lesson ready', takeaway: '' })
})

test('reviewBadge: matching fingerprint + reviewed -> Reviewed with takeaway', async () => {
  const { reviewBadge, computeMatchFingerprint } = await contractPromise
  const match = { id: 'm1', moves: MOVES }
  const record = {
    reviews: [review({
      matchId: 'm1', status: 'reviewed', matchFingerprint: computeMatchFingerprint(MOVES),
      takeaway: 'Check what their last move attacks.',
    })],
  }
  assert.deepEqual(reviewBadge(record, match), { label: 'Reviewed', takeaway: 'Check what their last move attacks.' })
})

test('reviewBadge: fingerprint mismatch downgrades a reviewed match, clears a ready one', async () => {
  const { reviewBadge } = await contractPromise
  const match = { id: 'm1', moves: MOVES }
  const reviewedRecord = { reviews: [review({ matchId: 'm1', status: 'reviewed', matchFingerprint: 'v1:999:deadbeef' })] }
  assert.deepEqual(reviewBadge(reviewedRecord, match), { label: 'Review again', takeaway: '' })

  const readyRecord = { reviews: [review({ matchId: 'm1', status: 'ready', matchFingerprint: 'v1:999:deadbeef' })] }
  assert.deepEqual(reviewBadge(readyRecord, match), { label: null, takeaway: '' })
})

test('reviewBadge: no stored review, or no match id, yields no badge', async () => {
  const { reviewBadge } = await contractPromise
  assert.deepEqual(reviewBadge({ reviews: [] }, { id: 'm1', moves: MOVES }), { label: null, takeaway: '' })
  assert.deepEqual(reviewBadge({ reviews: [review()] }, { id: '', moves: MOVES }), { label: null, takeaway: '' })
  assert.deepEqual(reviewBadge(null, { id: 'm1', moves: MOVES }), { label: null, takeaway: '' })
})

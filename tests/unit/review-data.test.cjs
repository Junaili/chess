const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const reviewPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'review-data.mjs')
))

// A player-ply grade as produced by chessBackgroundWorker.analyzeMatch
// (scope: 'player') / gradeMoveInPosition.
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

// ─── buildReviewLessons ────────────────────────────────────────────────────

test('buildReviewLessons: picks blunders as lessons, highest cost first', async () => {
  const { buildReviewLessons } = await reviewPromise
  const grades = [
    grade({ moveIndex: 0, grade: 'Better move available', loss: 150, playedNotation: 'Qh5', bestNotation: 'Nf3' }),
    grade({ moveIndex: 2, grade: 'Better move available', loss: 500, playedNotation: 'Qxh7', bestNotation: 'O-O' }),
    grade({ moveIndex: 4, grade: 'Strong move', loss: 10 }),
  ]
  const { lessons } = buildReviewLessons(grades, 6)
  assert.equal(lessons.length, 2)
  assert.equal(lessons[0].ply, 2) // 500cp loss ranks above 150cp
  assert.equal(lessons[1].ply, 0)
})

test('buildReviewLessons: ties on loss break by earliest ply', async () => {
  const { buildReviewLessons } = await reviewPromise
  const grades = [
    grade({ moveIndex: 4, grade: 'Better move available', loss: 300 }),
    grade({ moveIndex: 0, grade: 'Better move available', loss: 300 }),
  ]
  const { lessons } = buildReviewLessons(grades, 6)
  assert.equal(lessons[0].ply, 0)
  assert.equal(lessons[1].ply, 4)
})

test('buildReviewLessons: caps at 3 lessons even with more blunders', async () => {
  const { buildReviewLessons } = await reviewPromise
  const grades = [0, 2, 4, 6, 8].map(ply => grade({ moveIndex: ply, grade: 'Better move available', loss: 200 + ply }))
  const { lessons } = buildReviewLessons(grades, 10)
  assert.equal(lessons.length, 3)
})

test('buildReviewLessons: no blunders means no lessons and no positive highlight required', async () => {
  const { buildReviewLessons } = await reviewPromise
  const grades = [grade({ grade: 'Strong move', loss: 5 }), grade({ moveIndex: 2, grade: 'Playable', loss: 60 })]
  const { lessons, positiveHighlight } = buildReviewLessons(grades, 4)
  assert.equal(lessons.length, 0)
  assert.equal(positiveHighlight, null)
})

test('buildReviewLessons: surfaces a punished-blunder positive highlight', async () => {
  const { buildReviewLessons } = await reviewPromise
  // Opponent's previous move handed over material (preScore jumps from the
  // prior player ply's playedScore); this ply's grade shows the player took it.
  const grades = [
    grade({ moveIndex: 0, grade: 'Strong move', loss: 0, playedScore: 0, preScore: 0 }),
    grade({ moveIndex: 2, grade: 'Strong move', loss: 0, playedScore: 200, preScore: 200, matchedBest: true, playedNotation: 'Qxd5' }),
  ]
  const { positiveHighlight } = buildReviewLessons(grades, 4)
  assert.equal(positiveHighlight?.kind, 'punished')
})

// ─── selectFirstReviewPly ──────────────────────────────────────────────────

test('selectFirstReviewPly: opens on the highest-cost lesson', async () => {
  const { buildReviewLessons, selectFirstReviewPly } = await reviewPromise
  const grades = [
    grade({ moveIndex: 0, grade: 'Better move available', loss: 150 }),
    grade({ moveIndex: 2, grade: 'Better move available', loss: 500 }),
  ]
  const { lessons } = buildReviewLessons(grades, 6)
  assert.equal(selectFirstReviewPly(lessons, 6), 2)
})

test('selectFirstReviewPly: with no lesson, lands on the final ply', async () => {
  const { selectFirstReviewPly } = await reviewPromise
  assert.equal(selectFirstReviewPly([], 12), 11)
})

test('selectFirstReviewPly: degenerate zero-length game does not go negative', async () => {
  const { selectFirstReviewPly } = await reviewPromise
  assert.equal(selectFirstReviewPly([], 0), 0)
})

// ─── formatReviewLoss / formatReviewGain (mate-scale copy) ────────────────

test('formatReviewLoss: ordinary losses render as pawns, decisive losses avoid pawn counts', async () => {
  const { formatReviewLoss } = await reviewPromise
  assert.equal(formatReviewLoss(50), 'gave up 0.5 pawns')
  assert.equal(formatReviewLoss(320), 'gave up 3.2 pawns')
  assert.equal(formatReviewLoss(100000), 'let a winning position slip') // real mate score
  assert.equal(formatReviewLoss(6000), 'let a winning position slip') // above the mate-scale threshold
})

test('formatReviewGain: ordinary gains render as a hyphenated pawn adjective, decisive gains avoid pawn counts', async () => {
  const { formatReviewGain } = await reviewPromise
  assert.equal(formatReviewGain(250), 'found a 2.5-pawn swing')
  assert.equal(formatReviewGain(100000), 'turned a losing position around')
})

test('formatReviewLoss/Gain: negative or missing input never throws or goes negative', async () => {
  const { formatReviewLoss, formatReviewGain } = await reviewPromise
  assert.equal(formatReviewLoss(-50), 'gave up 0.0 pawns')
  assert.equal(formatReviewGain(undefined), 'found a 0.0-pawn swing')
})

test('formatReviewLoss: exactly one pawn is singular, everything else is plural', async () => {
  const { formatReviewLoss } = await reviewPromise
  assert.equal(formatReviewLoss(100), 'gave up 1.0 pawn')
  assert.equal(formatReviewLoss(0), 'gave up 0.0 pawns')
  assert.equal(formatReviewLoss(200), 'gave up 2.0 pawns')
})

// ─── buildReviewSummary ────────────────────────────────────────────────────

test('buildReviewSummary: leads with the positive highlight before the lesson count (dev-plan §4.4 rule 1)', async () => {
  const { buildReviewSummary } = await reviewPromise
  const summary = buildReviewSummary({
    lessons: [{ ply: 4 }],
    positiveHighlight: { kind: 'punished', ply: 2, gain: 200 },
  })
  const positiveIdx = summary.indexOf('spotted and punished')
  const lessonIdx = summary.indexOf('moment')
  assert.ok(positiveIdx >= 0 && positiveIdx < lessonIdx, `expected positive framing first, got: "${summary}"`)
})

test('buildReviewSummary: no lessons and no highlight reads as a calm clean-game summary', async () => {
  const { buildReviewSummary } = await reviewPromise
  const summary = buildReviewSummary({ lessons: [], positiveHighlight: null })
  assert.equal(summary, 'No moments flagged — clean game.')
})

test('buildReviewSummary: singular vs plural lesson count', async () => {
  const { buildReviewSummary } = await reviewPromise
  assert.match(buildReviewSummary({ lessons: [{ ply: 0 }], positiveHighlight: null }), /^1 moment worth/)
  assert.match(buildReviewSummary({ lessons: [{ ply: 0 }, { ply: 2 }], positiveHighlight: null }), /^2 moments worth/)
})

test('buildReviewSummary: swing highlight uses gain-framed language, punished uses mistake-framed language', async () => {
  const { buildReviewSummary } = await reviewPromise
  const swing = buildReviewSummary({ lessons: [], positiveHighlight: { kind: 'swing', ply: 0, gain: 300 } })
  assert.match(swing, /found a 3\.0-pawn swing/)
  const punished = buildReviewSummary({ lessons: [], positiveHighlight: { kind: 'punished', ply: 0, gain: 300 } })
  assert.match(punished, /spotted and punished a mistake/)
})

// ─── reviewLessonLabel ─────────────────────────────────────────────────────

test('reviewLessonLabel: plain-language line with the recommended alternative', async () => {
  const { reviewLessonLabel } = await reviewPromise
  const label = reviewLessonLabel({ playedNotation: 'Qxh7', loss: 320, bestNotation: 'O-O' })
  assert.equal(label, 'Qxh7 gave up 3.2 pawns — try O-O.')
})

test('reviewLessonLabel: no recommended move degrades gracefully', async () => {
  const { reviewLessonLabel } = await reviewPromise
  assert.equal(reviewLessonLabel({ playedNotation: 'Qxh7', loss: 320, bestNotation: '' }), 'Qxh7 gave up 3.2 pawns.')
})

test('reviewLessonLabel: null lesson returns empty string, never throws', async () => {
  const { reviewLessonLabel } = await reviewPromise
  assert.equal(reviewLessonLabel(null), '')
})

// ─── reviewPrimaryTheme ────────────────────────────────────────────────────

test('reviewPrimaryTheme: always "general" in M3 — no speculative tactical classification', async () => {
  const { reviewPrimaryTheme } = await reviewPromise
  assert.equal(reviewPrimaryTheme(), 'general')
})

// ─── suggestedTakeaways ─────────────────────────────────────────────────────

test('suggestedTakeaways: different chip sets for a lesson game vs a clean game', async () => {
  const { suggestedTakeaways } = await reviewPromise
  const withLesson = suggestedTakeaways([{ ply: 4 }])
  const clean = suggestedTakeaways([])
  assert.ok(withLesson.length > 0)
  assert.ok(clean.length > 0)
  assert.notDeepEqual(withLesson, clean)
})

test('suggestedTakeaways: missing input degrades to the clean-game set, never throws', async () => {
  const { suggestedTakeaways } = await reviewPromise
  assert.deepEqual(suggestedTakeaways(undefined), suggestedTakeaways([]))
  assert.deepEqual(suggestedTakeaways(null), suggestedTakeaways([]))
})

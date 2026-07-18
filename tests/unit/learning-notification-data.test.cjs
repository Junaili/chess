const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const dataPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'learning-notification-data.mjs')
))

const NOW = new Date('2026-07-17T19:00:00.000Z')

function kinds(candidates) {
  return candidates.map(c => c.kind).sort()
}

test('deriveLearningCandidates: empty/null/malformed snapshot yields no candidates, never throws', async () => {
  const { deriveLearningCandidates } = await dataPromise
  assert.deepEqual(deriveLearningCandidates(null, NOW), [])
  assert.deepEqual(deriveLearningCandidates(undefined, NOW), [])
  assert.deepEqual(deriveLearningCandidates({}, NOW), [])
  assert.deepEqual(deriveLearningCandidates({ practice: null, review: 'nope', goal: 42 }, NOW), [])
})

test('deriveLearningCandidates: practice_due only fires on playableDueCount, not the broader dueCount', async () => {
  const { deriveLearningCandidates } = await dataPromise
  const withUnplayableDue = { practice: { dueCount: 3, playableDueCount: 0 } }
  assert.deepEqual(kinds(deriveLearningCandidates(withUnplayableDue, NOW)), [])

  const withPlayableDue = { practice: { dueCount: 3, playableDueCount: 2 } }
  const candidates = deriveLearningCandidates(withPlayableDue, NOW)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, 'practice_due')
  assert.equal(candidates[0].priority, 100)
  assert.equal(candidates[0].safeVariables.exactCount, 2)
  assert.equal(candidates[0].safeVariables.countBucket, 'few')
  assert.deepEqual(candidates[0].allowedChannels, ['in_app', 'native_local'])
})

test('deriveLearningCandidates: review_unfinished requires 12h+ since oldestReadyAt', async () => {
  const { deriveLearningCandidates } = await dataPromise
  const tooRecent = { review: { unfinishedCount: 1, oldestReadyAt: new Date(NOW.getTime() - 11 * 3600000).toISOString() } }
  assert.deepEqual(kinds(deriveLearningCandidates(tooRecent, NOW)), [])

  const exactlyOld = { review: { unfinishedCount: 1, oldestReadyAt: new Date(NOW.getTime() - 12 * 3600000).toISOString() } }
  assert.deepEqual(kinds(deriveLearningCandidates(exactlyOld, NOW)), ['review_unfinished'])
})

test('deriveLearningCandidates: review_unfinished with a missing/invalid timestamp never fires (fails closed)', async () => {
  const { deriveLearningCandidates } = await dataPromise
  assert.deepEqual(kinds(deriveLearningCandidates({ review: { unfinishedCount: 1 } }, NOW)), [])
  assert.deepEqual(kinds(deriveLearningCandidates({ review: { unfinishedCount: 1, oldestReadyAt: 'garbage' } }, NOW)), [])
})

test('deriveLearningCandidates: goal_achieved fires exactly once per completion, keyed by completedAt', async () => {
  const { deriveLearningCandidates } = await dataPromise
  const snapshot = { goal: { status: 'achieved', completedAt: '2026-07-16T00:00:00.000Z' } }
  const candidates = deriveLearningCandidates(snapshot, NOW)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, 'goal_achieved')
  assert.equal(candidates[0].key, 'goal_achieved:2026-07-16T00:00:00.000Z')
  assert.deepEqual(candidates[0].allowedChannels, ['in_app'])
})

test('deriveLearningCandidates: goal_focus selects milestone copy at 50%+ or target-1, default copy otherwise', async () => {
  const { deriveLearningCandidates } = await dataPromise
  const quiet = deriveLearningCandidates({ goal: { status: 'active', target: 5, completed: 1 } }, NOW)
  assert.equal(quiet[0].copyKey, 'goal_focus_default')

  const halfway = deriveLearningCandidates({ goal: { status: 'active', target: 4, completed: 2 } }, NOW)
  assert.equal(halfway[0].copyKey, 'goal_focus_milestone')

  const oneAway = deriveLearningCandidates({ goal: { status: 'active', target: 5, completed: 4 } }, NOW)
  assert.equal(oneAway[0].copyKey, 'goal_focus_milestone')
})

test('deriveLearningCandidates: goal_focus never fires without a positive target', async () => {
  const { deriveLearningCandidates } = await dataPromise
  assert.deepEqual(kinds(deriveLearningCandidates({ goal: { status: 'active', target: 0, completed: 0 } }, NOW)), [])
  assert.deepEqual(kinds(deriveLearningCandidates({ goal: { status: 'active' } }, NOW)), [])
})

test('deriveLearningCandidates: recap_ready needs two+ new games, or one game stale 48h+', async () => {
  const { deriveLearningCandidates } = await dataPromise
  assert.deepEqual(kinds(deriveLearningCandidates({ recap: { replayableNewMatchCount: 1 } }, NOW)), [])

  const twoNew = deriveLearningCandidates({ recap: { replayableNewMatchCount: 2 } }, NOW)
  assert.deepEqual(kinds(twoNew), ['recap_ready'])

  const oneFresh = deriveLearningCandidates(
    { recap: { replayableNewMatchCount: 1, oldestNewMatchAt: new Date(NOW.getTime() - 10 * 3600000).toISOString() } }, NOW)
  assert.deepEqual(kinds(oneFresh), [])

  const oneStale = deriveLearningCandidates(
    { recap: { replayableNewMatchCount: 1, oldestNewMatchAt: new Date(NOW.getTime() - 48 * 3600000).toISOString() } }, NOW)
  assert.deepEqual(kinds(oneStale), ['recap_ready'])
})

test('deriveLearningCandidates: candidate expiry is deterministic for the same snapshot and time', async () => {
  const { deriveLearningCandidates } = await dataPromise
  const snapshot = { practice: { playableDueCount: 1 } }
  const a = deriveLearningCandidates(snapshot, NOW)
  const b = deriveLearningCandidates(snapshot, NOW)
  assert.deepEqual(a, b)
})

test('deriveLearningCandidates: all five release kinds can be simultaneously eligible', async () => {
  const { deriveLearningCandidates } = await dataPromise
  const snapshot = {
    practice: { playableDueCount: 3 },
    review: { unfinishedCount: 1, oldestReadyAt: new Date(NOW.getTime() - 24 * 3600000).toISOString() },
    goal: { status: 'active', target: 5, completed: 1 },
    recap: { replayableNewMatchCount: 2 },
  }
  assert.deepEqual(
    kinds(deriveLearningCandidates(snapshot, NOW)),
    ['goal_focus', 'practice_due', 'recap_ready', 'review_unfinished'],
  )
})

test('countBucket: one/few/several boundaries', async () => {
  const { countBucket } = await dataPromise
  assert.equal(countBucket(1), 'one')
  assert.equal(countBucket(2), 'few')
  assert.equal(countBucket(4), 'few')
  assert.equal(countBucket(5), 'several')
  assert.equal(countBucket(20), 'several')
})

test('formatLearningCopy: in_app resolves templated fields from safeVariables', async () => {
  const { formatLearningCopy } = await dataPromise
  const candidate = { copyKey: 'practice_due', safeVariables: { exactCount: 3, countBucket: 'few' } }
  const copy = formatLearningCopy(candidate, 'in_app')
  assert.equal(copy.title, 'Practice due: 3')
  assert.equal(copy.cta, 'Practice now')
  assert.ok(copy.body.length > 0)
})

test('formatLearningCopy: external/external_child variants differ, and never carry a CTA', async () => {
  const { formatLearningCopy } = await dataPromise
  const candidate = { copyKey: 'review_unfinished', safeVariables: {} }
  const external = formatLearningCopy(candidate, 'external')
  const child = formatLearningCopy(candidate, 'external_child')
  assert.equal(external.title, 'Finish your Quick Review')
  assert.equal(child.title, 'Finish looking back')
  assert.equal(external.cta, '')
  assert.equal(child.cta, '')
})

test('formatLearningCopy: returns null for channels a kind has no copy for, never guesses text', async () => {
  const { formatLearningCopy } = await dataPromise
  const goalAchieved = { copyKey: 'goal_achieved', safeVariables: {} }
  assert.equal(formatLearningCopy(goalAchieved, 'external'), null)
  assert.equal(formatLearningCopy(goalAchieved, 'external_child'), null)
  assert.equal(formatLearningCopy({ copyKey: 'not_a_real_key' }, 'in_app'), null)
})

test('formatLearningCopy: ignores unknown/unsafe fields smuggled into safeVariables', async () => {
  const { formatLearningCopy } = await dataPromise
  const candidate = {
    copyKey: 'practice_due',
    safeVariables: { exactCount: 2, countBucket: 'few', opponentName: 'Maria', reflection: 'secret takeaway' },
  }
  const copy = formatLearningCopy(candidate, 'in_app')
  assert.ok(!copy.title.includes('Maria'))
  assert.ok(!copy.body.includes('secret takeaway'))
})

test('resolveLearningIntent: maps every release intent, and returns null for unknown intents', async () => {
  const { resolveLearningIntent } = await dataPromise
  assert.deepEqual(resolveLearningIntent({ target: { intent: 'practice' } }),
    { screen: 'profile', tab: 'journal', anchor: 'journal-practice-queue' })
  assert.deepEqual(resolveLearningIntent({ target: { intent: 'review' } }),
    { screen: 'profile', tab: 'history', anchor: null })
  assert.deepEqual(resolveLearningIntent({ target: { intent: 'goal' } }),
    { screen: 'profile', tab: 'journal', anchor: 'journal-active-goal' })
  assert.deepEqual(resolveLearningIntent({ target: { intent: 'recap' } }),
    { screen: 'profile', tab: 'journal', anchor: 'journal-next-action' })
  assert.equal(resolveLearningIntent({ target: { intent: 'unknown' } }), null)
  assert.equal(resolveLearningIntent(null), null)
})

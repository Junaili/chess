const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const flagsPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'learning-flags.mjs')
))

test('resolveLearningFlags: empty env defaults every flag to false', async () => {
  const { resolveLearningFlags } = await flagsPromise
  const flags = resolveLearningFlags({})
  assert.deepEqual(flags, {
    historyV2: false,
    reviewV2: false,
    indexV1: false,
    practiceV2: false,
    goalsV2: false,
    journalLayoutV2: false,
    notificationsV1: false,
    nativeRemindersV1: false,
  })
})

test('resolveLearningFlags: unrelated env vars do not enable any flag', async () => {
  const { resolveLearningFlags } = await flagsPromise
  const flags = resolveLearningFlags({ VITE_ACCELBYTE_BASE_URL: 'https://example.com', MODE: 'production' })
  assert.equal(Object.values(flags).some(Boolean), false)
})

test('resolveLearningFlags: each flag independently turns on via its own env var', async () => {
  const { resolveLearningFlags, LEARNING_FLAG_ENV_VARS, LEARNING_FLAG_KEYS } = await flagsPromise
  for (const key of LEARNING_FLAG_KEYS) {
    const flags = resolveLearningFlags({ [LEARNING_FLAG_ENV_VARS[key]]: '1' })
    for (const otherKey of LEARNING_FLAG_KEYS) {
      assert.equal(flags[otherKey], otherKey === key, `expected only ${key} to be true, got ${JSON.stringify(flags)}`)
    }
  }
})

test('resolveLearningFlags: accepts "1", 1, true, and "true" as truthy; rejects everything else', async () => {
  const { resolveLearningFlags } = await flagsPromise
  const truthyValues = ['1', 1, true, 'true']
  const falsyValues = ['0', 0, false, 'false', '', 'yes', 'on', undefined, null]

  for (const value of truthyValues) {
    const flags = resolveLearningFlags({ VITE_LEARNING_HISTORY_V2: value })
    assert.equal(flags.historyV2, true, `expected ${JSON.stringify(value)} to be truthy`)
  }
  for (const value of falsyValues) {
    const flags = resolveLearningFlags({ VITE_LEARNING_HISTORY_V2: value })
    assert.equal(flags.historyV2, false, `expected ${JSON.stringify(value)} to be falsy`)
  }
})

test('resolveLearningFlags: overrides win over env for keys they define', async () => {
  const { resolveLearningFlags } = await flagsPromise
  const flags = resolveLearningFlags(
    { VITE_LEARNING_REVIEW_V2: '1' },
    { reviewV2: false, indexV1: true }
  )
  assert.equal(flags.reviewV2, false)
  assert.equal(flags.indexV1, true)
})

test('resolveLearningFlags: overrides leave undeclared keys governed by env', async () => {
  const { resolveLearningFlags } = await flagsPromise
  const flags = resolveLearningFlags(
    { VITE_LEARNING_HISTORY_V2: '1' },
    { reviewV2: true }
  )
  assert.equal(flags.historyV2, true)
  assert.equal(flags.reviewV2, true)
  assert.equal(flags.goalsV2, false)
})

test('resolveLearningFlags: null/undefined overrides are ignored, not treated as all-false', async () => {
  const { resolveLearningFlags } = await flagsPromise
  assert.equal(resolveLearningFlags({ VITE_LEARNING_GOALS_V2: '1' }, null).goalsV2, true)
  assert.equal(resolveLearningFlags({ VITE_LEARNING_GOALS_V2: '1' }, undefined).goalsV2, true)
})

test('resolveLearningFlags: unknown override keys do not leak into the result', async () => {
  const { resolveLearningFlags, LEARNING_FLAG_KEYS } = await flagsPromise
  const flags = resolveLearningFlags({}, { notARealFlag: true })
  assert.deepEqual(Object.keys(flags).sort(), [...LEARNING_FLAG_KEYS].sort())
})

// ─── Rollout percentage gating (N4) ────────────────────────────────────────

test('resolveLearningRolloutPercents: missing/invalid env defaults to 100 (full rollout)', async () => {
  const { resolveLearningRolloutPercents } = await flagsPromise
  assert.deepEqual(resolveLearningRolloutPercents({}), { notificationsV1: 100, nativeRemindersV1: 100 })
  assert.deepEqual(
    resolveLearningRolloutPercents({ VITE_LEARNING_NOTIFICATIONS_ROLLOUT_PCT: 'not-a-number' }),
    { notificationsV1: 100, nativeRemindersV1: 100 },
  )
})

test('resolveLearningRolloutPercents: clamps out-of-range values into 0..100', async () => {
  const { resolveLearningRolloutPercents } = await flagsPromise
  assert.equal(resolveLearningRolloutPercents({ VITE_LEARNING_NOTIFICATIONS_ROLLOUT_PCT: '-20' }).notificationsV1, 0)
  assert.equal(resolveLearningRolloutPercents({ VITE_LEARNING_NOTIFICATIONS_ROLLOUT_PCT: '150' }).notificationsV1, 100)
  assert.equal(resolveLearningRolloutPercents({ VITE_LEARNING_NATIVE_REMINDERS_ROLLOUT_PCT: '10' }).nativeRemindersV1, 10)
})

test('isInRolloutPercent: 100 always true, 0 always false, regardless of userId', async () => {
  const { isInRolloutPercent } = await flagsPromise
  for (const userId of ['user-a', 'user-b', '', null, undefined]) {
    assert.equal(isInRolloutPercent(userId, 100), true)
    assert.equal(isInRolloutPercent(userId, 0), false)
  }
})

test('isInRolloutPercent: deterministic — same userId+percent always agrees with itself', async () => {
  const { isInRolloutPercent } = await flagsPromise
  for (const userId of ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']) {
    const first = isInRolloutPercent(userId, 50)
    for (let i = 0; i < 5; i++) assert.equal(isInRolloutPercent(userId, 50), first)
  }
})

test('isInRolloutPercent: roughly the requested share of a large user population is included', async () => {
  const { isInRolloutPercent } = await flagsPromise
  const total = 2000
  const included = Array.from({ length: total }, (_, i) => `user-${i}`)
    .filter(userId => isInRolloutPercent(userId, 10)).length
  const share = included / total
  assert.ok(share > 0.05 && share < 0.15, `expected ~10% inclusion, got ${(share * 100).toFixed(1)}%`)
})

test('isInRolloutPercent: a user included at a lower percent stays included as the percent rises (monotonic)', async () => {
  const { isInRolloutPercent } = await flagsPromise
  for (let i = 0; i < 200; i++) {
    const userId = `user-${i}`
    if (isInRolloutPercent(userId, 10)) assert.equal(isInRolloutPercent(userId, 50), true)
    if (isInRolloutPercent(userId, 50)) assert.equal(isInRolloutPercent(userId, 100), true)
  }
})

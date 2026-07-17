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

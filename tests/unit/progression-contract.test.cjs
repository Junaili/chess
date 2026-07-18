const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const contractPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'progression-contract.mjs')
))

// §4.3's canonical example, verbatim field-for-field.
function skillEvent(overrides = {}) {
  return {
    gameId: 'g_8f3',
    ts: '2026-07-15T20:11:00Z',
    tier: 't2',
    timeControl: 'rapid',
    playerColor: 'w',
    opponentRating: 1180,
    matchmade: true,
    accuracy: 71.4,
    blunders: 1,
    movesN: 42,
    clockCurve: [0.98, 0.96, 0.9],
    criticalMoments: [{ move: 18, spentPct: 0.14, evalVol: 1.8 }],
    events: [
      { type: 'missed_tactic', motif: 'knight_fork', move: 23, evalDelta: -2.1, phase: 'middlegame' },
      { type: 'endgame_phase', fromMove: 34, accuracy: 88.0, material: 'R+P' },
    ],
    ...overrides,
  }
}

// §5.1's request example plus the BR-1.2 tier label.
function t1Summary(overrides = {}) {
  return {
    gameId: 'g_8f3',
    tier: 't1',
    summary: {
      accuracy: 71.4,
      blunders: [23],
      bestMoments: [{ move: 18, kind: 'found_tactic' }],
      clockCurve: [0.98, 0.9],
      ...(overrides.summary || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'summary')),
  }
}

function reportPayload(overrides = {}) {
  return {
    mode: 'standard',
    tier: 't1',
    headline: { key: 'headline.best_accuracy_30d', params: { value: 96.4 } },
    moments: [{ move: 18, kind: 'found_tactic' }],
    dimensionTicks: [{ dimension: 'accuracy', delta: 1.2 }],
    recordCandidates: [{ type: 'highest_accuracy', value: 96.4 }],
    nextStep: { key: 'next.drill_knight_forks' },
    ...overrides,
  }
}

test('enums are frozen and cover the blueprint §4.3 values', async () => {
  const { EVENT_TYPES, DIMENSIONS, REPORT_MODES, TIERS, CONTRACT_VERSION } = await contractPromise
  assert.equal(CONTRACT_VERSION, 2)
  assert.ok(Object.isFrozen(EVENT_TYPES))
  assert.ok(Object.isFrozen(DIMENSIONS))
  assert.ok(Object.isFrozen(REPORT_MODES))
  assert.ok(Object.isFrozen(TIERS))
  assert.deepEqual([...EVENT_TYPES], [
    'found_tactic', 'missed_tactic', 'blunder', 'endgame_phase',
    'conversion_won', 'conversion_lost', 'save', 'loss_held_then_lost',
    'time_pressure_blunder', 'opening_deviation', 'principle_violation',
  ])
  assert.deepEqual([...DIMENSIONS], [
    'accuracy', 'blunder_resistance', 'tactics_pattern',
    'tactics_calc', 'endgame', 'time_allocation',
  ])
  assert.deepEqual([...REPORT_MODES], ['standard', 'roughGame', 'wellPlayedLoss'])
  assert.deepEqual([...TIERS], ['t1', 't2', 't3'])
})

test('validateSkillEvent accepts the §4.3 canonical example', async () => {
  const { validateSkillEvent } = await contractPromise
  assert.deepEqual(validateSkillEvent(skillEvent()), { ok: true })
})

test('validateSkillEvent tolerates unknown extra fields', async () => {
  const { validateSkillEvent } = await contractPromise
  assert.equal(validateSkillEvent(skillEvent({ futureField: { nested: true } })).ok, true)
})

test('validateSkillEvent rejects a bad tier', async () => {
  const { validateSkillEvent } = await contractPromise
  const result = validateSkillEvent(skillEvent({ tier: 't9' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /tier/)
})

test('validateSkillEvent rejects an unknown event type', async () => {
  const { validateSkillEvent } = await contractPromise
  const result = validateSkillEvent(skillEvent({ events: [{ type: 'brilliant_sacrifice', move: 5 }] }))
  assert.equal(result.ok, false)
  assert.match(result.error, /event type/)
})

test('validateSkillEvent rejects out-of-range accuracy and malformed critical moments', async () => {
  const { validateSkillEvent } = await contractPromise
  assert.equal(validateSkillEvent(skillEvent({ accuracy: 141 })).ok, false)
  assert.equal(validateSkillEvent(skillEvent({ criticalMoments: [{ move: 0, spentPct: 0.5, evalVol: 1 }] })).ok, false)
  assert.equal(validateSkillEvent(skillEvent({ criticalMoments: [{ move: 3, spentPct: 1.4, evalVol: 1 }] })).ok, false)
})

test('validateSkillEvent rejects non-boolean matchmade and missing gameId', async () => {
  const { validateSkillEvent } = await contractPromise
  assert.equal(validateSkillEvent(skillEvent({ matchmade: 'yes' })).ok, false)
  assert.equal(validateSkillEvent(skillEvent({ gameId: '' })).ok, false)
})

test('validateT1Summary accepts the §5.1 example with the t1 tier label', async () => {
  const { validateT1Summary } = await contractPromise
  assert.deepEqual(validateT1Summary(t1Summary()), { ok: true })
})

test('validateT1Summary rejects any non-t1 tier', async () => {
  const { validateT1Summary } = await contractPromise
  const result = validateT1Summary(t1Summary({ tier: 't2' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /t1/)
})

test('validateT1Summary rejects blunders that are not move numbers', async () => {
  const { validateT1Summary } = await contractPromise
  assert.equal(validateT1Summary(t1Summary({ summary: { blunders: [23, 0] } })).ok, false)
  assert.equal(validateT1Summary(t1Summary({ summary: { blunders: 'move 23' } })).ok, false)
})

test('validateT1Summary rejects a best moment with an unknown kind', async () => {
  const { validateT1Summary } = await contractPromise
  const result = validateT1Summary(t1Summary({ summary: { bestMoments: [{ move: 18, kind: 'nice_move' }] } }))
  assert.equal(result.ok, false)
  assert.match(result.error, /kind/)
})

test('validateT1Summary rejects a missing summary object', async () => {
  const { validateT1Summary } = await contractPromise
  assert.equal(validateT1Summary({ gameId: 'g_1', tier: 't1' }).ok, false)
})

test('validateReportPayload accepts a full standard-mode payload', async () => {
  const { validateReportPayload } = await contractPromise
  assert.deepEqual(validateReportPayload(reportPayload()), { ok: true })
})

test('validateReportPayload rejects an unknown mode', async () => {
  const { validateReportPayload } = await contractPromise
  const result = validateReportPayload(reportPayload({ mode: 'celebration' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /mode/)
})

test('validateReportPayload enforces the FR-3 three-moment cap', async () => {
  const { validateReportPayload } = await contractPromise
  const moments = [1, 2, 3, 4].map(move => ({ move, kind: 'blunder' }))
  const result = validateReportPayload(reportPayload({ moments }))
  assert.equal(result.ok, false)
  assert.match(result.error, /capped at 3/)
})

test('validateReportPayload rejects a tick outside the six dimensions', async () => {
  const { validateReportPayload } = await contractPromise
  const result = validateReportPayload(reportPayload({ dimensionTicks: [{ dimension: 'charisma', delta: 2 }] }))
  assert.equal(result.ok, false)
  assert.match(result.error, /dimension/)
})

test('validateReportPayload requires exactly one nextStep with a copy key', async () => {
  const { validateReportPayload } = await contractPromise
  assert.equal(validateReportPayload(reportPayload({ nextStep: null })).ok, false)
  assert.equal(validateReportPayload(reportPayload({ nextStep: {} })).ok, false)
})

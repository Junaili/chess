// Pure data contracts for Progression System v2 (PRG-001 —
// docs/progression-system-blueprint.md §4.3 SkillEvent, §5.1 T1 summary,
// §5.2 report payload). No DOM, no network, no I/O: every consumer — the T1
// client analyzer, the report view, and (mirrored in Go) the Extend service
// handlers — validates against these shapes at its own boundary. Follows
// learning-contract.mjs's philosophy: validators judge, they never strip —
// unknown fields are allowed so an older client tolerates a newer producer.

export const CONTRACT_VERSION = 2

// §4.3 SkillEvent `type` enum, verbatim. Frozen: the Go side keys its
// rule tables off these strings, so additions are a contract-version bump,
// never an in-place edit.
export const EVENT_TYPES = Object.freeze([
  'found_tactic',
  'missed_tactic',
  'blunder',
  'endgame_phase',
  'conversion_won',
  'conversion_lost',
  'save',
  'loss_held_then_lost',
  'time_pressure_blunder',
  'opening_deviation',
  'principle_violation',
])

// FR-2's six launch dimensions.
export const DIMENSIONS = Object.freeze([
  'accuracy',
  'blunder_resistance',
  'tactics_pattern',
  'tactics_calc',
  'endgame',
  'time_allocation',
])

// §6.4's deterministic report modes.
export const REPORT_MODES = Object.freeze(['standard', 'roughGame', 'wellPlayedLoss'])

// §3.4 analysis tiers. t1 = client quick look, t2 = server deep pass,
// t3 = verified (records/feats/trials only).
export const TIERS = Object.freeze(['t1', 't2', 't3'])

const ok = () => ({ ok: true })
const fail = error => ({ ok: false, error })

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isFinite01(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}

function isMoveNumber(value) {
  return Number.isInteger(value) && value >= 1
}

// validateSkillEvent: the canonical §4.3 per-game record emitted by T2/T3
// (subset by T1). Required game-level fields are strict; per-event optional
// fields are type-checked only when present — the blueprint pins the event
// `type` enum but deliberately not every per-type field combination, so this
// validator must not invent requirements the spec doesn't state.
export function validateSkillEvent(raw) {
  if (!raw || typeof raw !== 'object') return fail('skill event must be an object')
  if (!isNonEmptyString(raw.gameId)) return fail('gameId is required')
  if (!isTimestamp(raw.ts)) return fail('ts must be a parseable timestamp')
  if (!TIERS.includes(raw.tier)) return fail(`tier must be one of ${TIERS.join('|')}`)
  if (!isNonEmptyString(raw.timeControl)) return fail('timeControl is required')
  if (raw.playerColor !== 'w' && raw.playerColor !== 'b') return fail('playerColor must be "w" or "b"')
  if (!Number.isFinite(raw.opponentRating) || raw.opponentRating < 0) return fail('opponentRating must be a non-negative number')
  if (typeof raw.matchmade !== 'boolean') return fail('matchmade must be a boolean')
  if (!Number.isFinite(raw.accuracy) || raw.accuracy < 0 || raw.accuracy > 100) return fail('accuracy must be 0-100')
  if (!Number.isInteger(raw.blunders) || raw.blunders < 0) return fail('blunders must be a non-negative integer')
  if (!isMoveNumber(raw.movesN)) return fail('movesN must be a positive integer')
  if (!Array.isArray(raw.clockCurve) || raw.clockCurve.some(v => !Number.isFinite(v))) {
    return fail('clockCurve must be an array of finite numbers')
  }
  if (!Array.isArray(raw.criticalMoments)) return fail('criticalMoments must be an array')
  for (const moment of raw.criticalMoments) {
    if (!moment || typeof moment !== 'object') return fail('critical moment must be an object')
    if (!isMoveNumber(moment.move)) return fail('critical moment move must be a positive integer')
    if (!isFinite01(moment.spentPct)) return fail('critical moment spentPct must be 0-1')
    if (!Number.isFinite(moment.evalVol) || moment.evalVol < 0) return fail('critical moment evalVol must be a non-negative number')
  }
  if (!Array.isArray(raw.events)) return fail('events must be an array')
  for (const event of raw.events) {
    if (!event || typeof event !== 'object') return fail('event must be an object')
    if (!EVENT_TYPES.includes(event.type)) return fail(`event type must be one of ${EVENT_TYPES.join('|')}`)
    if ('move' in event && !isMoveNumber(event.move)) return fail('event move must be a positive integer')
    if ('fromMove' in event && !isMoveNumber(event.fromMove)) return fail('event fromMove must be a positive integer')
    if ('evalDelta' in event && !Number.isFinite(event.evalDelta)) return fail('event evalDelta must be a finite number')
    if ('accuracy' in event && (!Number.isFinite(event.accuracy) || event.accuracy < 0 || event.accuracy > 100)) {
      return fail('event accuracy must be 0-100')
    }
    for (const field of ['motif', 'phase', 'material']) {
      if (field in event && !isNonEmptyString(event[field])) return fail(`event ${field} must be a non-empty string`)
    }
  }
  return ok()
}

// validateT1Summary: the client analyzer's output and the §5.1 POST
// /analysis/t1 request body. tier is pinned to "t1" (BR-1.2 — reports built
// from this must carry the "quick look" label, and the server rejects any
// other value at this endpoint with 422).
export function validateT1Summary(raw) {
  if (!raw || typeof raw !== 'object') return fail('t1 summary must be an object')
  if (!isNonEmptyString(raw.gameId)) return fail('gameId is required')
  if (raw.tier !== 't1') return fail('tier must be "t1"')
  const summary = raw.summary
  if (!summary || typeof summary !== 'object') return fail('summary is required')
  if (!Number.isFinite(summary.accuracy) || summary.accuracy < 0 || summary.accuracy > 100) {
    return fail('summary accuracy must be 0-100')
  }
  if (!Array.isArray(summary.blunders) || summary.blunders.some(move => !isMoveNumber(move))) {
    return fail('summary blunders must be an array of positive move numbers')
  }
  if (!Array.isArray(summary.bestMoments)) return fail('summary bestMoments must be an array')
  for (const moment of summary.bestMoments) {
    if (!moment || typeof moment !== 'object') return fail('best moment must be an object')
    if (!isMoveNumber(moment.move)) return fail('best moment move must be a positive integer')
    if (!EVENT_TYPES.includes(moment.kind)) return fail(`best moment kind must be one of ${EVENT_TYPES.join('|')}`)
  }
  if (!Array.isArray(summary.clockCurve) || summary.clockCurve.some(v => !Number.isFinite(v))) {
    return fail('summary clockCurve must be an array of finite numbers')
  }
  return ok()
}

// validateReportPayload: §5.2 GET /report/{gameId} response — what the
// report view renders. Moments are capped at 3 by FR-3 ("Moments That
// Mattered (≤3)") and there is exactly one next step, so both are enforced
// here rather than trusted to the renderer.
export function validateReportPayload(raw) {
  if (!raw || typeof raw !== 'object') return fail('report payload must be an object')
  if (!REPORT_MODES.includes(raw.mode)) return fail(`mode must be one of ${REPORT_MODES.join('|')}`)
  if (!TIERS.includes(raw.tier)) return fail(`tier must be one of ${TIERS.join('|')}`)
  if (!raw.headline || typeof raw.headline !== 'object' || !isNonEmptyString(raw.headline.key)) {
    return fail('headline with a copy key is required')
  }
  if (!Array.isArray(raw.moments)) return fail('moments must be an array')
  if (raw.moments.length > 3) return fail('moments is capped at 3')
  for (const moment of raw.moments) {
    if (!moment || typeof moment !== 'object') return fail('moment must be an object')
    if (!isMoveNumber(moment.move)) return fail('moment move must be a positive integer')
    if (!isNonEmptyString(moment.kind)) return fail('moment kind is required')
  }
  if (!Array.isArray(raw.dimensionTicks)) return fail('dimensionTicks must be an array')
  for (const tick of raw.dimensionTicks) {
    if (!tick || typeof tick !== 'object') return fail('dimension tick must be an object')
    if (!DIMENSIONS.includes(tick.dimension)) return fail(`tick dimension must be one of ${DIMENSIONS.join('|')}`)
    if (!Number.isFinite(tick.delta)) return fail('tick delta must be a finite number')
  }
  if (!Array.isArray(raw.recordCandidates)) return fail('recordCandidates must be an array')
  for (const candidate of raw.recordCandidates) {
    if (!candidate || typeof candidate !== 'object') return fail('record candidate must be an object')
    if (!isNonEmptyString(candidate.type)) return fail('record candidate type is required')
  }
  if (!raw.nextStep || typeof raw.nextStep !== 'object' || !isNonEmptyString(raw.nextStep.key)) {
    return fail('exactly one nextStep with a copy key is required')
  }
  return ok()
}

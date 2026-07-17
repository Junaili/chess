// Pure logic for "My Chess Journal": windowing, key-moment selection, goal
// derivation/verification, entry shaping, and the deterministic coach report.
// No DOM, no network, no engine — the engine-dependent grading happens in
// src/journal.js (which feeds this module per-ply grade objects produced by
// main.js's gradeMoveInPosition). Unit-tested by tests/unit/journal-data.test.cjs.
//
// A "grade" here is one player ply as graded by gradeMoveInPosition:
//   { moveIndex, grade, loss, playedNotation, bestNotation,
//     playedScore, bestScore, preScore, matchedBest }
// All scores are centipawns from the PLAYER's perspective.

import { bucketMoveIndexByPhase, stageDisplayLabel } from './match-stats.mjs'

export const JOURNAL_WINDOWS = ['24h', '7d', 'since-last']
export const JOURNAL_ENTRY_CAP = 20
// Only the most recent entries keep their embedded game copies (replay/retry);
// older entries keep text + stats but degrade gracefully.
export const JOURNAL_EMBEDDED_GAME_ENTRY_CAP = 10
export const JOURNAL_GRADE_CACHE_CAP = 50
export const JOURNAL_MAX_NEW_GAMES_PER_RUN = 10
export const PUZZLE_DECK_CAP = 10

// A blunder in analyzeReplayMove terms; kept in sync with the grade strings
// documented in match-stats.mjs.
const BLUNDER_GRADE = 'Better move available'
// An opponent move that swung the eval this much toward the player is
// treated as a blunder we could have punished; a player's own move gaining
// this much is a "swing" moment worth celebrating.
const GIFT_THRESHOLD_CP = 150
// "Took the gift" tolerance — matches the Strong-move band in the grader.
const TOOK_IT_LOSS_CP = 35

// Reflection chips offered to protected child sessions instead of free text.
export const CHILD_REFLECTION_CHIPS = [
  'I hung a piece', 'I missed a capture', 'I found a fork',
  'I castled early', 'I rushed my moves', 'I stayed patient',
  'I attacked the king', 'I protected my pieces',
]

const FIRST_MOVE_NAMES = {
  e2e4: '1. e4', d2d4: '1. d4', g1f3: '1. Nf3', c2c4: '1. c4',
  b2b3: '1. b3', g2g3: '1. g3', f2f4: '1. f4', b1c3: '1. Nc3',
}

// ─── Windowing ───────────────────────────────────────────────────────────────

export function filterMatchesByWindow(matches, window, { now = Date.now(), sinceIso = '' } = {}) {
  const list = (Array.isArray(matches) ? matches : []).filter(m => m?.endedAt)
  let cutoff
  if (window === '7d') cutoff = now - 7 * 86400000
  else if (window === 'since-last' && sinceIso) cutoff = Date.parse(sinceIso)
  else cutoff = now - 86400000 // '24h' and the since-last-with-no-previous fallback
  if (!Number.isFinite(cutoff)) cutoff = now - 86400000
  return list.filter(m => {
    const t = Date.parse(m.endedAt)
    return Number.isFinite(t) && t >= cutoff && t <= now
  })
}

export function describeWindow(window) {
  if (window === '7d') return 'the last 7 days'
  if (window === 'since-last') return 'since your last entry'
  return 'the last 24 hours'
}

// ─── Per-game grading summaries (built from player-ply grades) ───────────────

// summarizeGradedGame turns one game's player-ply grades into the compact,
// cacheable form the journal stores: counts + the handful of "moment"
// candidates worth remembering. `grades` must be ordered by moveIndex and
// contain ONLY the player's plies.
export function summarizeGradedGame(grades, totalMoves) {
  const own = (grades || []).filter(Boolean)
  const summary = {
    movesGraded: own.length,
    strongCount: 0,
    playableCount: 0,
    blunderCount: 0,
    blundersByPhase: { opening: 0, middlegame: 0, endgame: 0 },
  }
  const moments = []
  let prev = null
  for (const g of own) {
    if (g.grade === 'Strong move') summary.strongCount++
    else if (g.grade === 'Playable') summary.playableCount++
    else if (g.grade === BLUNDER_GRADE) {
      summary.blunderCount++
      summary.blundersByPhase[bucketMoveIndexByPhase(g.moveIndex, totalMoves)]++
      moments.push({
        kind: 'mistake',
        ply: g.moveIndex,
        loss: Math.round(g.loss || 0),
        playedNotation: g.playedNotation || '',
        bestNotation: g.bestNotation || '',
        phase: bucketMoveIndexByPhase(g.moveIndex, totalMoves),
      })
    }

    // Opponent-gift detection is free: preScore of this ply minus playedScore
    // of the player's previous ply is exactly what the opponent's intervening
    // move handed over (both numbers are player-perspective evals the grader
    // already computed).
    const gift = prev && typeof g.preScore === 'number' && typeof prev.playedScore === 'number'
      ? g.preScore - prev.playedScore
      : 0
    if (gift >= GIFT_THRESHOLD_CP && g.grade !== 'Forced') {
      const took = g.matchedBest || (g.loss || 0) < TOOK_IT_LOSS_CP
      moments.push({
        kind: took ? 'punished' : 'missed-gift',
        ply: g.moveIndex,
        gain: Math.round(gift),
        loss: Math.round(g.loss || 0),
        playedNotation: g.playedNotation || '',
        bestNotation: g.bestNotation || '',
      })
    } else if (
      g.grade !== 'Forced' &&
      typeof g.playedScore === 'number' && typeof g.preScore === 'number' &&
      g.playedScore - g.preScore >= GIFT_THRESHOLD_CP &&
      (g.loss || 0) < TOOK_IT_LOSS_CP
    ) {
      moments.push({
        kind: 'swing',
        ply: g.moveIndex,
        gain: Math.round(g.playedScore - g.preScore),
        playedNotation: g.playedNotation || '',
      })
    }
    prev = g
  }
  // Keep the cache small: the biggest few of each kind is all an entry uses.
  const byMagnitude = (a, b) => (b.loss || b.gain || 0) - (a.loss || a.gain || 0)
  const capped = [
    ...moments.filter(m => m.kind === 'mistake').sort(byMagnitude).slice(0, 3),
    ...moments.filter(m => m.kind === 'punished' || m.kind === 'swing').sort(byMagnitude).slice(0, 3),
    ...moments.filter(m => m.kind === 'missed-gift').sort(byMagnitude).slice(0, 3),
  ]
  return { summary, moments: capped }
}

// ─── Key-moment selection across a window ────────────────────────────────────

// gradedGames: [{ match, summary, moments }] — match is the history entry.
export function selectKeyMoments(gradedGames) {
  const all = []
  for (const g of gradedGames || []) {
    for (const m of g.moments || []) all.push({ ...m, matchId: g.match.id, opponentName: g.match.opponentName || 'Opponent' })
  }
  const mistakes = all.filter(m => m.kind === 'mistake')
    .sort((a, b) => b.loss - a.loss).slice(0, 3)
  // Celebrations: punishing a blunder outranks a plain swing; dedupe plies
  // that qualify as both (a punish IS usually a swing).
  const seen = new Set()
  const excellent = []
  for (const m of all.filter(m => m.kind === 'punished').sort((a, b) => b.gain - a.gain)) {
    const key = `${m.matchId}:${m.ply}`
    if (!seen.has(key)) { seen.add(key); excellent.push(m) }
  }
  for (const m of all.filter(m => m.kind === 'swing').sort((a, b) => b.gain - a.gain)) {
    const key = `${m.matchId}:${m.ply}`
    if (!seen.has(key)) { seen.add(key); excellent.push(m) }
  }
  return { excellent: excellent.slice(0, 3), mistakes }
}

// ─── Puzzles (report → practice) ─────────────────────────────────────────────

// Personal drills: "find the move you missed" from the window's mistakes, and
// "punish the blunder" from gifts the player did NOT take. Unsolved puzzles
// from the previous deck resurface (lightweight spaced repetition).
export function buildPuzzleDeck(gradedGames, previousDeck = []) {
  const fresh = []
  for (const g of gradedGames || []) {
    for (const m of g.moments || []) {
      if (m.kind === 'mistake') {
        fresh.push({
          id: `${g.match.id}:${m.ply}`,
          matchId: g.match.id,
          ply: m.ply,
          kind: 'missed',
          playedNotation: m.playedNotation,
          bestNotation: m.bestNotation,
          opponentName: g.match.opponentName || 'Opponent',
          solved: false,
          attempts: 0,
        })
      } else if (m.kind === 'missed-gift') {
        fresh.push({
          id: `${g.match.id}:${m.ply}`,
          matchId: g.match.id,
          ply: m.ply,
          kind: 'punish',
          playedNotation: m.playedNotation,
          bestNotation: m.bestNotation,
          opponentName: g.match.opponentName || 'Opponent',
          solved: false,
          attempts: 0,
        })
      }
    }
  }
  const carryOver = (previousDeck || []).filter(p => p && !p.solved)
  const byId = new Map()
  for (const p of [...carryOver, ...fresh]) if (!byId.has(p.id)) byId.set(p.id, p)
  return [...byId.values()].slice(0, PUZZLE_DECK_CAP)
}

// findEmbeddedGame: resolve a puzzle/moment's playable game across ALL
// retained entries, newest to oldest — not just the entry that currently
// owns the puzzle object. A carried-over puzzle's matchId is often only
// embedded in an older entry once newer windows no longer include that
// match (dev-plan §8.3, correctness gap #3).
export function findEmbeddedGame(entries, matchId) {
  if (!matchId) return null
  for (const entry of entries || []) {
    const g = entry?.games?.[matchId]
    if (g && Array.isArray(g.moves) && g.moves.length) return g
  }
  return null
}

// ─── Goals (behavioral, auto-verified) ───────────────────────────────────────

function castledByMove(match, byMove = 10) {
  if (!Array.isArray(match.moves) || (match.myColor !== 'white' && match.myColor !== 'black')) return null
  const homeRow = match.myColor === 'white' ? 7 : 0
  const startPly = match.myColor === 'white' ? 0 : 1
  for (let i = startPly; i < Math.min(match.moves.length, byMove * 2); i += 2) {
    const m = match.moves[i]
    if (m && m.fr === homeRow && m.fc === 4 && m.toR === homeRow && Math.abs(m.toC - 4) === 2) return true
  }
  return false
}

// reachedOwnMoveNumber: true once the match's move list includes the
// player's `moveNumber`th own move (used to tell "didn't castle" apart from
// "game ended before castling was even possible", dev-plan §8.2).
function reachedOwnMoveNumber(match, moveNumber) {
  if (!Array.isArray(match.moves) || (match.myColor !== 'white' && match.myColor !== 'black')) return false
  const startPly = match.myColor === 'white' ? 0 : 1
  return match.moves.length > startPly + (moveNumber - 1) * 2
}

// castleGoalResult: pure { applicable, completed } for the "castle by move
// N" goal (dev-plan §8.2). A game that ends before the player's Nth move is
// excluded rather than counted as a castling failure, so a short miniature
// can never fail this goal just for ending early.
export function castleGoalResult(match, byMove = 10) {
  if (!Array.isArray(match.moves) || (match.myColor !== 'white' && match.myColor !== 'black')) {
    return { applicable: false, completed: false }
  }
  if (castledByMove(match, byMove)) return { applicable: true, completed: true }
  return { applicable: reachedOwnMoveNumber(match, byMove), completed: false }
}

function earlyResignation(match) {
  return match.endReason === 'resignation' && Array.isArray(match.moves) && match.moves.length < 40
}

// deriveGoal proposes exactly ONE goal from the window's evidence, preferring
// behavior goals a kid can act on over outcome goals.
export function deriveGoal(matches, aggregate) {
  const withColor = (matches || []).filter(m => m.myColor === 'white' || m.myColor === 'black')
  // Applicable games only — a game that ended before the player's 10th move
  // never reached the decision point and must not count as a castling miss
  // (dev-plan §8.2, correctness gap #2).
  const castleResults = withColor.map(m => castleGoalResult(m)).filter(r => r.applicable)
  const notCastled = castleResults.filter(r => !r.completed).length
  if (castleResults.length >= 2 && notCastled / castleResults.length > 0.5) {
    return {
      kind: 'castle-early',
      label: 'Castle by move 10 in your next 3 games',
      detail: `You castled early in only ${castleResults.length - notCastled} of ${castleResults.length} applicable games — a safe king survives longer.`,
    }
  }
  const earlyResigns = (matches || []).filter(earlyResignation).length
  if (earlyResigns >= 2) {
    return {
      kind: 'no-early-resign',
      label: 'Play your games out — no resigning before move 20',
      detail: 'Lost positions are where comebacks (and stalemate saves) come from.',
    }
  }
  if (aggregate?.weakestPhase && aggregate.blunderCount > 0) {
    return {
      kind: 'phase-blunders',
      phase: aggregate.weakestPhase,
      label: `Cut down your ${stageDisplayLabel(aggregate.weakestPhase)} mistakes`,
      detail: `Most of your lost advantage this window came in the ${stageDisplayLabel(aggregate.weakestPhase)}. Slow down there — check captures and checks before you move.`,
    }
  }
  return {
    kind: 'blunder-rate',
    label: 'Keep your blunder rate falling',
    detail: 'Before each move, ask: what does this hang? What did their last move threaten?',
  }
}

// verifyGoal checks the PREVIOUS entry's goal against the NEW window.
// Returns { achieved: true|false|null, detail } — null means not enough data.
export function verifyGoal(goal, matches, aggregate, previousAggregate) {
  if (!goal || !goal.kind) return null
  const withColor = (matches || []).filter(m => m.myColor === 'white' || m.myColor === 'black')
  switch (goal.kind) {
    case 'castle-early': {
      // Target is three APPLICABLE games (dev-plan §8.2) — resolve only once
      // three games actually reached the decision point; short games that
      // ended before move 10 are excluded and never advance or fail this goal.
      const CASTLE_GOAL_TARGET = 3
      const results = withColor.map(m => castleGoalResult(m)).filter(r => r.applicable).slice(0, CASTLE_GOAL_TARGET)
      if (!results.length) return { achieved: null, detail: 'No new applicable games to check yet.' }
      const done = results.filter(r => r.completed).length
      if (results.length < CASTLE_GOAL_TARGET) {
        return {
          achieved: null,
          detail: `Castled early in ${done} of ${results.length} applicable game${results.length === 1 ? '' : 's'} so far — ${CASTLE_GOAL_TARGET} needed.`,
        }
      }
      return {
        achieved: done === CASTLE_GOAL_TARGET,
        detail: `Castled early in ${done} of ${CASTLE_GOAL_TARGET} applicable games.`,
      }
    }
    case 'no-early-resign': {
      if (!matches?.length) return { achieved: null, detail: 'No new games to check yet.' }
      const early = matches.filter(earlyResignation).length
      return {
        achieved: early === 0,
        detail: early === 0 ? 'No early resignations — every game played out.' : `${early} game${early === 1 ? '' : 's'} still ended in an early resignation.`,
      }
    }
    case 'phase-blunders': {
      if (!aggregate || !previousAggregate || !aggregate.movesGraded || !previousAggregate.movesGraded) {
        return { achieved: null, detail: 'Not enough graded games to compare yet.' }
      }
      const rate = agg => (agg.blundersByPhase?.[goal.phase] || 0) / agg.movesGraded
      const before = rate(previousAggregate)
      const after = rate(aggregate)
      return {
        achieved: after < before,
        detail: `${stageDisplayLabel(goal.phase)} blunder rate: ${Math.round(before * 100)}% → ${Math.round(after * 100)}% of your moves.`,
      }
    }
    case 'blunder-rate': {
      if (!aggregate || !previousAggregate || !aggregate.movesGraded || !previousAggregate.movesGraded) {
        return { achieved: null, detail: 'Not enough graded games to compare yet.' }
      }
      const before = previousAggregate.blunderCount / previousAggregate.movesGraded
      const after = aggregate.blunderCount / aggregate.movesGraded
      return {
        achieved: after <= before,
        detail: `Blunder rate: ${Math.round(before * 100)}% → ${Math.round(after * 100)}% of your moves.`,
      }
    }
    default:
      return null
  }
}

// ─── Goals v2 — chosen goals with idempotent, honest progress (dev-plan §13) ─
// Replaces the auto-judged single-goal system above (deriveGoal/verifyGoal
// stay fully intact for VITE_LEARNING_GOALS_V2=false / legacy entries — no
// migration, no shared state between the two systems).

const GOAL_V2_MODEL_VERSION = 'goal-v2'
const GOAL_V2_MATCH_TARGET = 3
const GOAL_V2_PRACTICE_TARGET = 5

function makeGoalCandidate({ kind, label, detail, target }) {
  return {
    kind, label, detail, target,
    status: 'suggested',
    applicable: 0,
    completed: 0,
    selectedAt: '',
    completedAt: '',
    modelVersion: GOAL_V2_MODEL_VERSION,
    evidenceIds: [],
  }
}

// deriveGoalCandidates: at most 3, in priority order (dev-plan §13.1). The
// last candidate (review-next-games) is a pure fallback that always
// qualifies, so the pool is never empty. review-games/practice-positions are
// only offered when their own milestone flags are on (dev-plan §13.5).
export function deriveGoalCandidates({ matches, reviewSupport = false, practiceSupport = false } = {}) {
  const withColor = (matches || []).filter(m => m.myColor === 'white' || m.myColor === 'black')
  const pool = []

  const castleApplicable = withColor.map(m => castleGoalResult(m)).filter(r => r.applicable)
  if (castleApplicable.length >= 2) {
    pool.push(makeGoalCandidate({
      kind: 'castle-early',
      label: `Castle by move 10 in ${GOAL_V2_MATCH_TARGET} applicable games`,
      detail: 'A safe king survives longer — castle before move 10.',
      target: GOAL_V2_MATCH_TARGET,
    }))
  }

  const earlyResigns = (matches || []).filter(earlyResignation).length
  if (earlyResigns >= 2) {
    pool.push(makeGoalCandidate({
      kind: 'no-early-resign',
      label: 'Play your games out — no resigning before move 20',
      detail: 'Lost positions are where comebacks (and stalemate saves) come from.',
      target: GOAL_V2_MATCH_TARGET,
    }))
  }

  if (reviewSupport) {
    pool.push(makeGoalCandidate({
      kind: 'review-games',
      label: `Review your next ${GOAL_V2_MATCH_TARGET} games`,
      detail: 'A Quick Review after each game turns a loss into a lesson.',
      target: GOAL_V2_MATCH_TARGET,
    }))
  }

  if (practiceSupport) {
    pool.push(makeGoalCandidate({
      kind: 'practice-positions',
      label: `Practice ${GOAL_V2_PRACTICE_TARGET} positions from your queue`,
      detail: 'Solving a puzzle more than once is how it sticks.',
      target: GOAL_V2_PRACTICE_TARGET,
    }))
  }

  pool.push(makeGoalCandidate({
    kind: 'review-next-games',
    label: `Review your next ${GOAL_V2_MATCH_TARGET} finished games`,
    detail: 'Look back at how each game went — result, key moment, one takeaway.',
    target: GOAL_V2_MATCH_TARGET,
  }))

  return pool.slice(0, 3)
}

// selectGoal: the player's explicit choice (dev-plan §13.2) — a suggested
// candidate becomes the active goal. Never called automatically.
export function selectGoal(candidate, now = new Date()) {
  return { ...candidate, status: 'active', selectedAt: now.toISOString() }
}

// replaceActiveGoal: marks a still-active goal 'replaced' rather than
// deleting it, preserving history (dev-plan §13.2).
export function replaceActiveGoal(goal) {
  if (!goal || goal.status !== 'active') return goal
  return { ...goal, status: 'replaced' }
}

// matchEvidenceForGoal: [{ id, applicable, completed }] derived purely from
// a window of matches, for the goal kinds that only need match data. Games
// that never reach the decision point are excluded (dev-plan §13.3 "Games
// that do not reach the relevant decision point are excluded").
export function matchEvidenceForGoal(kind, matches) {
  const withColor = (matches || []).filter(m => m.myColor === 'white' || m.myColor === 'black')
  if (kind === 'castle-early') {
    return withColor.map(m => {
      const r = castleGoalResult(m)
      return { id: m.id, applicable: r.applicable, completed: r.completed }
    })
  }
  if (kind === 'no-early-resign') {
    return withColor
      .filter(m => Array.isArray(m.moves) && m.moves.length)
      .map(m => ({ id: m.id, applicable: true, completed: !earlyResignation(m) }))
  }
  if (kind === 'review-next-games') {
    // Fallback goal (dev-plan §13.1 item 5): being covered by a generated
    // Journal entry — the coach report already analyzed it — counts as
    // "reviewed" in the loose sense this weaker fallback promises. The
    // richer review-games candidate (real Quick Review completion) is
    // offered instead whenever the M4 flag makes that possible.
    return withColor
      .filter(m => Array.isArray(m.moves) && m.moves.length)
      .map(m => ({ id: m.id, applicable: true, completed: true }))
  }
  return []
}

// applyGoalEvidence: the single idempotent progress-update path (dev-plan
// §13.3) — every trigger (new Journal entry, a finished review, a solved
// practice puzzle) funnels through this. `evidence` is domain-specific
// [{ id, applicable, completed }] the CALLER derives (matches for
// castle-early/no-early-resign/review-next-games; a reviewed matchId for
// review-games; a solved puzzleId for practice-positions) — this function
// only knows how to dedupe by id and accumulate, never how applicability
// itself is decided. A no-op for anything but an active goal.
export function applyGoalEvidence(goal, evidence, now = new Date()) {
  if (!goal || goal.status !== 'active') return goal
  const seen = new Set(goal.evidenceIds || [])
  const nextIds = [...seen]
  let applicable = goal.applicable || 0
  let completed = goal.completed || 0
  for (const item of evidence || []) {
    if (!item?.id || seen.has(item.id) || !item.applicable) continue
    seen.add(item.id)
    nextIds.push(item.id)
    applicable++
    if (item.completed) completed++
  }
  const target = goal.target || GOAL_V2_MATCH_TARGET
  const achieved = completed >= target
  return {
    ...goal,
    applicable,
    completed,
    evidenceIds: nextIds,
    status: achieved ? 'achieved' : 'active',
    completedAt: achieved ? now.toISOString() : (goal.completedAt || ''),
  }
}

// goalResolutionState: the DISPLAY-level state the copy in dev-plan §13.4
// keys off. 'stalled' — the target number of applicable games was reached
// without full success — is a UI determination, not a stored status; the
// goal stays 'active' underneath so "Keep goal" can resume it seamlessly.
export function goalResolutionState(goal) {
  if (!goal) return null
  if (goal.status === 'achieved' || goal.status === 'replaced') return goal.status
  if (goal.status === 'active' && (goal.applicable || 0) >= (goal.target || GOAL_V2_MATCH_TARGET)) return 'stalled'
  return goal.status
}

// normalizeGoalForDisplay: legacy goals (pre-Goal v2, built by the old
// deriveGoal above) have no `status` field at all — dev-plan §6.5: "Missing
// status on legacy goals normalizes to active for display compatibility."
export function normalizeGoalForDisplay(goal) {
  if (!goal) return null
  if (goal.status) return goal
  return { ...goal, status: 'active' }
}

// ─── Aggregation, trend, opening signal ──────────────────────────────────────

export function aggregateSummaries(gradedGames) {
  const agg = {
    gamesAnalyzed: (gradedGames || []).length,
    movesGraded: 0,
    strongCount: 0,
    playableCount: 0,
    blunderCount: 0,
    blundersByPhase: { opening: 0, middlegame: 0, endgame: 0 },
    strongRate: null,
    blunderRate: null,
    weakestPhase: null,
  }
  for (const g of gradedGames || []) {
    const s = g.summary
    agg.movesGraded += s.movesGraded
    agg.strongCount += s.strongCount
    agg.playableCount += s.playableCount
    agg.blunderCount += s.blunderCount
    for (const phase of ['opening', 'middlegame', 'endgame']) agg.blundersByPhase[phase] += s.blundersByPhase[phase]
  }
  if (agg.movesGraded > 0) {
    agg.strongRate = agg.strongCount / agg.movesGraded
    agg.blunderRate = agg.blunderCount / agg.movesGraded
  }
  if (agg.blunderCount > 0) {
    agg.weakestPhase = ['opening', 'middlegame', 'endgame'].reduce((worst, phase) =>
      agg.blundersByPhase[phase] > agg.blundersByPhase[worst] ? phase : worst, 'opening')
  }
  return agg
}

// Trends compare RATES, never counts — windows differ in size. windowMismatch
// flags when the two entries covered different window kinds, so the UI can
// say "compared with your last 7-day entry".
export function computeTrend(aggregate, previousEntry, window) {
  if (!previousEntry?.accuracy || previousEntry.accuracy.strongRate == null || aggregate.strongRate == null) return null
  return {
    prevEntryId: previousEntry.id,
    strongRateDelta: aggregate.strongRate - previousEntry.accuracy.strongRate,
    blunderRateDelta: (aggregate.blunderRate || 0) - (previousEntry.accuracy.blunderRate || 0),
    windowMismatch: !!previousEntry.window && !!window && previousEntry.window !== window,
  }
}

// One line, only when there's a real signal (≥3 games with one first move and
// a lopsided score) — the full repertoire already lives on the profile.
export function openingSignal(matches) {
  const counts = new Map()
  for (const m of matches || []) {
    if ((m.myColor !== 'white' && m.myColor !== 'black') || !Array.isArray(m.moves)) continue
    const first = m.moves[m.myColor === 'white' ? 0 : 1]
    if (!first) continue
    const key = 'abcdefgh'[first.fc] + (8 - first.fr) + 'abcdefgh'[first.toC] + (8 - first.toR)
    const entry = counts.get(key) || { key, games: 0, wins: 0, losses: 0 }
    entry.games++
    if (m.result === 'win') entry.wins++
    else if (m.result === 'loss') entry.losses++
    counts.set(key, entry)
  }
  for (const entry of counts.values()) {
    if (entry.games < 3) continue
    const name = FIRST_MOVE_NAMES[entry.key] || entry.key
    if (entry.losses === entry.games) return `You went 0–${entry.losses} with ${name} this window — worth trying a different first move.`
    if (entry.wins === entry.games) return `${name} is working for you: ${entry.wins}–0 this window.`
  }
  return ''
}

// ─── Coach report (deterministic; kid-friendly: celebrate first) ─────────────

function pawns(cp) {
  const p = Math.abs(cp) / 100
  return p < 1 ? `${p.toFixed(1)} pawn` : `${p.toFixed(1)} pawns`
}

export function buildCoachReport({ record, aggregate, keyMoments, goal, openingLine }) {
  const total = record.wins + record.losses + record.draws
  const headline = !total
    ? 'No finished games in this window yet.'
    : aggregate.blunderCount === 0 && aggregate.movesGraded > 0
      ? `No serious mistakes across ${aggregate.gamesAnalyzed} game${aggregate.gamesAnalyzed === 1 ? '' : 's'} — great focus.`
      : `${record.wins}W–${record.losses}L–${record.draws}D, with ${aggregate.blunderCount} move${aggregate.blunderCount === 1 ? '' : 's'} that gave away real advantage.`

  // Mate-scale evals (±100000cp) would read as "998.7 pawns" — phrase them
  // as what they are instead.
  const best = keyMoments?.excellent?.[0]
  const bestMomentText = best
    ? best.kind === 'punished'
      ? `Your best moment: ${best.playedNotation} — your opponent slipped, and you spotted it and punished it. That's real chess vision.`
      : best.gain >= 5000
        ? `Your best moment: ${best.playedNotation} — you found the finishing blow. Well seen.`
        : `Your best moment: ${best.playedNotation} — a move that swung the game by about ${pawns(best.gain)}. Well seen.`
    : aggregate.movesGraded > 0
      ? 'Solid, steady play this window — no single flashy moment, and that\'s fine.'
      : ''

  const worst = keyMoments?.mistakes?.[0]
  const lessonText = worst
    ? worst.loss >= 5000
      ? `Biggest lesson: ${worst.playedNotation} vs ${worst.opponentName} threw away the game — the engine suggests ${worst.bestNotation} instead. Replay it and see why.`
      : `Biggest lesson: ${worst.playedNotation} vs ${worst.opponentName} gave up about ${pawns(worst.loss)} — the engine suggests ${worst.bestNotation} was stronger. (Engine suggestions at this depth are a guide, not gospel — replay it and see what you think.)`
    : ''

  return {
    headline,
    bestMomentText,
    lessonText,
    openingLine: openingLine || '',
    goalProposalText: goal ? `${goal.label}. ${goal.detail}` : '',
  }
}

// buildCoachReportRequest shapes an entry into the PII-free payload for the
// Extend /coach/report endpoint (Coach Gus's optional narrative). By
// construction it carries aggregates and SAN strings only — no display
// names, no user ids, no reflections. The server re-validates everything,
// but the privacy line is drawn here first: nothing identifying ever leaves
// the client. (Child sessions never call the endpoint at all — see
// journal.js.)
export function buildCoachReportRequest(entry) {
  const acc = entry.accuracy || {}
  const round1 = cp => Math.round(Math.abs(cp || 0) / 10) / 10 // centipawns → pawns, 1dp
  const verdict = entry.previousGoalVerdict
  return {
    window: entry.window || '24h',
    record: {
      wins: entry.record?.wins || 0,
      losses: entry.record?.losses || 0,
      draws: entry.record?.draws || 0,
    },
    accuracy: {
      movesGraded: acc.movesGraded || 0,
      strongRate: acc.strongRate || 0,
      blunderCount: acc.blunderCount || 0,
      weakestPhase: acc.weakestPhase || '',
    },
    bestMoments: (entry.keyMoments?.excellent || []).slice(0, 3).map(m => ({
      kind: m.kind === 'punished' ? 'punished' : 'swing',
      san: m.playedNotation || '',
      gainPawns: round1(m.gain),
    })),
    mistakes: (entry.keyMoments?.mistakes || []).slice(0, 3).map(m => ({
      san: m.playedNotation || '',
      bestSan: m.bestNotation || '',
      lossPawns: round1(m.loss),
      phase: m.phase || '',
    })),
    goal: entry.goal?.label || '',
    previousGoal: verdict?.goal
      ? { label: verdict.goal.label || '', achieved: verdict.achieved ?? null, detail: verdict.detail || '' }
      : null,
  }
}

// ─── Entry + record shaping ──────────────────────────────────────────────────

export function buildJournalEntry({
  window, now = Date.now(), matches, gradedGames, previousEntry, keyMoments, puzzles, goal, previousGoalVerdict,
}) {
  const record = { wins: 0, losses: 0, draws: 0 }
  for (const m of matches || []) {
    if (m.result === 'win') record.wins++
    else if (m.result === 'loss') record.losses++
    else if (m.result === 'draw') record.draws++
  }
  const aggregate = aggregateSummaries(gradedGames)
  const openingLine = openingSignal(matches)
  const coach = buildCoachReport({ record, aggregate, keyMoments, goal, openingLine })

  // Embed a compact copy of every game a key moment or puzzle references —
  // match history prunes at 50 games, and replay/retry must outlive that.
  const referenced = new Set([
    ...(keyMoments?.excellent || []).map(m => m.matchId),
    ...(keyMoments?.mistakes || []).map(m => m.matchId),
    ...(puzzles || []).map(p => p.matchId),
  ])
  const games = {}
  for (const m of matches || []) {
    if (!referenced.has(m.id)) continue
    games[m.id] = {
      moves: m.moves,
      myColor: m.myColor,
      result: m.result,
      opponentName: m.opponentName || 'Opponent',
      whiteName: m.whiteName || 'White',
      blackName: m.blackName || 'Black',
      startedAt: m.startedAt || '',
      endedAt: m.endedAt || '',
    }
  }

  return {
    id: `journal-${now}`,
    createdAt: new Date(now).toISOString(),
    window,
    gamesInWindow: (matches || []).length,
    gamesAnalyzed: aggregate.gamesAnalyzed,
    record,
    accuracy: {
      movesGraded: aggregate.movesGraded,
      strongCount: aggregate.strongCount,
      strongRate: aggregate.strongRate,
      blunderCount: aggregate.blunderCount,
      blunderRate: aggregate.blunderRate,
      blundersByPhase: aggregate.blundersByPhase,
      weakestPhase: aggregate.weakestPhase,
    },
    trend: computeTrend(aggregate, previousEntry, window),
    keyMoments: keyMoments || { excellent: [], mistakes: [] },
    puzzles: puzzles || [],
    games,
    coach,
    goal: goal || null,
    previousGoalVerdict: previousGoalVerdict || null,
    reflection: { didWell: '', tryNext: '', chips: [] },
  }
}

export function normalizeJournalRecord(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    entries: Array.isArray(value.entries) ? value.entries.filter(e => e && e.id) : [],
    gradeCache: value.gradeCache && typeof value.gradeCache === 'object' ? value.gradeCache : {},
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

// buildJournalRecordValue produces exactly what gets written to CloudSave.
// The journal is PRIVATE: is_public must be false, and this writer must never
// be shared with the public match-history writer (unit-tested).
export function buildJournalRecordValue(record) {
  const entries = (record.entries || []).slice(0, JOURNAL_ENTRY_CAP).map((entry, index) =>
    index < JOURNAL_EMBEDDED_GAME_ENTRY_CAP ? entry : { ...entry, games: {}, puzzles: [] })

  // Prune the grade cache to the most recently graded games.
  const cacheEntries = Object.entries(record.gradeCache || {})
    .sort((a, b) => (b[1]?.gradedAt || 0) - (a[1]?.gradedAt || 0))
    .slice(0, JOURNAL_GRADE_CACHE_CAP)

  return {
    __META: { is_public: false },
    entries,
    gradeCache: Object.fromEntries(cacheEntries),
    updatedAt: new Date().toISOString(),
  }
}

// ─── Process badges (deterministic detectors) ────────────────────────────────

// Returns achievement codes earned by this generation run. Codes must exist in
// the AGS Admin Portal (Achievements) before they unlock for real; unlock
// calls no-op gracefully until then.
export function detectProcessBadges({ gradedGames, matches, journalRecord }) {
  const codes = []
  if ((gradedGames || []).some(g => g.summary.movesGraded >= 10 && g.summary.blunderCount === 0)) {
    codes.push('chess-clean-game')
  }
  const withColor = (matches || []).filter(m => m.myColor === 'white' || m.myColor === 'black')
  if (withColor.length >= 5) {
    const lastFive = withColor.slice(0, 5)
    if (lastFive.every(m => castledByMove(m, 15))) codes.push('chess-castle-crew')
  }
  const solved = (journalRecord?.entries || [])
    .flatMap(e => e.puzzles || [])
    .filter(p => p.solved).length
  if (solved >= 10) codes.push('chess-blunder-buster')
  return codes
}

// ─── Journal hierarchy — next action (dev-plan §14.1) ────────────────────────

// deriveNextAction: the single highest-priority thing worth doing, covering
// priorities 1 (due practice), 3 (active goal), 4 (recap new matches), and 5
// (calm empty state). Priority 2 ("ready review from the learning index")
// needs an async cross-module CloudSave fetch the caller (journal.js) layers
// on top separately — this stays pure and synchronous so it's fully testable
// and tolerates missing M5/M6 data on its own (dev-plan §14.1's "each module
// must render independently").
export function deriveNextAction({ dueCount = 0, activeGoal = null, newMatchCount = 0 } = {}) {
  if (dueCount > 0) return { kind: 'practice', dueCount }
  const goal = normalizeGoalForDisplay(activeGoal)
  if (goal?.status === 'active') return { kind: 'goal', goal }
  if (newMatchCount > 0) return { kind: 'recap', count: newMatchCount }
  return { kind: 'empty' }
}

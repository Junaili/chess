// "My Chess Journal" — orchestration and DOM for the player self-improvement
// loop: generate an entry from recent games (default: last 24h), show the
// coach report + key moments, capture the player's own reflection, track one
// goal, and turn mistakes into practice (puzzles / retry-the-moment).
//
// Pure logic lives in journal-data.mjs (unit-tested). Engine grading comes
// from main.js's gradeMoveInPosition via the window.agsGradeMoveInPosition
// seam; this module maintains the running position per game so grading is a
// single pass (no per-ply prefix replays). The journal record is PRIVATE:
// reads use getRecord_ByUserId_ByKey only, and the writer is dedicated —
// never shared with the public match-history writer.
import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'
import { sdk } from './ags-client.js'
import { extendFetch } from './extend-client.js'
import { unlockEventAchievement } from './achievements.js'
import { sendEvent } from './telemetry.js'
import { fetchMatchHistory } from './stats.js'
import { computeMatchStats } from './match-stats.mjs'
import {
  JOURNAL_MAX_NEW_GAMES_PER_RUN, CHILD_REFLECTION_CHIPS,
  filterMatchesByWindow, describeWindow, summarizeGradedGame, selectKeyMoments,
  buildPuzzleDeck, deriveGoal, verifyGoal, aggregateSummaries,
  buildJournalEntry, normalizeJournalRecord, buildJournalRecordValue,
  detectProcessBadges, buildCoachReportRequest, findEmbeddedGame,
  deriveGoalCandidates, selectGoal, replaceActiveGoal, matchEvidenceForGoal,
  applyGoalEvidence, goalResolutionState, normalizeGoalForDisplay, deriveNextAction,
} from './journal-data.mjs'
import { buildPracticeQueue, applyPuzzleAttempt } from './practice-data.mjs'
import { journalVisibleEntries, narrativeHint } from './club-contract.mjs'
import { ChessGame } from '../chess-engine.js'

const JOURNAL_KEY = 'chess-journal'
const GRADED_PLIES_PER_YIELD = 4

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

let state = {
  userId: null,
  isChild: false,
  matchHistory: null,
  record: null,
  window: '24h',
  generating: false,
  clubActive: false,
  journalOpen: null,
  narrativesRemainingToday: null,
}
let generationToken = 0
let activePuzzle = null
// Entry collapsing (dev-plan §14.2) — which non-latest entries the player
// has manually expanded this session. Persists across re-renders within the
// tab so toggling doesn't reset on every save; cleared on logout/profile
// switch like the rest of this module's state.
let expandedEntryIds = new Set()

export function resetJournalState() {
  state = {
    userId: null, isChild: false, matchHistory: null, record: null, window: '24h', generating: false,
    clubActive: false, journalOpen: null, narrativesRemainingToday: null,
  }
  generationToken++
  activePuzzle = null
  expandedEntryIds = new Set()
}

// applyReviewGoalEvidence: a finished review is review-games evidence
// (dev-plan §13.3 "Progress updates when: ...a review is finished"). Called
// from main.js after review.js's finishReview() completes — review mode can
// be entered (from History or game-over) without the Journal tab ever having
// been opened this session, so this does its OWN fetch-modify-save cycle
// rather than assuming `state.record` is already loaded for this user.
export async function applyReviewGoalEvidence(userId, matchId) {
  if (!userId || !matchId || !window.agsLearningFlags?.().goalsV2) return
  try {
    const sameUserLoaded = state.userId === userId && state.record
    const record = sameUserLoaded ? state.record : await fetchJournalRecord(userId)
    const latest = record.entries[0]
    if (!latest?.goal || latest.goal.status !== 'active' || latest.goal.kind !== 'review-games') return
    latest.goal = applyGoalEvidence(latest.goal, [{ id: matchId, applicable: true, completed: true }])
    const saved = await saveJournalRecord(userId, record)
    if (state.userId === userId) {
      state.record = saved
      renderEntries()
    }
  } catch (error) {
    console.warn('[journal] review goal evidence:', error?.message || error)
  }
}

// ─── Private record IO ────────────────────────────────────────────────────────

function cloudSaveApi() {
  const { coreConfig } = sdk.assembly()
  return PublicPlayerRecordApi(sdk, { coreConfig: { ...coreConfig, useSchemaValidation: false } })
}

// Private-record read: getRecord only. Never probe the public getter here —
// the journal must not exist as a public record, so a getPublic-first pattern
// would be a standing leak check against our own invariant.
async function fetchJournalRecord(userId) {
  try {
    const res = await cloudSaveApi().getRecord_ByUserId_ByKey(userId, JOURNAL_KEY)
    return normalizeJournalRecord(res.data?.value)
  } catch (e) {
    if (e?.response?.status !== 404) console.warn('[journal] fetch:', e?.response?.data || e?.message)
    return normalizeJournalRecord(null)
  }
}

async function saveJournalRecord(userId, record) {
  const value = buildJournalRecordValue(record)
  const api = cloudSaveApi()
  try {
    await api.updateRecord_ByUserId_ByKey(userId, JOURNAL_KEY, value)
  } catch (e) {
    if (e?.response?.status !== 404) throw e
    await api.createRecord_ByUserId_ByKey(userId, JOURNAL_KEY, value)
  }
  // Keep memory consistent with what was persisted (entry caps, slimmed
  // embedded games, pruned cache).
  return normalizeJournalRecord(value)
}

// ─── Incremental grading ──────────────────────────────────────────────────────

function engineReady() {
  return typeof window.agsGradeMoveInPosition === 'function'
}

// Grades ONLY the player's plies of one game in a single forward pass over a
// running position, yielding to the UI between chunks of engine work.
async function gradePlayerGame(match, isStale) {
  const running = new ChessGame()
  const playerParity = match.myColor === 'white' ? 0 : 1
  const names = { whiteName: match.whiteName, blackName: match.blackName }
  const grades = []
  for (let i = 0; i < match.moves.length; i++) {
    const m = match.moves[i]
    if (i % 2 === playerParity) {
      const g = await Promise.resolve(window.agsGradeMoveInPosition(running, m, names))
      if (g) grades.push({ moveIndex: i, ...g })
      if (grades.length % GRADED_PLIES_PER_YIELD === 0) {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (isStale()) return null
      }
    }
    if (!running.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen')) break
  }
  return summarizeGradedGame(grades, match.moves.length)
}

// ─── Generation ───────────────────────────────────────────────────────────────

async function generateJournal() {
  if (!state.userId || state.generating) return
  if (!engineReady()) {
    setStatus('The analysis engine has not loaded yet — try again in a moment.')
    return
  }
  const token = ++generationToken
  const isStale = () => token !== generationToken
  state.generating = true
  setGenerating(true)
  try {
    if (!state.matchHistory) {
      setStatus('Loading your games…')
      state.matchHistory = await fetchMatchHistory(state.userId)
      if (isStale()) return
    }
    if (!state.record) {
      state.record = await fetchJournalRecord(state.userId)
      if (isStale()) return
    }

    const lastEntry = state.record.entries[0] || null
    const windowed = filterMatchesByWindow(state.matchHistory, state.window, { sinceIso: lastEntry?.createdAt })
    if (!windowed.length) {
      setStatus(`No finished games in ${describeWindow(state.window)} — play a game, then come reflect!`)
      return
    }
    const analyzable = windowed.filter(m =>
      Array.isArray(m.moves) && m.moves.length && (m.myColor === 'white' || m.myColor === 'black'))

    // Cache-aware grading: games are immutable once ended, so each is graded
    // exactly once per device+record; regeneration only pays for new games.
    const gradedGames = []
    let newlyGraded = 0
    for (const match of analyzable) {
      let cached = state.record.gradeCache[match.id]
      if (!cached) {
        if (newlyGraded >= JOURNAL_MAX_NEW_GAMES_PER_RUN) continue
        newlyGraded++
        setStatus(`Analyzing game ${newlyGraded} of ${Math.min(analyzable.length, JOURNAL_MAX_NEW_GAMES_PER_RUN)}…`)
        const graded = await gradePlayerGame(match, isStale)
        if (isStale()) return
        if (!graded) return
        cached = { ...graded, gradedAt: Date.now() }
        state.record.gradeCache[match.id] = cached
      }
      gradedGames.push({ match, summary: cached.summary, moments: cached.moments || [] })
    }

    const aggregate = aggregateSummaries(gradedGames)
    const keyMoments = selectKeyMoments(gradedGames)
    const puzzles = buildPuzzleDeck(gradedGames, lastEntry?.puzzles)

    // Goals v2 (dev-plan §13): a chosen goal carries forward and accumulates
    // idempotent match evidence; deriveGoal/verifyGoal (legacy, single
    // auto-judged goal) stay completely untouched for the flag-off path —
    // no shared state, no migration.
    const goalsV2 = !!window.agsLearningFlags?.().goalsV2
    let goal, previousGoalVerdict, goalCandidates
    if (goalsV2) {
      const carried = lastEntry?.goal || null
      goal = carried?.status === 'active'
        ? applyGoalEvidence(carried, matchEvidenceForGoal(carried.kind, windowed))
        : carried
      previousGoalVerdict = null
      goalCandidates = (!goal || goal.status !== 'active')
        ? deriveGoalCandidates({
            matches: windowed,
            reviewSupport: !!window.agsLearningFlags?.().indexV1,
            practiceSupport: !!window.agsLearningFlags?.().practiceV2,
          })
        : []
    } else {
      goal = deriveGoal(windowed, aggregate)
      previousGoalVerdict = lastEntry?.goal
        ? { goal: lastEntry.goal, ...(verifyGoal(lastEntry.goal, windowed, aggregate, lastEntry.accuracy) || { achieved: null, detail: '' }) }
        : null
      goalCandidates = []
    }

    const entry = buildJournalEntry({
      window: state.window,
      matches: windowed,
      gradedGames,
      previousEntry: lastEntry,
      keyMoments,
      puzzles,
      // goal-v2: an already-active/resolved goal isn't a fresh "proposal" —
      // suppress the coach report's goalProposalText and render progress
      // separately; only the legacy path uses that copy.
      goal: goalsV2 ? null : goal,
      previousGoalVerdict: goalsV2 ? null : previousGoalVerdict,
    })
    if (goalsV2) {
      entry.goal = goal
      entry.goalCandidates = goalCandidates
    }
    state.record.entries.unshift(entry)

    setStatus('Saving…')
    state.record = await saveJournalRecord(state.userId, state.record)
    if (isStale()) return

    // Process badges: reward the habits that cause improvement. Unlocks no-op
    // gracefully until the codes are provisioned in the AGS Admin Portal.
    const badges = detectProcessBadges({ gradedGames, matches: windowed, journalRecord: state.record })
    if (computeMatchStats(windowed).comebackWins > 0) badges.push('chess-comeback-kid')
    for (const code of new Set(badges)) unlockEventAchievement(state.userId, code)

    sendEvent('journal_generated', {
      window: state.window,
      games_in_window: windowed.length,
      games_analyzed: gradedGames.length,
      blunders: aggregate.blunderCount,
    })
    setStatus('')
    renderEntries()

    // Coach Gus's narrative — optional garnish on the deterministic report,
    // fetched after the entry is already saved and rendered so it is never
    // load-bearing. Child sessions skip it entirely: no child data to an
    // LLM, ever.
    if (!state.isChild) void requestGusNote(entry.id)
  } catch (error) {
    console.warn('[journal] generate:', error?.message || error)
    setStatus('Could not finish this entry — check your connection and try again.')
  } finally {
    if (token === generationToken) {
      state.generating = false
      setGenerating(false)
    }
  }
}

// requestGusNote asks the Extend /coach/report endpoint for a short note in
// Gambit Gus's voice and attaches it to the entry. Every failure mode —
// endpoint not deployed, LLM unconfigured ({"available":false}), network
// error, rate limit — degrades silently: the deterministic coach report is
// the product, this is the garnish.
async function requestGusNote(entryId) {
  try {
    const entry = state.record?.entries.find(e => e.id === entryId)
    if (!entry || entry.coach?.gusNote) return
    // Client-side pre-check so the UI can be honest before ever calling the
    // endpoint — the server (coachReportGate) remains authoritative; this
    // only avoids a silent-looking failed request when we already know the
    // answer (dev-plan §8.5).
    if (!state.clubActive && !narrativeHint({
      hasClub: state.clubActive,
      journalOpen: state.journalOpen,
      narrativesRemainingToday: state.narrativesRemainingToday,
    }).allowed) {
      sendEvent('club_gate_hit', { feature: 'coach_report' })
      return
    }
    const res = await extendFetch('/coach/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCoachReportRequest(entry)),
    })
    if (!res.ok) {
      // 403 here is the Club paywall — count encounters so the gate's
      // conversion impact is measurable before touching pricing.
      if (res.status === 403) sendEvent('club_gate_hit', { feature: 'coach_report' })
      return
    }
    const data = await res.json()
    if (!data?.available || typeof data.note !== 'string' || !data.note.trim()) return
    entry.coach = { ...(entry.coach || {}), gusNote: data.note.trim().slice(0, 900) }
    state.record = await saveJournalRecord(state.userId, state.record)
    renderEntries()
    sendEvent('journal_gus_note_added', {})
  } catch (error) {
    console.warn('[journal] coach note unavailable:', error?.message || error)
  }
}

// ─── Puzzles / retry hand-off ────────────────────────────────────────────────

// Resolves matchId across ALL retained entries, not just `entry` — a
// carried-over puzzle/moment can point at a match whose embedded copy only
// survives in an older entry once newer windows no longer include it
// (dev-plan §8.3). `entry` param kept so call sites didn't need to change.
function embeddedGame(entry, matchId) {
  return findEmbeddedGame(state.record?.entries, matchId)
}

function startPuzzle(entry, puzzle) {
  const game = embeddedGame(entry, puzzle.matchId)
  if (!game || typeof window.startRetryFromPosition !== 'function') return
  activePuzzle = {
    entryId: entry.id,
    puzzleId: puzzle.id,
    originalMove: game.moves[puzzle.ply] || null,
    bestNotation: puzzle.bestNotation || '',
    // Whether this is the FIRST time the puzzle has ever been attempted —
    // the scheduling matrix (dev-plan §12.3) treats a cold solve differently
    // from a solve after a previous wrong attempt.
    firstAttempt: (puzzle.attempts || 0) === 0,
  }
  // app.js calls this after the player's first move in the drill, with a
  // clone of the position before the move — grade it and record the outcome.
  window.agsJournalJudgeMove = (before, move) => judgePuzzleMove(before, move)
  window.startRetryFromPosition(game.moves, puzzle.ply, game.myColor, {
    judge: true,
    label: puzzle.kind === 'punish'
      ? 'Your opponent just made a mistake here. Can you punish it?'
      : `You played ${puzzle.playedNotation} here — find something better.`,
  })
  sendEvent('journal_puzzle_started', { kind: puzzle.kind })
}

async function judgePuzzleMove(before, move) {
  const grade = await Promise.resolve(window.agsGradeMoveInPosition?.(before, move))
  if (!grade) return null
  // A retry must never approve the exact move that created this puzzle. A
  // tightly budgeted search can occasionally pick that capture before it
  // finishes the opponent's refutation; the stored mistake is authoritative.
  const original = activePuzzle?.originalMove
  const repeatedOriginal = !!original
    && original.fr === move.fr && original.fc === move.fc
    && original.toR === move.toR && original.toC === move.toC
    && (original.promType || 'queen') === (move.promType || 'queen')
  const solved = !repeatedOriginal && (grade.matchedBest || (grade.loss || 0) < 35)
  const recommendedNotation = activePuzzle?.bestNotation || grade.bestNotation
  if (activePuzzle && state.record) {
    const entry = state.record.entries.find(e => e.id === activePuzzle.entryId)
    const puzzleIndex = entry?.puzzles?.findIndex(p => p.id === activePuzzle.puzzleId) ?? -1
    if (entry && puzzleIndex >= 0) {
      // Update the puzzle IN ITS OWNING ENTRY, not wherever is currently
      // latest (dev-plan §12.4) — `entry` here is whichever entry startPuzzle
      // was given, which the global queue resolves via sourceEntryId.
      entry.puzzles[puzzleIndex] = applyPuzzleAttempt(entry.puzzles[puzzleIndex], { solved, firstAttempt: activePuzzle.firstAttempt })
      // Goal v2: a solved puzzle is practice-positions evidence (dev-plan
      // §13.3 "Progress updates when: ...practice state changes"). Only the
      // LATEST entry's goal can be active, matching how it's carried forward.
      const latestGoal = state.record.entries[0]?.goal
      if (solved && latestGoal?.status === 'active' && latestGoal.kind === 'practice-positions') {
        state.record.entries[0].goal = applyGoalEvidence(latestGoal, [{ id: activePuzzle.puzzleId, applicable: true, completed: true }])
      }
      saveJournalRecord(state.userId, state.record)
        .then(saved => { state.record = saved; renderPracticeQueue() })
        .catch(e => {
          console.warn('[journal] puzzle save:', e?.message || e)
          // Failure to save must not alter the board result already shown —
          // this only appends a visible note if the hint UI is still up
          // (dev-plan §12.4).
          const hintText = document.getElementById('hint-text')
          if (hintText) hintText.textContent += ' (Progress not saved — try again from the journal.)'
        })
    }
    sendEvent('journal_puzzle_result', { solved })
  }
  activePuzzle = null
  return {
    solved,
    text: solved
      ? `⭐ ${grade.playedNotation} — that's the idea! Keep playing and finish the job.`
      : `Not quite — ${grade.playedNotation} still gives something up. The engine likes ${recommendedNotation}. Play on, or retry from the journal.`,
  }
}

function startRetryMoment(entry, moment) {
  const game = embeddedGame(entry, moment.matchId)
  if (!game || typeof window.startRetryFromPosition !== 'function') return
  window.startRetryFromPosition(game.moves, moment.ply, game.myColor, {
    label: `Take two: you played ${moment.playedNotation} here. What else is there?`,
  })
  sendEvent('journal_retry_started', {})
}

function replayMoment(entry, moment) {
  const game = embeddedGame(entry, moment.matchId)
  if (!game) return
  window.agsReplayMatchData?.(game, 'profile', { startIndex: moment.ply, returnTab: 'journal' })
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function setStatus(text) {
  const el = document.getElementById('journal-status')
  if (el) el.textContent = text
}

function setGenerating(active) {
  const btn = document.getElementById('btn-journal-generate')
  if (btn) {
    btn.disabled = active
    // dev-plan §14.3 copy change, under the layout flag.
    const idleLabel = window.agsLearningFlags?.().journalLayoutV2 ? 'Review recent games' : 'Write a new entry'
    btn.textContent = active ? 'Analyzing…' : idleLabel
  }
}

function formatPct(rate) {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`
}

function pawns(cp) {
  const p = Math.abs(cp || 0) / 100
  return `${p.toFixed(1)}`
}

function entryDate(entry) {
  const d = new Date(entry.createdAt)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function renderTrendLine(entry) {
  const t = entry.trend
  if (!t) return ''
  const strong = Math.round(t.strongRateDelta * 100)
  const blunder = Math.round(t.blunderRateDelta * 100)
  const bits = []
  if (strong) bits.push(`strong moves ${strong > 0 ? '+' : ''}${strong}%`)
  if (blunder) bits.push(`blunders ${blunder > 0 ? '+' : ''}${blunder}%`)
  if (!bits.length) return ''
  const suffix = t.windowMismatch ? ' (different window than last entry)' : ' vs your last entry'
  return `<p class="journal-trend">${esc(bits.join(' · ') + suffix)}</p>`
}

function momentButtons(entry, moment, { retry }) {
  const available = !!embeddedGame(entry, moment.matchId)
  if (!available) return '<span class="journal-moment-gone">game no longer stored</span>'
  return `
    <button class="btn-mini" data-journal-action="replay" data-entry="${esc(entry.id)}" data-match="${esc(moment.matchId)}" data-ply="${moment.ply}">Replay</button>
    ${retry ? `<button class="btn-mini success" data-journal-action="retry" data-entry="${esc(entry.id)}" data-match="${esc(moment.matchId)}" data-ply="${moment.ply}">Try again</button>` : ''}
  `
}

function renderMoment(entry, moment, kindClass, headline, { retry = false } = {}) {
  return `<div class="journal-moment ${kindClass}">
    <div class="journal-moment-main">
      <strong>${esc(headline)}</strong>
      <span>vs ${esc(moment.opponentName || 'Opponent')} · move ${Math.floor(moment.ply / 2) + 1}</span>
    </div>
    <div class="journal-moment-actions">${momentButtons(entry, moment, { retry })}</div>
  </div>`
}

function renderReflectionEditor(entry) {
  const r = entry.reflection || { didWell: '', tryNext: '', chips: [] }
  if (state.isChild) {
    // Child sessions reflect with chips + a short optional line — stored only
    // in this player's private record, never sent anywhere else.
    const chips = CHILD_REFLECTION_CHIPS.map(chip =>
      `<button type="button" class="journal-chip${(r.chips || []).includes(chip) ? ' selected' : ''}" data-journal-chip="${esc(chip)}">${esc(chip)}</button>`).join('')
    return `<div class="journal-reflection" data-entry="${esc(entry.id)}">
      <h4>My reflection <span class="journal-private-note">private — only you see this</span></h4>
      <div class="journal-chips">${chips}</div>
      <input type="text" id="journal-child-note" class="name-input" maxlength="120" placeholder="One more thing about today (optional)" value="${esc(r.didWell)}" />
      <button class="btn-mini success" data-journal-action="save-reflection" data-entry="${esc(entry.id)}">Save reflection</button>
      <span class="journal-save-note" id="journal-save-note"></span>
    </div>`
  }
  return `<div class="journal-reflection" data-entry="${esc(entry.id)}">
    <h4>My reflection <span class="journal-private-note">private — only you see this</span></h4>
    <label>What did you do well?
      <textarea id="journal-did-well" maxlength="500" rows="2">${esc(r.didWell)}</textarea>
    </label>
    <label>What will you try next time?
      <textarea id="journal-try-next" maxlength="500" rows="2">${esc(r.tryNext)}</textarea>
    </label>
    <button class="btn-mini success" data-journal-action="save-reflection" data-entry="${esc(entry.id)}">Save reflection</button>
    <span class="journal-save-note" id="journal-save-note"></span>
  </div>`
}

function renderSavedReflection(entry) {
  const r = entry.reflection || {}
  const parts = []
  if ((r.chips || []).length) parts.push(r.chips.join(' · '))
  if (r.didWell) parts.push(`Did well: ${r.didWell}`)
  if (r.tryNext) parts.push(`Next time: ${r.tryNext}`)
  if (!parts.length) return ''
  return `<p class="journal-saved-reflection">📝 ${esc(parts.join(' — '))}</p>`
}

// ─── Goals v2 (dev-plan §13) ────────────────────────────────────────────────

const GOAL_KIND_COPY = {
  'castle-early': { verb: 'castled by move 10', noun: 'applicable game' },
  'no-early-resign': { verb: 'played it out', noun: 'game' },
  'review-games': { verb: 'reviewed', noun: 'game' },
  'practice-positions': { verb: 'practiced', noun: 'position' },
  'review-next-games': { verb: 'reviewed', noun: 'game' },
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1) }
function pluralizeGoalNoun(noun, count) { return count === 1 ? noun : `${noun}s` }

function goalProgressText(goal) {
  const { verb, noun } = GOAL_KIND_COPY[goal.kind] || { verb: 'made progress', noun: 'item' }
  return `${capitalize(verb)} in ${goal.completed} of ${goal.applicable} ${pluralizeGoalNoun(noun, goal.applicable)}.`
}

function goalAchievedText(goal) {
  const { verb, noun } = GOAL_KIND_COPY[goal.kind] || { verb: 'completed', noun: 'item' }
  return `Goal complete — you ${verb} in all ${goal.target} ${pluralizeGoalNoun(noun, goal.target)}.`
}

function goalStalledText(goal) {
  const { verb, noun } = GOAL_KIND_COPY[goal.kind] || { verb: 'made progress', noun: 'item' }
  return `${capitalize(verb)} in ${goal.completed} of ${goal.applicable}. Keep it active for another ${goal.target}, or choose a different goal.`
}

function renderGoalSectionV1(entry) {
  // Legacy single auto-judged goal — completely unchanged rendering.
  const verdict = entry.previousGoalVerdict
  const verdictHtml = verdict?.goal
    ? `<p class="journal-goal-verdict ${verdict.achieved === true ? 'achieved' : verdict.achieved === false ? 'missed' : ''}">
        Last goal: ${esc(verdict.goal.label)} — ${verdict.achieved === true ? '✓ ' : verdict.achieved === false ? '✗ ' : ''}${esc(verdict.detail || 'not enough data yet')}
      </p>`
    : ''
  const goalHtml = entry.goal ? `<p class="journal-goal">🎯 <strong>Goal:</strong> ${esc(entry.goal.label)} <span>${esc(entry.goal.detail || '')}</span></p>` : ''
  return verdictHtml + goalHtml
}

function renderGoalCandidates(entry, hasActiveGoal) {
  const candidates = entry.goalCandidates || []
  if (!candidates.length) return ''
  // Child UI reuses the same simplified button markup — no separate code
  // path (dev-plan §13.2 "Child UI may use simplified buttons but follows
  // the same state").
  return `<div class="journal-goal-candidates">
    <h4>${hasActiveGoal ? 'Choose a new goal' : 'Suggested goal'}</h4>
    ${candidates.map(c => `<button class="journal-goal-candidate" type="button" data-journal-action="select-goal" data-entry="${esc(entry.id)}" data-goal-kind="${esc(c.kind)}">
      <strong>${esc(c.label)}</strong>
      <span>${esc(c.detail)}</span>
    </button>`).join('')}
  </div>`
}

function renderGoalSectionV2(entry, isLatest) {
  const goal = normalizeGoalForDisplay(entry.goal)
  const state2 = goalResolutionState(goal)
  let goalHtml = ''
  if (goal && state2 === 'active') {
    goalHtml = `<p class="journal-goal">🎯 <strong>Goal:</strong> ${esc(goal.label)} <span>${esc(goalProgressText(goal))}</span></p>`
  } else if (goal && state2 === 'achieved') {
    goalHtml = `<p class="journal-goal-verdict achieved">🎉 ${esc(goalAchievedText(goal))}</p>`
  } else if (goal && state2 === 'stalled') {
    // Avoid a red failure state (dev-plan §13.4) — offer Keep goal / Choose
    // another rather than a pass/fail verdict.
    goalHtml = `<p class="journal-goal-verdict">${esc(goalStalledText(goal))}</p>
      ${isLatest ? `<div class="journal-goal-actions">
        <button class="btn-mini" type="button" data-journal-action="keep-goal" data-entry="${esc(entry.id)}">Keep goal</button>
        <button class="btn-mini" type="button" data-journal-action="choose-another-goal" data-entry="${esc(entry.id)}">Choose another</button>
      </div>` : ''}`
  } else if (goal && state2 === 'replaced') {
    goalHtml = `<p class="journal-goal-verdict">Previous goal: ${esc(goal.label)} <span>(replaced)</span></p>`
  }
  // "Choose a new goal" once ANY goal has ever been picked (whatever its
  // current resolved status — achieved/stalled/replaced); "Suggested goal"
  // only for the very first choice (dev-plan §13.2).
  const candidatesHtml = isLatest ? renderGoalCandidates(entry, !!goal) : ''
  return goalHtml + candidatesHtml
}

function renderGoalSection(entry, isLatest) {
  return window.agsLearningFlags?.().goalsV2
    ? renderGoalSectionV2(entry, isLatest)
    : renderGoalSectionV1(entry)
}

async function persistGoalChange(entry, mutator, eventName, eventPayload = {}) {
  if (!state.record) return
  mutator(entry)
  renderEntries() // optimistic — reflect the choice immediately
  try {
    state.record = await saveJournalRecord(state.userId, state.record)
    sendEvent(eventName, eventPayload)
  } catch (error) {
    console.warn('[journal] goal save:', error?.message || error)
    setStatus('Could not save your goal — try again.')
  }
}

function selectJournalGoal(entry, kind) {
  const candidate = (entry.goalCandidates || []).find(c => c.kind === kind)
  if (!candidate) return
  persistGoalChange(entry, e => { e.goal = selectGoal(candidate); e.goalCandidates = [] }, 'journal_goal_selected', { kind })
}

function keepJournalGoal(entry) {
  if (!entry.goal) return
  const kind = entry.goal.kind
  persistGoalChange(entry, e => {
    e.goal = selectGoal({ ...e.goal, applicable: 0, completed: 0, evidenceIds: [] })
  }, 'journal_goal_kept', { kind })
}

function chooseAnotherJournalGoal(entry) {
  if (!entry.goal) return
  persistGoalChange(entry, e => {
    e.goal = replaceActiveGoal(e.goal)
    e.goalCandidates = deriveGoalCandidates({
      matches: state.matchHistory || [],
      reviewSupport: !!window.agsLearningFlags?.().indexV1,
      practiceSupport: !!window.agsLearningFlags?.().practiceV2,
    })
  }, 'journal_goal_choose_another', {})
}

// collapsedGoalSummary: one compact line for a collapsed entry's goal result
// (dev-plan §14.2 "goal result"). Handles both a goal-v2 object and a legacy
// verdict, and degrades to nothing when there's no goal data at all.
function collapsedGoalSummary(entry) {
  const goal = normalizeGoalForDisplay(entry.goal)
  const isGoalV2Shape = !!goal && Number.isFinite(goal.target) && Number.isFinite(goal.applicable)
  if (isGoalV2Shape) {
    const rstate = goalResolutionState(goal)
    if (rstate === 'achieved') return goalAchievedText(goal)
    if (rstate === 'active' || rstate === 'stalled') return goalProgressText(goal)
    return ''
  }
  const verdict = entry.previousGoalVerdict
  if (verdict?.goal) {
    const mark = verdict.achieved === true ? '✓ ' : verdict.achieved === false ? '✗ ' : ''
    return `${mark}${verdict.detail || ''}`
  }
  return ''
}

// collapsedReflectionExcerpt: a short, private-safe excerpt (dev-plan §14.2
// "reflection excerpt") — never sent anywhere, same as the full text.
function collapsedReflectionExcerpt(entry) {
  const r = entry.reflection || {}
  const text = r.didWell || r.tryNext || (r.chips || [])[0] || ''
  if (!text) return ''
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

// renderCollapsedEntry: date, W-L-D, one headline, goal result, reflection
// excerpt (dev-plan §14.2) — a single expand control reveals the full entry.
// The entry never reached the DOM in its full form, so there's nothing to
// leak into the accessibility tree beyond this summary.
function renderCollapsedEntry(entry) {
  const goalSummary = collapsedGoalSummary(entry)
  const reflectionExcerpt = collapsedReflectionExcerpt(entry)
  return `<article class="journal-entry journal-entry-collapsed">
    <button class="journal-entry-expand-toggle" type="button" data-journal-action="toggle-entry" data-entry="${esc(entry.id)}" aria-expanded="false">
      <span class="journal-entry-collapsed-date">${esc(entryDate(entry))}</span>
      <span class="journal-entry-collapsed-record">${entry.record.wins}W–${entry.record.losses}L–${entry.record.draws}D</span>
      <span class="journal-entry-collapsed-headline">${esc(entry.coach?.headline || '')}</span>
      ${goalSummary ? `<span class="journal-entry-collapsed-goal">🎯 ${esc(goalSummary)}</span>` : ''}
      ${reflectionExcerpt ? `<span class="journal-entry-collapsed-reflection">📝 ${esc(reflectionExcerpt)}</span>` : ''}
      <span class="journal-entry-expand-icon" aria-hidden="true">▸ Expand</span>
    </button>
  </article>`
}

function renderEntry(entry, index, { collapsed = false } = {}) {
  const isLatest = index === 0
  if (collapsed) return renderCollapsedEntry(entry)
  const acc = entry.accuracy || {}
  const excellent = (entry.keyMoments?.excellent || []).map(m => renderMoment(
    entry, m, 'excellent',
    m.kind === 'punished'
      ? `${m.playedNotation} — you punished a mistake (+${pawns(m.gain)} pawns)`
      : m.gain >= 5000
        ? `${m.playedNotation} — the finishing blow`
        : `${m.playedNotation} — a ${pawns(m.gain)}-pawn swing`,
  )).join('')
  const mistakes = (entry.keyMoments?.mistakes || []).map(m => renderMoment(
    entry, m, 'mistake',
    m.loss >= 5000
      ? `${m.playedNotation} threw the game away — try ${m.bestNotation}`
      : `${m.playedNotation} gave up ${pawns(m.loss)} pawns — try ${m.bestNotation}`,
    { retry: true },
  )).join('')

  const unsolved = (entry.puzzles || []).filter(p => !p.solved && embeddedGame(entry, p.matchId))
  const solvedCount = (entry.puzzles || []).filter(p => p.solved).length
  // Global practice queue (dev-plan §12.2) supersedes this per-entry deck —
  // reduce it to a link rather than showing the same puzzles twice. Flag off
  // keeps the original deck exactly as before.
  const practiceV2 = !!window.agsLearningFlags?.().practiceV2
  const puzzles = isLatest && unsolved.length
    ? (practiceV2
        ? `<p class="journal-puzzles-link"><a href="#" data-journal-action="view-practice-queue">View practice queue (${unsolved.length} to go)</a></p>`
        : `<div class="journal-puzzles">
        <h4>Practice deck <span class="journal-puzzle-count">${solvedCount ? `${solvedCount} solved · ` : ''}${unsolved.length} to go</span></h4>
        ${unsolved.map(p => `<button class="journal-puzzle" data-journal-action="puzzle" data-entry="${esc(entry.id)}" data-puzzle="${esc(p.id)}">
          <span class="journal-puzzle-kind">${p.kind === 'punish' ? '⚡ Punish the blunder' : '🔍 Find the better move'}</span>
          <span>vs ${esc(p.opponentName)} · move ${Math.floor(p.ply / 2) + 1}</span>
        </button>`).join('')}
      </div>`)
    : ''

  // Copy changes under the layout flag (dev-plan §14.3) — the raw
  // strong/blunder rates move into an expandable "Analysis details" section
  // instead of leading the header.
  const journalLayoutV2 = !!window.agsLearningFlags?.().journalLayoutV2
  const blunderCount = acc.blunderCount ?? 0
  const movesGraded = acc.movesGraded ?? 0
  const statsHtml = journalLayoutV2
    ? `<details class="journal-entry-stats-details">
        <summary>${blunderCount} decision${blunderCount === 1 ? '' : 's'} to revisit across ${movesGraded} graded move${movesGraded === 1 ? '' : 's'}</summary>
        <div class="journal-entry-stats">
          <span title="Moves matching the engine's idea">Strong ${formatPct(acc.strongRate)}</span>
          <span title="Moves that gave away real advantage">Blunders ${blunderCount}</span>
        </div>
      </details>`
    : `<div class="journal-entry-stats">
        <span title="Moves matching the engine's idea">Strong ${formatPct(acc.strongRate)}</span>
        <span title="Moves that gave away real advantage">Blunders ${blunderCount}</span>
      </div>`
  // A manually-expanded older entry gets a Collapse affordance back
  // (dev-plan §14.2 "Expand button reveals the current full entry markup" —
  // the reverse direction is the same toggle action).
  const collapseToggleHtml = (!isLatest && journalLayoutV2)
    ? `<button class="journal-entry-collapse-toggle" type="button" data-journal-action="toggle-entry" data-entry="${esc(entry.id)}" aria-expanded="true">▾ Collapse</button>`
    : ''

  return `<article class="journal-entry${isLatest ? ' latest' : ''}">
    ${collapseToggleHtml}
    <header>
      <div>
        <strong>${esc(entryDate(entry))}</strong>
        <span>${esc(describeWindow(entry.window))} · ${entry.record.wins}W–${entry.record.losses}L–${entry.record.draws}D · ${entry.gamesAnalyzed} of ${entry.gamesInWindow} game${entry.gamesInWindow === 1 ? '' : 's'} analyzed</span>
      </div>
      ${statsHtml}
    </header>
    ${renderTrendLine(entry)}
    <div class="journal-coach">
      <p class="journal-coach-headline">${esc(entry.coach?.headline || '')}</p>
      ${entry.coach?.bestMomentText ? `<p class="journal-coach-best">🌟 ${esc(entry.coach.bestMomentText)}</p>` : ''}
      ${entry.coach?.lessonText ? `<p class="journal-coach-lesson">📖 ${esc(entry.coach.lessonText)}</p>` : ''}
      ${entry.coach?.openingLine ? `<p class="journal-coach-opening">${esc(entry.coach.openingLine)}</p>` : ''}
      ${entry.coach?.gusNote ? `<p class="journal-coach-gus">♞ <strong>Coach Gus:</strong> “${esc(entry.coach.gusNote)}”</p>` : ''}
    </div>
    ${renderGoalSection(entry, isLatest)}
    ${excellent ? `<div class="journal-moments"><h4>Best moments</h4>${excellent}</div>` : ''}
    ${mistakes ? `<div class="journal-moments"><h4>Lessons</h4>${mistakes}</div>` : ''}
    ${puzzles}
    ${isLatest ? renderReflectionEditor(entry) : renderSavedReflection(entry)}
  </article>`
}

function renderNarrativeBanner() {
  const bannerEl = document.getElementById('journal-narrative-banner')
  if (!bannerEl) return
  if (state.isChild || state.clubActive) {
    bannerEl.style.display = 'none'
    return
  }
  const hint = narrativeHint({
    hasClub: state.clubActive,
    journalOpen: state.journalOpen,
    narrativesRemainingToday: state.narrativesRemainingToday,
  })
  bannerEl.textContent = hint.label
  bannerEl.style.display = ''
}

// ─── Journal hierarchy: next action + active goal (dev-plan §14.1) ──────────
// Both hidden entirely with the flag off; each tolerates missing M4/M5/M6
// data independently (§14.1) — neither ever blocks entry rendering.

let nextActionToken = 0

function bindNextActionButton(container, action) {
  const btn = container.querySelector('[data-journal-action]')
  if (!btn) return
  btn.addEventListener('click', () => {
    const journalAction = btn.dataset.journalAction
    if (journalAction === 'next-action-practice') {
      document.getElementById('journal-practice-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (journalAction === 'next-action-history') {
      window.agsShowProfileTab?.('history')
    } else if (journalAction === 'next-action-generate') {
      generateJournal()
    }
  })
}

function renderNextActionCard(action, lastTakeaway) {
  const takeawayHtml = lastTakeaway
    ? `<p class="journal-next-action-takeaway">Last takeaway: “${esc(lastTakeaway)}”</p>`
    : ''
  let bodyHtml
  if (action.kind === 'practice') {
    bodyHtml = `<p class="journal-next-action-body">Practice due: ${action.dueCount}</p>
      <button class="btn-mini success" type="button" data-journal-action="next-action-practice">Practice now</button>`
  } else if (action.kind === 'review') {
    bodyHtml = `<p class="journal-next-action-body">You have a Quick Review ready.</p>
      <button class="btn-mini success" type="button" data-journal-action="next-action-history">Go to History</button>`
  } else if (action.kind === 'goal') {
    bodyHtml = `<p class="journal-next-action-body">🎯 ${esc(action.goal.label)}</p>`
  } else if (action.kind === 'recap') {
    bodyHtml = `<p class="journal-next-action-body">${action.count} new game${action.count === 1 ? '' : 's'} to look back on.</p>
      <button class="btn-mini success" type="button" data-journal-action="next-action-generate">Review recent games</button>`
  } else {
    bodyHtml = `<p class="journal-next-action-body">You're all caught up. Nice work.</p>`
  }
  return `<div class="journal-next-action-card">${bodyHtml}${takeawayHtml}</div>`
}

// loadReadyReviewAndTakeaway: the ONE piece of next-action data that needs an
// async cross-module CloudSave fetch (dev-plan §14.1 priority 2, plus the
// "Last takeaway" reminder). Never blocks the initial sync render.
async function loadReadyReviewAndTakeaway() {
  if (!window.agsLearningFlags?.().indexV1 || !state.userId) return { readyReview: false, lastTakeaway: '' }
  try {
    const record = await window.agsLoadLearningIndex?.(state.userId)
    const reviews = record?.reviews || []
    const readyReview = reviews.some(r => r.status === 'ready')
    const reviewed = reviews.filter(r => r.status === 'reviewed' && r.takeaway)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    return { readyReview, lastTakeaway: reviewed[0]?.takeaway || '' }
  } catch (error) {
    console.warn('[journal] next-action learning-index fetch:', error?.message || error)
    return { readyReview: false, lastTakeaway: '' }
  }
}

function renderNextAction() {
  const container = document.getElementById('journal-next-action')
  if (!container) return
  if (!window.agsLearningFlags?.().journalLayoutV2 || !state.record) {
    container.style.display = 'none'
    container.innerHTML = ''
    return
  }
  const token = ++nextActionToken
  const practiceV2 = !!window.agsLearningFlags?.().practiceV2
  const dueCount = practiceV2 ? buildPracticeQueue(state.record.entries, { now: new Date() }).dueCount : 0
  const lastEntry = state.record.entries[0] || null
  const newMatches = filterMatchesByWindow(state.matchHistory || [], 'since-last', { sinceIso: lastEntry?.createdAt })
  const syncAction = deriveNextAction({ dueCount, activeGoal: lastEntry?.goal, newMatchCount: newMatches.length })

  container.style.display = ''
  container.innerHTML = renderNextActionCard(syncAction, null)
  bindNextActionButton(container, syncAction)

  loadReadyReviewAndTakeaway().then(({ readyReview, lastTakeaway }) => {
    if (token !== nextActionToken) return // stale — a newer render already happened
    // Ready-review is priority 2 — only promotes over the recap/empty
    // fallback (priorities 4/5), never over due practice or an active goal.
    const action = readyReview && (syncAction.kind === 'recap' || syncAction.kind === 'empty')
      ? { kind: 'review' }
      : syncAction
    container.innerHTML = renderNextActionCard(action, lastTakeaway)
    bindNextActionButton(container, action)
  }).catch(() => {})
}

function renderActiveGoalModule() {
  const container = document.getElementById('journal-active-goal')
  if (!container) return
  const goal = normalizeGoalForDisplay(state.record?.entries[0]?.goal)
  // Guard on the DATA SHAPE, not just the flag — a goal-v2 object can persist
  // even after VITE_LEARNING_GOALS_V2 is toggled off, and a legacy goal
  // (deriveGoal's plain {kind,label,detail}) has no target/applicable to show
  // progress for (dev-plan §14.1 "tolerate missing M6 data").
  const isGoalV2Shape = !!goal && Number.isFinite(goal.target) && Number.isFinite(goal.applicable)
  if (!window.agsLearningFlags?.().journalLayoutV2 || !isGoalV2Shape) {
    container.style.display = 'none'
    container.innerHTML = ''
    return
  }
  const resolutionState = goalResolutionState(goal)
  let text = ''
  if (resolutionState === 'achieved') text = goalAchievedText(goal)
  else if (resolutionState === 'active' || resolutionState === 'stalled') text = `${goal.label} — ${goalProgressText(goal)}`
  if (!text) {
    container.style.display = 'none'
    container.innerHTML = ''
    return
  }
  container.style.display = ''
  container.innerHTML = `<p class="journal-active-goal-summary">🎯 ${esc(text)}</p>`
}

// ─── Global practice queue (dev-plan §12, VITE_LEARNING_PRACTICE_V2) ────────

const PRACTICE_STAGE_LABELS = { new: 'New', learning: 'Learning', review: 'Review' }

function renderPracticeRow(item) {
  const kindLabel = item.kind === 'punish' ? '⚡ Punish the mistake' : '🔍 Find the better move'
  const stageLabel = PRACTICE_STAGE_LABELS[item.stage] || 'New'
  return `<button class="journal-practice-row${item.playable ? '' : ' unplayable'}" type="button"
      data-journal-action="queue-puzzle" data-entry="${esc(item.sourceEntryId)}" data-puzzle="${esc(item.id)}"
      ${item.playable ? '' : 'disabled'}>
    <span class="journal-practice-kind">${kindLabel}</span>
    <span>vs ${esc(item.opponentName)} · move ${Math.floor(item.ply / 2) + 1} · ${stageLabel}</span>
    ${item.playable ? '' : '<span class="journal-practice-unplayable-note">game no longer stored</span>'}
  </button>`
}

function bindPracticeQueueActions(container) {
  container.querySelectorAll('[data-journal-action="queue-puzzle"]').forEach(button => {
    button.addEventListener('click', () => {
      const entry = state.record?.entries.find(e => e.id === button.dataset.entry)
      const puzzle = entry?.puzzles?.find(p => p.id === button.dataset.puzzle)
      if (entry && puzzle) startPuzzle(entry, puzzle)
    })
  })
}

// renderPracticeQueue: flattens puzzles across ALL retained entries (dev-plan
// §12.1-§12.2), independent of which entries are currently visible/locked by
// the Club gate — practice access is never gated, only journal history depth is.
function renderPracticeQueue() {
  const container = document.getElementById('journal-practice-queue')
  if (!container) return
  if (!window.agsLearningFlags?.().practiceV2 || !state.record?.entries?.length) {
    container.style.display = 'none'
    container.innerHTML = ''
    return
  }

  const queue = buildPracticeQueue(state.record.entries, { now: new Date() })
  if (queue.activeCount === 0 && queue.masteredCount === 0) {
    container.style.display = 'none'
    container.innerHTML = ''
    return
  }

  container.style.display = ''
  if (queue.dueCount > 0) {
    const rows = queue.displayed.filter(item => item.dueAt <= new Date().toISOString()).slice(0, 5)
    container.innerHTML = `
      <h4>Practice due: ${queue.dueCount}</h4>
      <div class="journal-practice-rows">${rows.map(renderPracticeRow).join('')}</div>
    `
  } else if (queue.activeCount > 0) {
    const nextDate = queue.nextDueAt
      ? new Date(queue.nextDueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : ''
    container.innerHTML = `<p class="journal-practice-empty">${nextDate ? `Next practice due ${esc(nextDate)}.` : 'Nothing due right now.'} Nice pace.</p>`
  } else {
    container.innerHTML = '<p class="journal-practice-empty">🎉 Every practice item mastered — keep playing to find new ones.</p>'
  }
  bindPracticeQueueActions(container)
}

function renderEntries() {
  const listEl = document.getElementById('journal-entries')
  if (!listEl || !state.record) return
  renderNarrativeBanner()
  renderNextAction()
  renderActiveGoalModule()
  renderPracticeQueue()
  const entries = state.record.entries
  if (!entries.length) {
    listEl.innerHTML = `<div class="profile-history-empty">
      <strong>No journal entries yet</strong>
      <span>Play a game or two, then write your first entry — you'll get a coach report on your best moves and biggest lessons, and a goal to chase.</span>
    </div>`
    return
  }
  // Journal history depth is Club-gated (dev-plan §1.2); writing new entries
  // is never gated. Open Journal Days (§8.5) and child sessions (which never
  // see purchase UI, but DO get the free-tier limit like any other
  // non-Club user) both flow through journalVisibleEntries.
  const { visible, lockedCount, unlimited } = journalVisibleEntries(entries, {
    hasClub: state.clubActive,
    journalOpen: state.journalOpen,
  })
  const lockedCard = !unlimited && lockedCount
    ? `<div class="profile-history-empty profile-history-locked"${state.isChild ? '' : ' data-purchase-ui="1"'}>
        <strong>${lockedCount} more entr${lockedCount === 1 ? 'y' : 'ies'} in your history</strong>
        <span>${state.isChild
          ? 'Ask your parent about Club ♛ to see your full journal history.'
          : 'Club unlocks your complete journal history — ♛ Learn more'}</span>
        ${state.isChild ? '' : '<button type="button" class="btn-mini" data-click="window.agsOpenClub && window.agsOpenClub()">Learn more ♛</button>'}
      </div>`
    : ''
  // Entry collapsing (dev-plan §14.2) — latest always expanded; older
  // entries collapse to a summary unless the player has manually expanded
  // them. journalVisibleEntries() above already excludes locked entries
  // entirely from `visible`, so a locked entry's content never reaches this
  // map — collapsing has nothing extra to guard there.
  const journalLayoutV2 = !!window.agsLearningFlags?.().journalLayoutV2
  listEl.innerHTML = visible.map((entry, i) => {
    const collapsed = journalLayoutV2 && i !== 0 && !expandedEntryIds.has(entry.id)
    return renderEntry(entry, i, { collapsed })
  }).join('') + lockedCard
  bindEntryActions(listEl)
}

function bindEntryActions(listEl) {
  listEl.querySelectorAll('[data-journal-action]').forEach(button => {
    button.addEventListener('click', event => {
      const { journalAction, entry: entryId, match: matchId, ply, puzzle: puzzleId } = button.dataset
      if (journalAction === 'view-practice-queue') {
        event.preventDefault()
        document.getElementById('journal-practice-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      if (journalAction === 'toggle-entry') {
        if (expandedEntryIds.has(entryId)) expandedEntryIds.delete(entryId)
        else expandedEntryIds.add(entryId)
        renderEntries()
        return
      }
      const entry = state.record?.entries.find(e => e.id === entryId)
      if (!entry) return
      if (journalAction === 'replay') replayMoment(entry, { matchId, ply: Number(ply) })
      else if (journalAction === 'retry') {
        const moment = [...(entry.keyMoments?.mistakes || []), ...(entry.keyMoments?.excellent || [])]
          .find(m => m.matchId === matchId && m.ply === Number(ply))
        if (moment) startRetryMoment(entry, moment)
      } else if (journalAction === 'puzzle') {
        const p = entry.puzzles?.find(item => item.id === puzzleId)
        if (p) startPuzzle(entry, p)
      } else if (journalAction === 'save-reflection') saveReflection(entry)
      else if (journalAction === 'select-goal') selectJournalGoal(entry, button.dataset.goalKind)
      else if (journalAction === 'keep-goal') keepJournalGoal(entry)
      else if (journalAction === 'choose-another-goal') chooseAnotherJournalGoal(entry)
    })
  })
  listEl.querySelectorAll('[data-journal-chip]').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('selected'))
  })
}

async function saveReflection(entry) {
  const container = document.querySelector(`.journal-reflection[data-entry="${CSS.escape(entry.id)}"]`)
  if (!container || !state.record) return
  if (state.isChild) {
    entry.reflection = {
      didWell: container.querySelector('#journal-child-note')?.value.trim().slice(0, 120) || '',
      tryNext: '',
      chips: [...container.querySelectorAll('.journal-chip.selected')].map(c => c.dataset.journalChip),
    }
  } else {
    entry.reflection = {
      didWell: container.querySelector('#journal-did-well')?.value.trim().slice(0, 500) || '',
      tryNext: container.querySelector('#journal-try-next')?.value.trim().slice(0, 500) || '',
      chips: [],
    }
  }
  const note = document.getElementById('journal-save-note')
  try {
    state.record = await saveJournalRecord(state.userId, state.record)
    if (note) note.textContent = 'Saved ✓'
    sendEvent('journal_reflection_saved', { chips: entry.reflection.chips.length })
    setTimeout(() => { if (note) note.textContent = '' }, 3000)
  } catch (error) {
    console.warn('[journal] reflection save:', error?.message || error)
    if (note) note.textContent = 'Could not save — try again.'
  }
}

// ─── Entry point (called by main.js when the own profile opens) ──────────────

export async function renderJournalTab(userId, matchHistory, {
  isChildSession = false, clubActive = false, journalOpen = null, narrativesRemainingToday = null,
} = {}) {
  state.userId = userId
  state.isChild = !!isChildSession
  state.clubActive = !!clubActive
  state.journalOpen = journalOpen
  state.narrativesRemainingToday = narrativesRemainingToday
  state.matchHistory = Array.isArray(matchHistory) ? matchHistory : state.matchHistory

  // One-time control wiring (direct listeners — no data-click indirection).
  const generateBtn = document.getElementById('btn-journal-generate')
  if (generateBtn && generateBtn.dataset.journalBound !== '1') {
    generateBtn.dataset.journalBound = '1'
    generateBtn.addEventListener('click', () => generateJournal())
  }
  document.querySelectorAll('[data-journal-window]').forEach(btn => {
    if (btn.dataset.journalBound === '1') return
    btn.dataset.journalBound = '1'
    btn.addEventListener('click', () => {
      state.window = btn.dataset.journalWindow
      document.querySelectorAll('[data-journal-window]').forEach(b => {
        const selected = b.dataset.journalWindow === state.window
        b.classList.toggle('active', selected)
        b.setAttribute('aria-selected', String(selected))
      })
    })
  })

  setStatus('')
  setGenerating(state.generating)
  if (!state.record) {
    const listEl = document.getElementById('journal-entries')
    if (listEl) listEl.innerHTML = '<div class="profile-history-loading"><span></span><span></span><span></span></div>'
    state.record = await fetchJournalRecord(userId)
  }
  renderEntries()
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.agsJournalStateForTesting = () => state
  // Offline e2e seam: drive the tab with fixture history without a real login
  // (CloudSave routes are stubbed at the network layer in the spec).
  window.agsRenderJournalForTesting = (userId, matchHistory, opts) => {
    resetJournalState()
    return renderJournalTab(userId, matchHistory, opts)
  }
}

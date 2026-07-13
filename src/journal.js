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
  detectProcessBadges, buildCoachReportRequest,
} from './journal-data.mjs'

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
}
let generationToken = 0
let activePuzzle = null

export function resetJournalState() {
  state = { userId: null, isChild: false, matchHistory: null, record: null, window: '24h', generating: false }
  generationToken++
  activePuzzle = null
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
  return typeof ChessGame !== 'undefined' && typeof window.agsGradeMoveInPosition === 'function'
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
      const g = window.agsGradeMoveInPosition(running, m, names)
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
    const goal = deriveGoal(windowed, aggregate)
    const previousGoalVerdict = lastEntry?.goal
      ? { goal: lastEntry.goal, ...(verifyGoal(lastEntry.goal, windowed, aggregate, lastEntry.accuracy) || { achieved: null, detail: '' }) }
      : null

    const entry = buildJournalEntry({
      window: state.window,
      matches: windowed,
      gradedGames,
      previousEntry: lastEntry,
      keyMoments,
      puzzles,
      goal,
      previousGoalVerdict,
    })
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

function embeddedGame(entry, matchId) {
  const g = entry.games?.[matchId]
  return g && Array.isArray(g.moves) && g.moves.length ? g : null
}

function startPuzzle(entry, puzzle) {
  const game = embeddedGame(entry, puzzle.matchId)
  if (!game || typeof window.startRetryFromPosition !== 'function') return
  activePuzzle = { entryId: entry.id, puzzleId: puzzle.id }
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

function judgePuzzleMove(before, move) {
  const grade = window.agsGradeMoveInPosition?.(before, move)
  if (!grade) return null
  const solved = grade.matchedBest || (grade.loss || 0) < 35
  if (activePuzzle && state.record) {
    const entry = state.record.entries.find(e => e.id === activePuzzle.entryId)
    const puzzle = entry?.puzzles?.find(p => p.id === activePuzzle.puzzleId)
    if (puzzle) {
      puzzle.attempts = (puzzle.attempts || 0) + 1
      if (solved) puzzle.solved = true
      saveJournalRecord(state.userId, state.record)
        .then(saved => { state.record = saved })
        .catch(e => console.warn('[journal] puzzle save:', e?.message || e))
    }
    sendEvent('journal_puzzle_result', { solved })
  }
  activePuzzle = null
  return {
    solved,
    text: solved
      ? `⭐ ${grade.playedNotation} — that's the idea! Keep playing and finish the job.`
      : `Not quite — ${grade.playedNotation} still gives something up. The engine likes ${grade.bestNotation}. Play on, or retry from the journal.`,
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
    btn.textContent = active ? 'Analyzing…' : 'Write a new entry'
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

function renderEntry(entry, index) {
  const isLatest = index === 0
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
  const puzzles = isLatest && unsolved.length
    ? `<div class="journal-puzzles">
        <h4>Practice deck <span class="journal-puzzle-count">${solvedCount ? `${solvedCount} solved · ` : ''}${unsolved.length} to go</span></h4>
        ${unsolved.map(p => `<button class="journal-puzzle" data-journal-action="puzzle" data-entry="${esc(entry.id)}" data-puzzle="${esc(p.id)}">
          <span class="journal-puzzle-kind">${p.kind === 'punish' ? '⚡ Punish the blunder' : '🔍 Find the better move'}</span>
          <span>vs ${esc(p.opponentName)} · move ${Math.floor(p.ply / 2) + 1}</span>
        </button>`).join('')}
      </div>`
    : ''

  const verdict = entry.previousGoalVerdict
  const verdictHtml = verdict?.goal
    ? `<p class="journal-goal-verdict ${verdict.achieved === true ? 'achieved' : verdict.achieved === false ? 'missed' : ''}">
        Last goal: ${esc(verdict.goal.label)} — ${verdict.achieved === true ? '✓ ' : verdict.achieved === false ? '✗ ' : ''}${esc(verdict.detail || 'not enough data yet')}
      </p>`
    : ''

  return `<article class="journal-entry${isLatest ? ' latest' : ''}">
    <header>
      <div>
        <strong>${esc(entryDate(entry))}</strong>
        <span>${esc(describeWindow(entry.window))} · ${entry.record.wins}W–${entry.record.losses}L–${entry.record.draws}D · ${entry.gamesAnalyzed} of ${entry.gamesInWindow} game${entry.gamesInWindow === 1 ? '' : 's'} analyzed</span>
      </div>
      <div class="journal-entry-stats">
        <span title="Moves matching the engine's idea">Strong ${formatPct(acc.strongRate)}</span>
        <span title="Moves that gave away real advantage">Blunders ${acc.blunderCount ?? 0}</span>
      </div>
    </header>
    ${renderTrendLine(entry)}
    <div class="journal-coach">
      <p class="journal-coach-headline">${esc(entry.coach?.headline || '')}</p>
      ${entry.coach?.bestMomentText ? `<p class="journal-coach-best">🌟 ${esc(entry.coach.bestMomentText)}</p>` : ''}
      ${entry.coach?.lessonText ? `<p class="journal-coach-lesson">📖 ${esc(entry.coach.lessonText)}</p>` : ''}
      ${entry.coach?.openingLine ? `<p class="journal-coach-opening">${esc(entry.coach.openingLine)}</p>` : ''}
      ${entry.coach?.gusNote ? `<p class="journal-coach-gus">♞ <strong>Coach Gus:</strong> “${esc(entry.coach.gusNote)}”</p>` : ''}
    </div>
    ${verdictHtml}
    ${entry.goal ? `<p class="journal-goal">🎯 <strong>Goal:</strong> ${esc(entry.goal.label)} <span>${esc(entry.goal.detail || '')}</span></p>` : ''}
    ${excellent ? `<div class="journal-moments"><h4>Best moments</h4>${excellent}</div>` : ''}
    ${mistakes ? `<div class="journal-moments"><h4>Lessons</h4>${mistakes}</div>` : ''}
    ${puzzles}
    ${isLatest ? renderReflectionEditor(entry) : renderSavedReflection(entry)}
  </article>`
}

function renderEntries() {
  const listEl = document.getElementById('journal-entries')
  if (!listEl || !state.record) return
  const entries = state.record.entries
  if (!entries.length) {
    listEl.innerHTML = `<div class="profile-history-empty">
      <strong>No journal entries yet</strong>
      <span>Play a game or two, then write your first entry — you'll get a coach report on your best moves and biggest lessons, and a goal to chase.</span>
    </div>`
    return
  }
  listEl.innerHTML = entries.map((entry, i) => renderEntry(entry, i)).join('')
  bindEntryActions(listEl)
}

function bindEntryActions(listEl) {
  listEl.querySelectorAll('[data-journal-action]').forEach(button => {
    button.addEventListener('click', () => {
      const { journalAction, entry: entryId, match: matchId, ply, puzzle: puzzleId } = button.dataset
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

export async function renderJournalTab(userId, matchHistory, { isChildSession = false } = {}) {
  state.userId = userId
  state.isChild = !!isChildSession
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

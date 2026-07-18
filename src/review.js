// Review-session orchestration and additive spectator DOM actions for
// "Quick Review" mode (dev-plan §10, §5.4). Lazy-loaded — never pulled into
// the launch bundle. src/main.js continues to own screen changes and board
// rendering; this module owns review-only state, controls, and copy, and
// reaches back into main.js only through the callbacks startReviewSession()
// is given (analyzeMatch/goToPly/startRetry) — never through window globals
// it doesn't control, so it stays independently testable.

import {
  buildReviewLessons, selectFirstReviewPly, buildReviewSummary, reviewLessonLabel,
  suggestedTakeaways, reviewPrimaryTheme,
} from './review-data.mjs'
import { computeMatchFingerprint, trimTakeaway, reviewBadge as computeReviewBadge, ANALYSIS_VERSION } from './learning-contract.mjs'
import { loadLearningIndex as fetchLearningIndex, upsertReview, resetLearningCache } from './learning-store.js'
import { emitLearningStateChanged } from './learning-events.mjs'

// session also carries userId/movesGraded/analyzedAt once analysis
// completes — everything M4's persistence needs (dev-plan §6.2's review shape).
let session = null
let requestToken = 0

function indexV1Enabled() {
  return !!window.agsLearningFlags?.().indexV1
}

const esc = s => (window.escapeHtml || (v => String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')))(s)

function els() {
  return {
    badge: document.getElementById('spectator-review-badge'),
    summary: document.getElementById('spectator-review-summary'),
    progress: document.getElementById('spectator-review-progress'),
    actions: document.getElementById('spectator-review-actions'),
    prevBtn: document.getElementById('spectator-review-prev-lesson'),
    nextBtn: document.getElementById('spectator-review-next-lesson'),
    finishPanel: document.getElementById('spectator-review-finish-panel'),
    chips: document.getElementById('spectator-review-chips'),
    takeawayInput: document.getElementById('spectator-review-takeaway'),
    finishBtn: document.getElementById('spectator-review-finish-btn'),
    saveNote: document.getElementById('spectator-review-save-note'),
  }
}

function setVisible(el, visible) {
  if (el) el.style.display = visible ? '' : 'none'
}

function renderChrome() {
  const { badge, actions } = els()
  setVisible(badge, true)
  setVisible(actions, true)
}

function renderAnalyzing() {
  const { summary, progress } = els()
  if (summary) {
    summary.style.display = ''
    summary.textContent = 'Analyzing your moves…'
  }
  setVisible(progress, false)
}

function renderSummaryAndProgress() {
  if (!session) return
  const { summary, progress, prevBtn, nextBtn } = els()
  if (summary) {
    summary.style.display = ''
    summary.textContent = buildReviewSummary(session)
  }
  const total = session.lessons.length
  if (total > 0) {
    setVisible(progress, true)
    if (progress) progress.textContent = `Lesson ${session.currentLessonIndex + 1} of ${total}: ${reviewLessonLabel(session.lessons[session.currentLessonIndex])}`
    if (prevBtn) prevBtn.disabled = session.currentLessonIndex <= 0
    if (nextBtn) nextBtn.disabled = session.currentLessonIndex >= total - 1
  } else {
    setVisible(progress, false)
  }
}

function renderUnavailable() {
  const { summary, progress } = els()
  if (summary) {
    summary.style.display = ''
    summary.textContent = 'Quick summary unavailable.'
  }
  setVisible(progress, false)
}

// renderFinishPanel: Finish Review UI (dev-plan §11.2) — hidden entirely
// unless the M4 flag is on, independent of whether analysis found a lesson
// (a clean game can still be explicitly finished with a takeaway).
function renderFinishPanel() {
  const { finishPanel, chips, saveNote } = els()
  if (!finishPanel) return
  if (!session || !indexV1Enabled()) {
    setVisible(finishPanel, false)
    return
  }
  setVisible(finishPanel, true)
  if (saveNote) saveNote.textContent = ''
  if (chips) {
    const suggestions = suggestedTakeaways(session.lessons)
    chips.innerHTML = suggestions.map(text =>
      `<button type="button" class="spectator-review-chip" data-takeaway="${esc(text)}">${esc(text)}</button>`
    ).join('')
    chips.querySelectorAll('[data-takeaway]').forEach(btn => {
      btn.addEventListener('click', () => {
        const { takeawayInput } = els()
        if (takeawayInput) takeawayInput.value = btn.dataset.takeaway
      })
    })
  }
}

// startReviewSession: begins a review for `match` (must have myColor/moves).
// Shows the board immediately (the caller has already rendered it before
// calling this — dev-plan §10.6 "show replay immediately while batch
// analysis runs"); this only owns the review-only chrome and kicks off batch
// analysis without blocking anything.
export async function startReviewSession({ userId, match, source, analyzeMatch, goToPly, startRetry, onReviewFinished }) {
  const token = ++requestToken
  session = {
    userId, match, source, goToPly, startRetry, onReviewFinished,
    lessons: [], positiveHighlight: null, currentLessonIndex: 0,
    movesGraded: 0, analyzedAt: '',
  }
  renderChrome()
  renderAnalyzing()

  let grades = null
  try {
    grades = await analyzeMatch(match, { scope: 'player' })
  } catch (error) {
    console.warn('[review] batch analysis unavailable:', error?.message || error)
  }
  // Race guard (dev-plan §10.6): ignore a stale response if another review
  // started, or resetReviewSession() ran, while analysis was in flight.
  if (token !== requestToken || !session) return

  if (!Array.isArray(grades)) {
    renderUnavailable()
    return
  }

  const { lessons, positiveHighlight } = buildReviewLessons(grades, match.moves.length)
  session.lessons = lessons
  session.positiveHighlight = positiveHighlight
  session.currentLessonIndex = 0
  session.movesGraded = grades.length
  session.analyzedAt = new Date().toISOString()
  renderSummaryAndProgress()
  renderFinishPanel()
  goToPly(selectFirstReviewPly(lessons, match.moves.length))

  // Auto-persist a 'ready' summary once there's something worth remembering
  // (dev-plan §11.2) — never for a clean game (that only becomes 'reviewed'
  // if the player explicitly finishes) and never without the M4 flag or a
  // signed-in userId. Best-effort: the review UI never blocks on this save.
  if (lessons.length && userId && indexV1Enabled()) {
    upsertReadySummary().catch(error => console.warn('[review] ready-summary save failed:', error?.message || error))
  }
}

async function upsertReadySummary() {
  if (!session) return
  const now = new Date().toISOString()
  await upsertReview(session.userId, {
    matchId: session.match.id,
    matchFingerprint: computeMatchFingerprint(session.match.moves),
    status: 'ready',
    analysisVersion: ANALYSIS_VERSION,
    analyzedAt: session.analyzedAt,
    completedAt: '',
    updatedAt: now,
    movesGraded: session.movesGraded,
    lessonCount: session.lessons.length,
    positiveCount: session.positiveHighlight ? 1 : 0,
    firstLessonPly: session.lessons[0]?.ply ?? -1,
    primaryTheme: reviewPrimaryTheme(),
    takeaway: '',
  })
}

// onReplayPlyChanged: called whenever the spectator ply changes (clicking a
// move, replay controls, or lesson nav) so the lesson index/progress stays
// in sync even when the player scrubs manually instead of using Next lesson.
export function onReplayPlyChanged(ply) {
  if (!session || !session.lessons.length) return
  const matchIndex = session.lessons.findIndex(lesson => lesson.ply === ply)
  if (matchIndex >= 0 && matchIndex !== session.currentLessonIndex) {
    session.currentLessonIndex = matchIndex
    renderSummaryAndProgress()
  }
}

export function prevLesson() {
  if (!session || session.currentLessonIndex <= 0) return
  session.currentLessonIndex--
  renderSummaryAndProgress()
  session.goToPly(session.lessons[session.currentLessonIndex].ply)
}

export function nextLesson() {
  if (!session || session.currentLessonIndex >= session.lessons.length - 1) return
  session.currentLessonIndex++
  renderSummaryAndProgress()
  session.goToPly(session.lessons[session.currentLessonIndex].ply)
}

// tryFromHere: retry a drill from wherever the board currently sits — reuses
// startRetryFromPosition via the injected callback (dev-plan §10.7). Works
// at any ply, not only a lesson ply, since the player may have scrubbed.
export function tryFromHere(currentPly) {
  if (!session) return
  const label = session.lessons[session.currentLessonIndex]?.ply === currentPly
    ? `You played ${session.lessons[session.currentLessonIndex].playedNotation} here — find something better.`
    : 'Try a different move from here.'
  session.startRetry(currentPly, label)
}

export function isSessionActive() {
  return !!session
}

// finishReview: persists the CURRENT session as 'reviewed' with an optional
// takeaway (dev-plan §11.2) — the only path that stores a zero-lesson
// ("clean game") summary at all. Save feedback (Saving/Saved/Could not save)
// renders directly into the finish panel; the caller doesn't need to poll
// anything. Review may still be closed without ever calling this.
export async function finishReview({ takeaway } = {}) {
  if (!session || !indexV1Enabled()) return { ok: false, error: 'No active review.' }
  const { saveNote } = els()
  if (saveNote) saveNote.textContent = 'Saving…'
  const now = new Date().toISOString()
  try {
    await upsertReview(session.userId, {
      matchId: session.match.id,
      matchFingerprint: computeMatchFingerprint(session.match.moves),
      status: 'reviewed',
      analysisVersion: ANALYSIS_VERSION,
      analyzedAt: session.analyzedAt || now,
      completedAt: now,
      updatedAt: now,
      movesGraded: session.movesGraded,
      lessonCount: session.lessons.length,
      positiveCount: session.positiveHighlight ? 1 : 0,
      firstLessonPly: session.lessons[0]?.ply ?? -1,
      primaryTheme: reviewPrimaryTheme(),
      takeaway: trimTakeaway(takeaway),
    })
    if (saveNote) saveNote.textContent = 'Saved'
    emitLearningStateChanged('review_finished')
    // Goal v2 evidence (dev-plan §13.3) — best-effort and fire-and-forget;
    // a goal-progress hiccup must never affect the Finish Review UX itself.
    Promise.resolve(session.onReviewFinished?.(session.match.id))
      .catch(error => console.warn('[review] goal evidence:', error?.message || error))
    return { ok: true }
  } catch (error) {
    if (saveNote) saveNote.textContent = 'Could not save — try again.'
    return { ok: false, error: error?.message || 'Save failed.' }
  }
}

// loadLearningIndex / reviewBadge: the read path History's badge-patching
// uses (dev-plan §11.3). Re-exported here rather than imported directly by
// src/main.js so learning-contract.mjs/learning-store.js — and the CloudSave
// SDK they pull in — stay entirely behind the lazy reviewFeature loader.
export { fetchLearningIndex as loadLearningIndex, computeReviewBadge as reviewBadge }

// resetReviewSession: clears session state and hides review-only chrome.
// Bumping the token here is what makes a still-in-flight analyzeMatch() call
// a no-op if it resolves after Back/Done or a different match opens. Also
// clears the learning-index cache (dev-plan §11.4) — called on logout in
// addition to every ordinary "leave review" path, since a logout doesn't
// have a separate M4-specific reset hook in the plan's five-function interface.
export function resetReviewSession() {
  requestToken++
  session = null
  resetLearningCache()
  const { badge, summary, progress, actions, finishPanel, saveNote, takeawayInput } = els()
  setVisible(badge, false)
  setVisible(summary, false)
  setVisible(progress, false)
  setVisible(actions, false)
  setVisible(finishPanel, false)
  if (saveNote) saveNote.textContent = ''
  if (takeawayInput) takeawayInput.value = ''
}

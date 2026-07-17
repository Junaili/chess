// Pure lesson-selection and copy-shaping for review mode (dev-plan §10.5).
// Reuses journal-data.mjs's existing mistake/punished/swing moment detection
// (summarizeGradedGame) rather than reinventing tactical-moment semantics —
// this module's own job is choosing WHICH moments a review opens with and
// writing calm, honest, "Quick Review" copy around them. No DOM, no engine,
// no network.

import { summarizeGradedGame } from './journal-data.mjs'

export const REVIEW_MAX_LESSONS = 3
// The engine returns ±100000 for a real forced mate (ai-engine.js). Anything
// remotely close to that is a decisive swing, not a pawn count worth stating
// to two decimal places — dev-plan §10.5: "mate-scale output uses
// winning/losing language, not pawn counts."
export const REVIEW_MATE_SCALE_CP = 5000

// Noun form ("gave up 2.5 pawns") — only exactly 1.0 is singular.
function formatPawnMagnitude(cp) {
  const rounded = (Math.max(0, cp || 0) / 100).toFixed(1)
  return `${rounded} ${rounded === '1.0' ? 'pawn' : 'pawns'}`
}

// Adjective form ("a 2.5-pawn swing") — always singular, hyphenated.
function formatPawnAdjective(cp) {
  return `${(Math.max(0, cp || 0) / 100).toFixed(1)}-pawn`
}

export function formatReviewLoss(lossCp) {
  const loss = Math.max(0, lossCp || 0)
  return loss >= REVIEW_MATE_SCALE_CP ? 'let a winning position slip' : `gave up ${formatPawnMagnitude(loss)}`
}

export function formatReviewGain(gainCp) {
  const gain = Math.max(0, gainCp || 0)
  return gain >= REVIEW_MATE_SCALE_CP ? 'turned a losing position around' : `found a ${formatPawnAdjective(gain)} swing`
}

// buildReviewLessons: player-only grades (from chessBackgroundWorker
// .analyzeMatch(match, { scope: 'player' })) -> up to REVIEW_MAX_LESSONS
// lessons (highest-cost first, ties broken by earliest ply) and at most one
// positive highlight. `playerGrades` must contain ONLY the recording
// player's plies, ordered by moveIndex (analyzeMatch's scope:'player'
// output already satisfies this).
export function buildReviewLessons(playerGrades, totalMoves) {
  const { moments } = summarizeGradedGame(playerGrades, totalMoves)
  const lessons = moments
    .filter(m => m.kind === 'mistake')
    .sort((a, b) => (b.loss - a.loss) || (a.ply - b.ply))
    .slice(0, REVIEW_MAX_LESSONS)
  const positiveHighlight = moments
    .filter(m => m.kind === 'punished' || m.kind === 'swing')
    .sort((a, b) => (b.gain || 0) - (a.gain || 0))[0] || null
  return { lessons, positiveHighlight }
}

// selectFirstReviewPly: the highest-cost lesson wins (already first in
// `lessons`); with no lesson, land on the final ply with an encouraging
// summary instead of an empty board.
export function selectFirstReviewPly(lessons, totalMoves) {
  if (lessons.length) return lessons[0].ply
  return Math.max(0, (totalMoves || 1) - 1)
}

function moveNumberFor(ply) {
  return Math.floor(ply / 2) + 1
}

// buildReviewSummary: the review screen's lead sentence. Leads with the
// positive highlight when one exists, THEN the lesson count — never the
// reverse (dev-plan §4.4 rule 1: encouragement before correction).
export function buildReviewSummary({ lessons, positiveHighlight }) {
  const lessonPart = lessons.length
    ? `${lessons.length} moment${lessons.length === 1 ? '' : 's'} worth another look.`
    : 'No moments flagged — clean game.'
  if (!positiveHighlight) return lessonPart
  const positiveLine = positiveHighlight.kind === 'punished'
    ? `You spotted and punished a mistake on move ${moveNumberFor(positiveHighlight.ply)}.`
    : `You ${formatReviewGain(positiveHighlight.gain)} on move ${moveNumberFor(positiveHighlight.ply)}.`
  return `${positiveLine} ${lessonPart}`
}

// reviewLessonLabel: one lesson's copy line, e.g. "Qxh7 gave up 3.2 pawns —
// try Rxh7." Plain words, no centipawns exposed (dev-plan §4.4 rule 3).
export function reviewLessonLabel(lesson) {
  if (!lesson) return ''
  const loss = formatReviewLoss(lesson.loss)
  return lesson.bestNotation
    ? `${lesson.playedNotation} ${loss} — try ${lesson.bestNotation}.`
    : `${lesson.playedNotation} ${loss}.`
}

// primaryTheme stays 'general' in M3 — no speculative tactical
// classification (dev-plan §10.5) until a reliable detector exists.
export function reviewPrimaryTheme() {
  return 'general'
}

// suggestedTakeaways: Finish Review's chip options (dev-plan §11.2 "optional
// suggested takeaway chips derived only from reliable summary fields"). The
// only reliable field available in M4 is whether any lesson was flagged at
// all — primaryTheme stays 'general', so chips can't be theme-specific yet.
const LESSON_TAKEAWAY_SUGGESTIONS = [
  'Check what their last move attacks.',
  'Slow down before big captures.',
  'Look for checks and threats first.',
]
const CLEAN_GAME_TAKEAWAY_SUGGESTIONS = [
  'Keep playing solid, careful chess.',
]

export function suggestedTakeaways(lessons) {
  return (lessons || []).length ? LESSON_TAKEAWAY_SUGGESTIONS : CLEAN_GAME_TAKEAWAY_SUGGESTIONS
}

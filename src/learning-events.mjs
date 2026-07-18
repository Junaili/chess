// Tiny subscribe/emit seam for "something in the player's private learning
// state just changed" (notification dev-plan §13.8). No DOM, no storage — the
// orchestrator (src/learning-notifications.js) is the only subscriber, kept
// separate so journal.js/review.js never import notification code directly
// and stay unaffected when the notificationsV1 flag is off.

const REASONS = [
  'match_saved', 'journal_generated', 'practice_attempted', 'review_finished',
  'goal_changed', 'signed_in', 'resumed', 'preferences_changed', 'logged_out',
]

let listeners = []

export function subscribeLearningStateChanged(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.push(listener)
  return () => { listeners = listeners.filter(l => l !== listener) }
}

export function emitLearningStateChanged(reason) {
  if (!REASONS.includes(reason)) return
  for (const listener of listeners) {
    try {
      listener(reason)
    } catch (error) {
      console.warn('[learning-events] listener failed:', error?.message || error)
    }
  }
}

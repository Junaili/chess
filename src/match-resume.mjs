// Pure helpers for resuming an online match after a disconnect/crash/reload —
// no AGS calls, no DOM, so these are unit-testable in isolation. See
// docs/ags-plans (match resiliency plan) for the overall design.

export const RESUME_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

export function computeDeadline(disconnectedAt) {
  return new Date(new Date(disconnectedAt).getTime() + RESUME_WINDOW_MS).toISOString()
}

export function isPastDeadline(deadline, now = new Date()) {
  if (!deadline) return false
  return new Date(now).getTime() > new Date(deadline).getTime()
}

// A persisted chess-active-match record is still worth offering to resume if
// it hasn't been given a deadline yet (client never confirmed the drop was
// terminal) or the deadline hasn't passed.
export function isResumable(record, now = new Date()) {
  if (!record || !record.matchId) return false
  return !isPastDeadline(record.deadline, now)
}

// Deterministic rendezvous point for two known user IDs — the same scheme
// matchmaking already uses for its host/joiner PeerJS connection (app.js),
// generalized here so a post-reload resume can independently re-derive it
// without needing to have been the one who set up the original connection.
export function deriveMatchRoles(myUserId, opponentUserId) {
  const sorted = [myUserId, opponentUserId].slice().sort()
  const hostUserId = sorted[0]
  return {
    hostUserId,
    iAmHost: myUserId === hostUserId,
    peerId: hostUserId.replace(/-/g, ''),
  }
}

// Both sides publish their own move list independently after every move
// (chess-live CloudSave record); on resume, each side reads both records and
// adopts whichever is longer as ground truth — since both sides compute this
// the same way from the same two public records, they should already agree
// before the PeerJS handshake completes.
export function pickAuthoritativeMoves(mineMoves, theirsMoves) {
  const mine = Array.isArray(mineMoves) ? mineMoves : []
  const theirs = Array.isArray(theirsMoves) ? theirsMoves : []
  return theirs.length > mine.length ? theirs : mine
}

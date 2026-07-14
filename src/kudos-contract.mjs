// Pure, unit-testable eligibility logic for the post-match "High Five"
// gifting mechanic (dev-plan dev-plan/subscription-coins-implementation-plan.md,
// Milestone 7). No DOM, no fetch — network/orchestration lives in
// src/kudos.js; app.js (a plain script, not an ES module, so it cannot
// import this directly) calls it via a thin window wrapper set up in
// src/main.js, the same pattern already used for window.isGambitGusIdentity.

export const HIGH_FIVE_COST = 10
export const HIGH_FIVE_REWARD = 5

// highFiveTxKey mirrors the server's own dedupe key exactly
// (custom-extend-app/ethan-chess-service/cmd/monetization_ledger.go's
// txKeyHighFive: "hf:" + matchID + ":" + senderID) — used client-side only
// to key the in-session "already sent" set, never sent over the wire.
export function highFiveTxKey(matchId, senderId) {
  return `hf:${matchId}:${senderId}`
}

// deriveHighFiveButton: mirrors the server's validHighFiveTarget
// (monetization.go) plus client-only UX state (balance, already-sent-this-
// session). Never renders for anyone the server would reject anyway — the
// button's ABSENCE is itself part of the identity-requirement contract
// (dev-plan §9: "never guess a userId").
export function deriveHighFiveButton({
  gameMode = '', senderId = '', recipientUserId = '', isBot = false, isBlocked = false,
  alreadySent = false, coins = 0,
} = {}) {
  if (gameMode !== 'online') return { visible: false }
  if (!senderId || !recipientUserId || senderId === recipientUserId) return { visible: false }
  if (isBot || isBlocked) return { visible: false }

  if (alreadySent) {
    return { visible: true, disabled: true, label: '🙌 High Five sent' }
  }
  if (coins < HIGH_FIVE_COST) {
    return { visible: true, disabled: true, label: `🙌 High Five (need ${HIGH_FIVE_COST} 🪙)` }
  }
  return { visible: true, disabled: false, label: `🙌 High Five · ${HIGH_FIVE_COST} 🪙` }
}

// insufficientCoinsMessage: dev-plan §9 "friendly path" copy —
// "Not enough coins — you have 4 🪙" — after a stale-balance rejection.
export function insufficientCoinsMessage(senderBalance) {
  return `Not enough coins — you have ${senderBalance ?? 0} 🪙`
}

export function formatKudosCount(count) {
  const n = Number(count) || 0
  return `${n.toLocaleString()}`
}

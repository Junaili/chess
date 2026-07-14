// High Five network orchestration (dev-plan Milestone 7). Eligibility
// decisions live in kudos-contract.mjs; this module owns extendFetch and
// the in-session "already sent this match" tracking. app.js (a plain
// script, not an ES module) can't import this directly — src/main.js
// exposes thin window wrappers, same pattern as club.js/coin-store.js.
import { extendFetch } from './extend-client.js'
import { fetchClubStatus } from './club.js'
import { insufficientCoinsMessage } from './kudos-contract.mjs'

// Client-side mirror of the server's per-match dedupe (matchId is unique
// per completed match, so a plain Set is sufficient — no need to key by
// sender since this only ever tracks the CALLER's own sends).
const sentThisSession = new Set()

export function hasSentHighFive(matchId) {
  return matchId ? sentThisSession.has(matchId) : false
}

async function parseHighFiveError(response, fallback) {
  const payload = await response.json().catch(() => ({}))
  const error = new Error(payload?.message || fallback)
  error.code = payload?.error || ''
  error.status = response.status
  error.senderBalance = payload?.senderBalance
  return error
}

// sendHighFive: POST /coins/highfive. On success OR "already_sent" (a
// benign race — e.g. a double-click that both reached the server), marks
// the match as sent client-side so the button UI settles into the same
// "sent" state either way. On insufficient_coins, force-refreshes the
// shared coin balance (dev-plan §9 "Balance staleness") and rewrites the
// error message with the fresh number.
export async function sendHighFive(matchId, recipientUserId) {
  if (!matchId || !recipientUserId) throw new Error('Missing match or recipient.')
  const res = await extendFetch('/coins/highfive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchId, recipientUserId }),
  })
  if (!res.ok) {
    const error = await parseHighFiveError(res, 'Could not send High Five. Try again.')
    if (error.code === 'already_sent') {
      sentThisSession.add(matchId)
    } else if (error.code === 'insufficient_coins') {
      // The 402 response already carries the fresh, authoritative balance
      // (senderBalance) — use it directly rather than a second round trip
      // that could race with this one. Still refresh the shared cache
      // (fire-and-forget) so OTHER UI reading getCoins() isn't stale too.
      error.message = insufficientCoinsMessage(error.senderBalance)
      void fetchClubStatus({ force: true }).catch(() => {})
    }
    throw error
  }
  const { senderBalance } = await res.json()
  sentThisSession.add(matchId)
  await fetchClubStatus({ force: true }).catch(() => {})
  return { senderBalance }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.agsKudosStateForTesting = () => ({ sentThisSession: [...sentThisSession] })
  window.agsResetKudosStateForTesting = () => sentThisSession.clear()
}

import { MatchTicketsApi } from '@accelbyte/sdk-matchmaking'
import { GameSessionApi } from '@accelbyte/sdk-session'
import { sdk, agsBaseURL, agsNamespace } from './ags-client.js'
import { sendEvent } from './telemetry.js'

const MATCH_POOL     = 'chess-quickmatch'
const POLL_INTERVAL  = 2000   // ms between status polls
const MATCH_TIMEOUT  = 120000 // 2 min — matches ticket_expiration_seconds on the pool

let activeTicketId  = null
let pollTimer       = null
let cancelled       = false
let searchStartedAt = 0

// Zombie-ticket guard: refreshing/closing the page mid-queue would strand the
// ticket in the pool until its TTL, where it can steal the next match (from a
// real opponent or the cold-start bot) for a browser that no longer exists.
// SDK calls don't survive unload, so fire a keepalive DELETE (cookie auth).
function abandonTicketOnUnload() {
  if (!activeTicketId) return
  const url = `${agsBaseURL}/match2/v1/namespaces/${agsNamespace}/match-tickets/${activeTicketId}`
  try { fetch(url, { method: 'DELETE', credentials: 'include', keepalive: true }) } catch { /* best effort */ }
  activeTicketId = null
}
window.addEventListener('pagehide', abandonTicketOnUnload)
window.addEventListener('beforeunload', abandonTicketOnUnload)

// Emit the outcome of a matchmaking attempt so we can measure queue liquidity
// (found vs. timeout vs. cancelled) — a timeout otherwise produces no event and
// the cold-start problem stays invisible.
function reportResult(result, extra = {}) {
  const waitSeconds = searchStartedAt ? Math.round((Date.now() - searchStartedAt) / 1000) : 0
  sendEvent('matchmaking_result', { result, wait_seconds: waitSeconds, pool: MATCH_POOL, ...extra })
}

export async function startMatchmaking(onFound, onTimeout, onError) {
  cancelled = false
  searchStartedAt = Date.now()

  let res
  try {
    res = await MatchTicketsApi(sdk).createMatchTicket({
      matchPool:  MATCH_POOL,
      attributes: {},
      latencies:  {},
    })
  } catch (e) {
    console.warn('[MM] createMatchTicket:', e?.response?.data || e?.message)
    reportResult('error', { stage: 'create_ticket' })
    onError('Could not enter matchmaking queue. Please try again.')
    return
  }

  activeTicketId = res.data.matchTicketID
  const deadline = Date.now() + MATCH_TIMEOUT
  // A ticket that 404s (or errorCode 520303) has expired/been consumed server-
  // side. Polling a dead ticket for the full 2-min timeout just spams the
  // console and delays the retry UI. Tolerate one lookup miss (eventual
  // consistency right after create), then treat it as a timeout.
  let notFoundStreak = 0

  pollTimer = setInterval(async () => {
    if (cancelled) return

    let status
    try {
      const r = await MatchTicketsApi(sdk).getMatchTicket_ByTicketid(activeTicketId)
      status = r.data
      notFoundStreak = 0
    } catch (e) {
      console.warn('[MM] getMatchTicket:', e?.response?.data || e?.message)
      const ticketGone = e?.response?.status === 404 || e?.response?.data?.errorCode === 520303
      if (ticketGone && ++notFoundStreak >= 2) {
        stopPolling()
        activeTicketId = null // already gone server-side; nothing to delete
        reportResult('timeout', { reason: 'ticket_expired' })
        onTimeout()
      }
      return  // otherwise transient — keep polling
    }

    if (status.matchFound) {
      stopPolling()
      activeTicketId = null // consumed by the match — nothing to clean up on unload
      const sessionId = status.sessionID
      console.log('[MM] match found, sessionId:', sessionId)
      if (!sessionId) {
        onError('Match found but session ID was empty. Please try again.')
        return
      }
      try {
        const s = await GameSessionApi(sdk).getGamesession_BySessionId(sessionId)
        console.log('[MM] session data:', JSON.stringify(s.data))
        const members = s.data?.members || []
        // session members use field `id` for the user ID
        const userIds = members.map(m => m.id).filter(Boolean)
        if (userIds.length < 2) {
          onError('Match found but session has fewer than 2 members. Please try again.')
          return
        }
        reportResult('found')
        // Backward-compatible payload: app.js's onFound treats this as the
        // member-userId ARRAY (.slice().sort()), so pass the array itself and
        // attach the richer fields as properties. Passing a plain object here
        // broke matchmaking in prod ("memberUserIds.slice is not a function").
        const payload = userIds.slice()
        payload.sessionId = sessionId
        payload.session = s.data
        payload.memberUserIds = userIds
        onFound(payload)
      } catch (e) {
        console.warn('[MM] getGamesession error:', e?.response?.status, e?.response?.data || e?.message)
        onError('Match found but could not retrieve session. Please try again.')
      }
      return
    }

    if (Date.now() >= deadline) {
      stopPolling()
      await deleteTicketSilently(activeTicketId)
      activeTicketId = null
      reportResult('timeout')
      onTimeout()
    }
  }, POLL_INTERVAL)
}

export async function cancelMatchmaking() {
  cancelled = true
  stopPolling()
  if (activeTicketId) {
    reportResult('cancelled')
    await deleteTicketSilently(activeTicketId)
    activeTicketId = null
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function deleteTicketSilently(ticketId) {
  try {
    await MatchTicketsApi(sdk).deleteMatchTicket_ByTicketid(ticketId)
  } catch (e) {
    // ticket may already be consumed by the server — not an error
  }
}

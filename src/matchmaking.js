import { MatchTicketsApi } from '@accelbyte/sdk-matchmaking'
import { GameSessionApi } from '@accelbyte/sdk-session'
import { sdk } from './ags-client.js'

const MATCH_POOL     = 'chess-quickmatch'
const POLL_INTERVAL  = 2000   // ms between status polls
const MATCH_TIMEOUT  = 120000 // 2 min — matches ticket_expiration_seconds on the pool

let activeTicketId  = null
let pollTimer       = null
let cancelled       = false

export async function startMatchmaking(onFound, onTimeout, onError) {
  cancelled = false

  let res
  try {
    res = await MatchTicketsApi(sdk).createMatchTicket({
      matchPool:  MATCH_POOL,
      attributes: {},
      latencies:  {},
    })
  } catch (e) {
    console.warn('[MM] createMatchTicket:', e?.response?.data || e?.message)
    onError('Could not enter matchmaking queue. Please try again.')
    return
  }

  activeTicketId = res.data.matchTicketID
  const deadline = Date.now() + MATCH_TIMEOUT

  pollTimer = setInterval(async () => {
    if (cancelled) return

    let status
    try {
      const r = await MatchTicketsApi(sdk).getMatchTicket_ByTicketid(activeTicketId)
      status = r.data
    } catch (e) {
      console.warn('[MM] getMatchTicket:', e?.response?.data || e?.message)
      return  // transient error — keep polling
    }

    if (status.matchFound) {
      stopPolling()
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
        onFound(userIds)
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
      onTimeout()
    }
  }, POLL_INTERVAL)
}

export async function cancelMatchmaking() {
  cancelled = true
  stopPolling()
  if (activeTicketId) {
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

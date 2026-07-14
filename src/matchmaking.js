import { MatchTicketsApi } from '@accelbyte/sdk-matchmaking'
import { GameSessionApi } from '@accelbyte/sdk-session'
import { sdk, agsBaseURL, agsNamespace } from './ags-client.js'
import { sendEvent } from './telemetry.js'
import { subscribeMatchFound } from './presence.js'
import { isNotificationForTicket, selectRecentMatchSession } from './matchmaking-recovery.mjs'

const MATCH_POOL = 'chess-quickmatch'
const POLL_INTERVAL = 2000 // ms between status polls
const MATCH_TIMEOUT = 120000 // 2 min — matches ticket_expiration_seconds on the pool
const SESSION_LOAD_RETRY_DELAYS_MS = [0, 500, 1500]

let nextRunId = 0
let activeRun = null

function isActive(run) {
  return activeRun === run && !run.cancelled
}

function stopPolling(run) {
  if (run?.pollTimer) {
    clearTimeout(run.pollTimer)
    run.pollTimer = null
  }
}

function reportResult(run, result, extra = {}) {
  const waitSeconds = run?.startedAt
    ? Math.round((Date.now() - run.startedAt) / 1000)
    : 0
  sendEvent('matchmaking_result', {
    result,
    wait_seconds: waitSeconds,
    pool: MATCH_POOL,
    ...extra,
  })
}

function invokeCallback(callback, ...args) {
  if (typeof callback !== 'function') return
  try {
    Promise.resolve(callback(...args)).catch(error => {
      console.error('[MM] callback failed:', error)
    })
  } catch (error) {
    console.error('[MM] callback failed:', error)
  }
}

function retireRun(run) {
  stopPolling(run)
  run.unsubscribeMatchFound?.()
  run.unsubscribeMatchFound = null
  run.cancelled = true
  if (activeRun === run) activeRun = null
}

async function deleteTicketSilently(ticketId) {
  if (!ticketId) return
  try {
    await MatchTicketsApi(sdk).deleteMatchTicket_ByTicketid(ticketId)
  } catch {
    // The ticket may already have been consumed or expired server-side.
  }
}

async function findRecentMatchedSession(run) {
  const response = await GameSessionApi(sdk).getUsersMeGamesessions({
    order: 'desc',
    orderBy: 'createdAt',
  })
  return selectRecentMatchSession(response.data?.data, {
    matchPool: MATCH_POOL,
    startedAt: run.startedAt,
  })
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function loadMatchedSession(run, sessionId, prefetchedSession) {
  if (prefetchedSession) return prefetchedSession
  let lastError
  for (const delay of SESSION_LOAD_RETRY_DELAYS_MS) {
    if (delay) await wait(delay)
    if (!isActive(run)) return null
    try {
      return (await GameSessionApi(sdk).getGamesession_BySessionId(sessionId)).data
    } catch (error) {
      lastError = error
      const status = Number(error?.response?.status || 0)
      const retryable = status === 0 || status === 404 || status === 408 || status === 429 || status >= 500
      if (!retryable) throw error
    }
  }
  throw lastError || new Error('Game session did not become available.')
}

async function completeMatchedSession(run, sessionId, onFound, onError, prefetchedSession = null) {
  if (!isActive(run) || run.completing) return
  run.completing = true
  stopPolling(run)
  // Matchmaking consumes the ticket. Clearing it also prevents Cancel/unload
  // from deleting a ticket that now belongs to a completed session.
  run.ticketId = null
  console.log('[MM] match found, sessionId:', sessionId)

  if (!sessionId) {
    if (!isActive(run)) return
    reportResult(run, 'error', { stage: 'empty_session_id' })
    retireRun(run)
    invokeCallback(onError, 'Match found but session ID was empty. Please try again.')
    return
  }

  try {
    // Session propagation can trail OnMatchFound briefly. Bound the retries so
    // a valid match survives that race without leaving the waiting screen up
    // forever when the service is genuinely unavailable.
    const session = await loadMatchedSession(run, sessionId, prefetchedSession)
    if (!isActive(run)) return
    console.log('[MM] session data:', JSON.stringify(session))
    const userIds = (session?.members || []).map(member => member.id).filter(Boolean)
    if (userIds.length < 2) {
      reportResult(run, 'error', { stage: 'incomplete_session' })
      retireRun(run)
      invokeCallback(onError, 'Match found but session has fewer than 2 members. Please try again.')
      return
    }

    reportResult(run, 'found')
    retireRun(run)
    // Backward-compatible payload: app.js treats this as the member-userId
    // array, while the attached fields expose richer session information.
    const payload = userIds.slice()
    payload.sessionId = sessionId
    payload.session = session
    payload.memberUserIds = userIds
    invokeCallback(onFound, payload)
  } catch (error) {
    if (!isActive(run)) return
    console.warn('[MM] getGamesession error:', error?.response?.status, error?.response?.data || error?.message)
    reportResult(run, 'error', { stage: 'get_session' })
    retireRun(run)
    invokeCallback(onError, 'Match found but could not retrieve session. Please try again.')
  }
}

async function finishTimeout(run, onTimeout, reason) {
  if (!isActive(run)) return
  const ticketId = run.ticketId
  run.ticketId = null
  reportResult(run, 'timeout', reason ? { reason } : {})
  retireRun(run)
  invokeCallback(onTimeout)
  await deleteTicketSilently(ticketId)
}

async function pollMatchmaking(run, onFound, onTimeout, onError) {
  if (!isActive(run) || !run.ticketId || run.pollInFlight || run.completing) return
  run.pollInFlight = true
  let shouldPollAgain = true

  try {
    let status
    try {
      const response = await MatchTicketsApi(sdk).getMatchTicket_ByTicketid(run.ticketId)
      if (!isActive(run)) return
      status = response.data
      run.notFoundStreak = 0
    } catch (error) {
      if (!isActive(run)) return
      console.warn('[MM] getMatchTicket:', error?.response?.data || error?.message)
      const ticketGone = error?.response?.status === 404
        || error?.response?.data?.errorCode === 520303
      if (ticketGone) {
        run.notFoundStreak += 1
        // A successfully matched ticket can disappear before every client has
        // observed its final status. Recover from the current user's newly
        // joined session instead of misreporting that race as an expiration.
        try {
          const session = await findRecentMatchedSession(run)
          if (!isActive(run)) return
          if (session) {
            shouldPollAgain = false
            await completeMatchedSession(run, session.id, onFound, onError, session)
            return
          }
        } catch (sessionError) {
          if (!isActive(run)) return
          console.warn('[MM] recover matched session:', sessionError?.response?.data || sessionError?.message)
        }
      }
      if (Date.now() >= run.deadline) {
        shouldPollAgain = false
        await finishTimeout(run, onTimeout, 'deadline_after_poll_error')
      }
      return
    }

    if (status?.matchFound) {
      shouldPollAgain = false
      await completeMatchedSession(run, status.sessionID, onFound, onError)
      return
    }

    if (Date.now() >= run.deadline) {
      shouldPollAgain = false
      await finishTimeout(run, onTimeout)
    }
  } finally {
    run.pollInFlight = false
    if (shouldPollAgain && isActive(run) && run.ticketId && !run.completing) {
      // A recursive timeout cannot overlap an in-flight request, unlike an
      // async setInterval callback on a slow or temporarily offline network.
      run.pollTimer = setTimeout(() => {
        run.pollTimer = null
        void pollMatchmaking(run, onFound, onTimeout, onError)
      }, POLL_INTERVAL)
    }
  }
}

export async function startMatchmaking(onFound, onTimeout, onError) {
  // Supersede any previous attempt immediately. If its create call resolves
  // later, the stale-run check below deletes the orphaned ticket.
  const previousRun = activeRun
  if (previousRun) {
    const previousTicketId = previousRun.ticketId
    previousRun.ticketId = null
    reportResult(previousRun, 'cancelled', { reason: 'superseded' })
    retireRun(previousRun)
    void deleteTicketSilently(previousTicketId)
  }

  const run = {
    id: ++nextRunId,
    startedAt: Date.now(),
    deadline: Date.now() + MATCH_TIMEOUT,
    ticketId: null,
    pollTimer: null,
    pollInFlight: false,
    notFoundStreak: 0,
    completing: false,
    unsubscribeMatchFound: null,
    cancelled: false,
  }
  activeRun = run

  let response
  try {
    response = await MatchTicketsApi(sdk).createMatchTicket({
      matchPool: MATCH_POOL,
      attributes: {},
      latencies: {},
    })
  } catch (error) {
    if (!isActive(run)) return
    console.warn('[MM] createMatchTicket:', error?.response?.data || error?.message)
    reportResult(run, 'error', { stage: 'create_ticket' })
    retireRun(run)
    invokeCallback(onError, 'Could not enter matchmaking queue. Please try again.')
    return
  }

  const ticketId = response?.data?.matchTicketID
  if (!ticketId) {
    if (!isActive(run)) return
    reportResult(run, 'error', { stage: 'empty_ticket_id' })
    retireRun(run)
    invokeCallback(onError, 'Matchmaking did not return a ticket. Please try again.')
    return
  }
  if (!isActive(run)) {
    await deleteTicketSilently(ticketId)
    return
  }

  run.ticketId = ticketId
  // OnMatchFound is the authoritative AGS completion signal. REST polling is
  // retained as a fallback, and the recent-session recovery path covers the
  // narrow window where this notification arrived before subscription or
  // while Lobby was reconnecting.
  run.unsubscribeMatchFound = subscribeMatchFound(notification => {
    if (!isActive(run) || run.completing) return
    if (!isNotificationForTicket(notification, run.ticketId, MATCH_POOL, run.startedAt)) return
    void completeMatchedSession(run, notification.sessionId, onFound, onError)
  })
  // Poll immediately so fast matches do not incur an unnecessary 2-second lag.
  void pollMatchmaking(run, onFound, onTimeout, onError)
}

export async function cancelMatchmaking() {
  const run = activeRun
  if (!run) return
  const ticketId = run.ticketId
  run.ticketId = null
  reportResult(run, 'cancelled')
  retireRun(run)
  await deleteTicketSilently(ticketId)
}

// Zombie-ticket guard: refreshing/closing the page mid-queue would otherwise
// strand a ticket until its TTL. SDK calls do not survive unload, so use a
// best-effort keepalive request with the current bearer token. Include
// credentials as a fallback for environments that also issue an IAM cookie.
function abandonTicketOnUnload() {
  const run = activeRun
  if (!run) return
  const ticketId = run.ticketId
  run.ticketId = null
  retireRun(run)
  // If createMatchTicket is still in flight, retiring the run is enough: its
  // stale completion path will delete the ticket as soon as its ID arrives.
  if (!ticketId) return
  const url = `${agsBaseURL}/match2/v1/namespaces/${encodeURIComponent(agsNamespace)}/match-tickets/${encodeURIComponent(ticketId)}`
  const accessToken = sdk.getToken()?.accessToken
  try {
    void fetch(url, {
      method: 'DELETE',
      credentials: 'include',
      keepalive: true,
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    }).catch(() => {})
  } catch {
    // Unload cleanup is best effort.
  }
}

window.addEventListener('pagehide', abandonTicketOnUnload)
window.addEventListener('beforeunload', abandonTicketOnUnload)

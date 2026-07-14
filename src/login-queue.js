import { fetchWithTimeout } from './network.mjs'

// AGS Login Queue handling.
//
// When IAM is enabled with a login queue and is at capacity, the login
// endpoints (password grant on /iam/v3/oauth/token and the platform-token
// endpoints used by Google/Apple) respond with HTTP 401 and a queue *ticket*
// in the body instead of a token. The client must wait its turn by polling the
// ticket's self-described `refresh` link, then exchange the ticket for a real
// token via the `login_queue_ticket` grant once it reaches the front.
//
// Ticket shape (AGS LoginQueueTicketResponse):
//   { ticket, position, estimatedWaitingTimeInSeconds, playerPollingTimeInSeconds,
//     reconnectExpiredAt, refresh: { action, href }, cancel: { action, href } }
//
// This module is UI-agnostic: it emits queue state to a handler that the app
// registers once at startup (see setQueueUIHandler), and exposes cancelLoginQueue
// for a "Leave queue" button.

const FINALIZE_GRANT = 'urn:ietf:params:oauth:grant-type:login_queue_ticket'

// Absolute ceiling on how long we'll sit in the queue before giving up, so a
// misbehaving server can never trap a player in an endless poll loop.
const MAX_QUEUE_DURATION_MS = 30 * 60 * 1000

let queueUIHandler = null
let activeCancel = null

// Register the function that renders queue state. Called with one of:
//   { status: 'queued', position, estimatedWaitingTimeInSeconds }
//   { status: 'cleared' }    — admitted; token exchange done
//   { status: 'cancelled' }  — player left the queue
//   { status: 'error' }      — queue failed / expired
export function setQueueUIHandler(fn) {
  queueUIHandler = typeof fn === 'function' ? fn : null
}

// Signal the currently-running queue (if any) to leave. The runner releases the
// ticket server-side via its cancel link and resolves with { cancelled: true }.
export function cancelLoginQueue() {
  if (activeCancel) activeCancel.cancelled = true
}

function emit(state) {
  try {
    if (queueUIHandler) queueUIHandler(state)
  } catch (e) {
    console.error('[AGS] login-queue UI handler threw:', e?.message || e)
  }
}

// A response body is a queue ticket (rather than a token or an auth error) when
// it carries a ticket string and a refresh link to poll.
export function isQueueTicket(payload) {
  return !!(
    payload &&
    typeof payload === 'object' &&
    typeof payload.ticket === 'string' &&
    payload.ticket &&
    payload.refresh &&
    typeof payload.refresh.href === 'string'
  )
}

// Sleep that wakes early if the queue is cancelled, so "Leave queue" feels
// responsive even mid-interval.
function interruptibleSleep(ms, isCancelled) {
  return new Promise(resolve => {
    const step = 250
    let waited = 0
    const id = setInterval(() => {
      waited += step
      if (isCancelled() || waited >= ms) {
        clearInterval(id)
        resolve()
      }
    }, step)
  })
}

async function refreshTicket(ticketInfo) {
  try {
    const resp = await fetchWithTimeout(ticketInfo.refresh.href, {
      method: ticketInfo.refresh.action || 'GET',
      headers: { Authorization: `Bearer ${ticketInfo.ticket}` },
    })
    if (!resp.ok) return null
    const data = await resp.json().catch(() => null)
    return isQueueTicket(data) ? data : null
  } catch {
    return null
  }
}

async function releaseTicket(ticketInfo) {
  try {
    if (!ticketInfo.cancel || !ticketInfo.cancel.href) return
    await fetchWithTimeout(ticketInfo.cancel.href, {
      method: ticketInfo.cancel.action || 'DELETE',
      headers: { Authorization: `Bearer ${ticketInfo.ticket}` },
    })
  } catch {
    // Best-effort: the ticket also expires server-side on its own.
  }
}

// Exchange a front-of-queue ticket for a real access token. Returns the token
// payload on success, the (still-queued) ticket if not yet admitted, or null.
async function finalize(baseURL, authHeader, ticket) {
  try {
    const resp = await fetchWithTimeout(`${baseURL}/iam/v3/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: authHeader,
      },
      body: new URLSearchParams({
        grant_type: FINALIZE_GRANT,
        login_queue_ticket: ticket,
      }).toString(),
      credentials: 'include',
    })
    const data = await resp.json().catch(() => ({}))
    if (resp.ok && data?.access_token) return data
    if (resp.status === 401 && isQueueTicket(data)) return data
    return null
  } catch {
    return null
  }
}

function pollMs(ticketInfo) {
  const sec = Number(ticketInfo.playerPollingTimeInSeconds)
  return Math.max(1, Number.isFinite(sec) && sec > 0 ? sec : 5) * 1000
}

// Drive a queue ticket to completion. Returns:
//   { token }           — admitted; caller should setSession(token)
//   { cancelled: true } — player left the queue
//   { error: string }   — queue failed or expired
export async function runLoginQueue(initialTicket, { baseURL, authHeader }) {
  const cancelState = { cancelled: false }
  activeCancel = cancelState
  const isCancelled = () => cancelState.cancelled
  const deadline = Date.now() + MAX_QUEUE_DURATION_MS
  let ticketInfo = initialTicket

  try {
    emit({
      status: 'queued',
      position: ticketInfo.position,
      estimatedWaitingTimeInSeconds: ticketInfo.estimatedWaitingTimeInSeconds,
    })

    for (;;) {
      if (isCancelled()) {
        await releaseTicket(ticketInfo)
        emit({ status: 'cancelled' })
        return { cancelled: true }
      }
      if (Date.now() > deadline) {
        await releaseTicket(ticketInfo)
        emit({ status: 'error' })
        return { error: 'The login queue timed out. Please try again.' }
      }

      // At the front of the line — try to swap the ticket for a real token.
      if (typeof ticketInfo.position === 'number' && ticketInfo.position <= 0) {
        const result = await finalize(baseURL, authHeader, ticketInfo.ticket)
        if (result?.access_token) {
          emit({ status: 'cleared' })
          return { token: result }
        }
        if (isQueueTicket(result)) {
          // Server isn't ready to admit us yet; keep waiting on the new ticket.
          ticketInfo = result
          emit({
            status: 'queued',
            position: ticketInfo.position,
            estimatedWaitingTimeInSeconds: ticketInfo.estimatedWaitingTimeInSeconds,
          })
          await interruptibleSleep(pollMs(ticketInfo), isCancelled)
          continue
        }
        emit({ status: 'error' })
        return { error: 'Could not finish signing in after the queue cleared.' }
      }

      // Still waiting — poll the refresh link at the server-suggested cadence.
      await interruptibleSleep(pollMs(ticketInfo), isCancelled)
      if (isCancelled()) {
        await releaseTicket(ticketInfo)
        emit({ status: 'cancelled' })
        return { cancelled: true }
      }
      const refreshed = await refreshTicket(ticketInfo)
      if (!refreshed) {
        emit({ status: 'error' })
        return { error: 'Lost your place in the login queue. Please try again.' }
      }
      ticketInfo = refreshed
      emit({
        status: 'queued',
        position: ticketInfo.position,
        estimatedWaitingTimeInSeconds: ticketInfo.estimatedWaitingTimeInSeconds,
      })
    }
  } finally {
    if (activeCancel === cancelState) activeCancel = null
  }
}

// Minimal AGS REST helpers the bot uses to behave like a real player:
// password login, matchmaking ticket create/poll/delete, and session lookup.
import './env.mjs'

const base = (process.env.AB_BASE_URL || '').replace(/\/$/, '')
const clientId = process.env.AB_CLIENT_ID || ''
const namespace = process.env.AB_NAMESPACE || ''

function basicAuth() {
  return 'Basic ' + Buffer.from(clientId + ':').toString('base64')
}

function decodeSub(jwt) {
  const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(part, 'base64').toString()).sub
}

// Password grant as the bot user. Returns { token, refreshToken, userId, expiresIn }.
export async function login(email, password) {
  const body = new URLSearchParams({ grant_type: 'password', username: email, password })
  const r = await fetch(`${base}/iam/v3/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: body.toString(),
  })
  if (!r.ok) throw new Error(`login failed: ${r.status} ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  return {
    token: data.access_token,
    refreshToken: data.refresh_token,
    userId: decodeSub(data.access_token),
    expiresIn: data.expires_in,
  }
}

export async function createMatchTicket(token, matchPool) {
  const r = await fetch(`${base}/match2/v1/namespaces/${namespace}/match-tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ matchPool, attributes: {}, latencies: {} }),
  })
  if (!r.ok) throw new Error(`create ticket failed: ${r.status} ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  return data.matchTicketID || data.matchTicketId || data.ticketID
}

// Returns { matchFound, sessionID } or { notFound:true } once consumed/expired.
export async function getMatchTicket(token, ticketId) {
  const r = await fetch(`${base}/match2/v1/namespaces/${namespace}/match-tickets/${ticketId}`, {
    headers: { Authorization: 'Bearer ' + token },
  })
  if (r.status === 404) return { notFound: true }
  if (!r.ok) throw new Error(`get ticket failed: ${r.status}`)
  return r.json()
}

export async function deleteMatchTicket(token, ticketId) {
  try {
    await fetch(`${base}/match2/v1/namespaces/${namespace}/match-tickets/${ticketId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    })
  } catch {}
}

// Returns the game session, including members [{ id, ... }].
export async function getGameSession(token, sessionId) {
  const r = await fetch(`${base}/session/v1/public/namespaces/${namespace}/gamesessions/${sessionId}`, {
    headers: { Authorization: 'Bearer ' + token },
  })
  if (!r.ok) throw new Error(`get session failed: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

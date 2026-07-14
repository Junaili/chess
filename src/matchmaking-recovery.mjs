export const MATCH_SESSION_CLOCK_SKEW_MS = 15_000

function decodeBase64Utf8(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = globalThis.atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function parseNotificationPayload(payload) {
  if (!payload) return null
  if (typeof payload === 'object') return payload
  const value = String(payload).trim()
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {}
  try {
    return JSON.parse(decodeBase64Utf8(value))
  } catch {
    return null
  }
}

export function parseMatchFoundNotification(message) {
  if (message?.type !== 'messageNotif' || message?.topic !== 'OnMatchFound') return null
  const payload = parseNotificationPayload(message.payload)
  const sessionId = String(payload?.ID || payload?.id || payload?.SessionID || payload?.sessionID || '')
  if (!sessionId) return null

  const teams = Array.isArray(payload?.Teams) ? payload.Teams : []
  const tickets = Array.isArray(payload?.Tickets) ? payload.Tickets : []
  return {
    sessionId,
    matchPool: String(payload?.MatchPool || payload?.matchPool || ''),
    createdAt: payload?.CreatedAt || payload?.createdAt || message.sentAt || '',
    memberUserIds: teams.flatMap(team => team?.UserIDs || team?.userIDs || []).filter(Boolean),
    ticketIds: tickets
      .map(ticket => ticket?.TicketID || ticket?.ticketID || ticket?.ticketId)
      .filter(Boolean),
  }
}

export function isNotificationForTicket(
  notification,
  ticketId,
  matchPool,
  startedAt = 0,
  clockSkewMs = MATCH_SESSION_CLOCK_SKEW_MS,
) {
  if (!notification?.sessionId || notification.matchPool !== matchPool) return false
  const tickets = notification.ticketIds || []
  if (tickets.length > 0) return tickets.includes(ticketId)
  const createdAt = Date.parse(notification.createdAt || '')
  return Number.isFinite(createdAt) && createdAt >= Number(startedAt || 0) - clockSkewMs
}

export function selectRecentMatchSession(
  sessions,
  { matchPool, startedAt, clockSkewMs = MATCH_SESSION_CLOCK_SKEW_MS } = {},
) {
  const earliest = Number(startedAt || 0) - clockSkewMs
  return (Array.isArray(sessions) ? sessions : [])
    .filter(session => {
      const createdAt = Date.parse(session?.createdAt || '')
      return session?.matchPool === matchPool
        && session?.isActive !== false
        && Array.isArray(session?.members)
        && session.members.filter(member => member?.id).length >= 2
        && Number.isFinite(createdAt)
        && createdAt >= earliest
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null
}

function required(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

export function normalizeBlockedPlayers(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.blockedUsers)
        ? payload.blockedUsers
        : []

  return rows
    .map(row => ({
      userId: String(row?.blockedUserId || row?.userId || '').trim(),
      blockedAt: row?.blockedAt || '',
    }))
    .filter(row => row.userId)
}

export function buildChatReport({ userId, reason, comment = '', message }) {
  const chatId = required(message?.chatId, 'Chat ID')
  const topicId = required(message?.topicId, 'Chat topic ID')
  const createdAtValue = message?.createdAt
  const createdAt = typeof createdAtValue === 'number'
    ? new Date(createdAtValue).toISOString()
    : required(createdAtValue, 'Chat creation time')

  return {
    category: 'CHAT',
    userId: required(userId || message?.from, 'Reported user ID'),
    reason: required(reason, 'Report reason'),
    ...(String(comment || '').trim() ? { comment: String(comment).trim() } : {}),
    objectId: chatId,
    objectType: 'chat',
    additionalInfo: {
      topicId,
      chatCreatedAt: createdAt,
    },
  }
}

export function buildUserReport({ userId, reason, comment = '' }) {
  return {
    category: 'USER',
    userId: required(userId, 'Reported user ID'),
    reason: required(reason, 'Report reason'),
    ...(String(comment || '').trim() ? { comment: String(comment).trim() } : {}),
  }
}

// The Reporting service can return either ticketId or ticketID depending on
// endpoint/version. Keep the user-facing receipt tied to AGS's ticket, rather
// than creating a second application-owned report identifier.
export function getReportTicketId(payload) {
  const candidates = [
    payload?.ticketId,
    payload?.ticketID,
    payload?.ticket?.id,
    payload?.data?.ticketId,
  ]
  return candidates.map(value => String(value || '').trim()).find(Boolean) || ''
}

export function getSafetyError(error, fallback = 'The safety action could not be completed.') {
  const status = error?.response?.status
  const data = error?.response?.data
  if (status === 409) return 'You already reported this item.'
  if (status === 429) return 'Too many reports. Please wait and try again.'

  const message = data?.errorMessage || data?.message || data?.error || error?.message
  if (!status && /^(network error|failed to fetch|load failed)$/i.test(String(message || '').trim())) {
    return fallback
  }
  return message || fallback
}

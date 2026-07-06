export function classifyFriendRelationship(userId, relationshipState = {}) {
  return [
    ['friends', 'friends'],
    ['incoming', 'incoming'],
    ['outgoing', 'outgoing'],
  ].find(([key]) => relationshipState[key]?.some(item => item.userId === userId))?.[1] || ''
}

function errorDetails(error) {
  const data = error?.response?.data
  return {
    status: Number(error?.response?.status || error?.status || 0),
    code: String(data?.errorCode || data?.code || error?.code || ''),
    text: String(data?.message || data?.errorMessage || data?.error || error?.message || '').toLowerCase(),
  }
}

export function normalizeFriendsError(error, fallback = 'Something went wrong. Please try again.') {
  const { status, code, text } = errorDetails(error)

  if (status === 401 || text.includes('unauthorized') || text.includes('token expired')) {
    return { reason: 'authentication', error: 'Your session expired. Sign in again to continue.' }
  }
  if (status === 429 || text.includes('rate limit') || text.includes('too many')) {
    return { reason: 'rate_limited', error: 'Too many attempts. Wait a moment, then try again.' }
  }
  if (status === 403 || text.includes('blocked') || text.includes('not allowed')) {
    return { reason: 'not_allowed', error: 'This friend request cannot be sent.' }
  }
  if (status === 409 || text.includes('already friend') || text.includes('already sent') || text.includes('request already')) {
    return { reason: 'already_pending', error: 'A friend request already exists for this player.' }
  }
  if (status >= 500 || status === 0 || code === 'ECONNABORTED' || text.includes('network')) {
    return { reason: 'unavailable', error: 'Friends service is unavailable. Check your connection and try again.' }
  }
  return { reason: 'unknown', error: fallback }
}

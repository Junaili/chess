const test = require('node:test')
const assert = require('node:assert/strict')

test('classifies loaded friend relationships', async () => {
  const { classifyFriendRelationship } = await import('../../src/friend-feedback.mjs')
  const state = {
    friends: [{ userId: 'friend' }],
    incoming: [{ userId: 'incoming' }],
    outgoing: [{ userId: 'outgoing' }],
  }

  assert.equal(classifyFriendRelationship('friend', state), 'friends')
  assert.equal(classifyFriendRelationship('incoming', state), 'incoming')
  assert.equal(classifyFriendRelationship('outgoing', state), 'outgoing')
  assert.equal(classifyFriendRelationship('new-player', state), '')
})

test('maps friend API failures to safe actionable messages', async () => {
  const { normalizeFriendsError } = await import('../../src/friend-feedback.mjs')
  const cases = [
    [401, 'authentication', 'session expired'],
    [403, 'not_allowed', 'cannot be sent'],
    [409, 'already_pending', 'already exists'],
    [429, 'rate_limited', 'Too many attempts'],
    [503, 'unavailable', 'unavailable'],
  ]

  for (const [status, reason, message] of cases) {
    const result = normalizeFriendsError({
      response: { status, data: { errorMessage: 'Sensitive backend detail' } },
    })
    assert.equal(result.reason, reason)
    assert.match(result.error, new RegExp(message, 'i'))
    assert.doesNotMatch(result.error, /Sensitive backend detail/)
  }
})

test('uses the safe caller fallback for unknown server errors', async () => {
  const { normalizeFriendsError } = await import('../../src/friend-feedback.mjs')
  const result = normalizeFriendsError(
    { response: { status: 400, data: { errorMessage: 'Raw AGS error' } } },
    'Could not send the friend request. Please try again.',
  )

  assert.deepEqual(result, {
    reason: 'unknown',
    error: 'Could not send the friend request. Please try again.',
  })
})

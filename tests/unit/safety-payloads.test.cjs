const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const safetyPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'safety-payloads.mjs')
))

test('builds an AGS CHAT report with moderation evidence', async () => {
  const { buildChatReport } = await safetyPromise
  const payload = buildChatReport({
    userId: 'opponent-1',
    reason: 'Harassment',
    comment: 'Repeated insults',
    message: {
      chatId: 'chat-123',
      topicId: 's.session-456',
      from: 'opponent-1',
      createdAt: Date.UTC(2026, 6, 2, 12, 30),
    },
  })

  assert.deepEqual(payload, {
    category: 'CHAT',
    userId: 'opponent-1',
    reason: 'Harassment',
    comment: 'Repeated insults',
    objectId: 'chat-123',
    objectType: 'chat',
    additionalInfo: {
      topicId: 's.session-456',
      chatCreatedAt: '2026-07-02T12:30:00.000Z',
    },
  })
})

test('rejects a CHAT report when evidence identifiers are absent', async () => {
  const { buildChatReport } = await safetyPromise
  assert.throws(
    () => buildChatReport({ userId: 'opponent-1', reason: 'Spam', message: {} }),
    /Chat ID is required/
  )
})

test('normalizes AGS Lobby blocked-player responses', async () => {
  const { normalizeBlockedPlayers } = await safetyPromise
  assert.deepEqual(
    normalizeBlockedPlayers({
      data: [
        { blockedUserId: 'blocked-a', blockedAt: '2026-07-02T00:00:00Z' },
        { blockedUserId: '' },
      ],
    }),
    [{ userId: 'blocked-a', blockedAt: '2026-07-02T00:00:00Z' }]
  )
})

test('uses the AGS reporting ticket as the player report reference', async () => {
  const { getReportTicketId } = await safetyPromise
  assert.equal(getReportTicketId({ ticketId: 'ticket-123' }), 'ticket-123')
  assert.equal(getReportTicketId({ ticket: { id: 'ticket-456' } }), 'ticket-456')
  assert.equal(getReportTicketId({}), '')
})

test('does not expose raw browser transport errors to the safety UI', async () => {
  const { getSafetyError } = await safetyPromise

  assert.equal(
    getSafetyError(new Error('Network Error'), 'Could not load report reasons.'),
    'Could not load report reasons.'
  )
  assert.equal(
    getSafetyError(new TypeError('Failed to fetch'), 'Could not report this player.'),
    'Could not report this player.'
  )
})

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const contractPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'account-deletion-contract.mjs')
))

test('requires the exact DELETE confirmation', async () => {
  const { validateDeletionConfirmation } = await contractPromise
  assert.equal(validateDeletionConfirmation('DELETE'), true)
  assert.equal(validateDeletionConfirmation('delete'), false)
  assert.equal(validateDeletionConfirmation(' DELETE '), false)
})

test('includes an Apple authorization code only when supplied', async () => {
  const { buildDeletionRequest } = await contractPromise
  assert.deepEqual(
    buildDeletionRequest({ confirmation: 'DELETE' }),
    { confirmation: 'DELETE' }
  )
  assert.deepEqual(
    buildDeletionRequest({
      confirmation: 'DELETE',
      appleAuthorizationCode: 'one-time-code',
    }),
    {
      confirmation: 'DELETE',
      appleAuthorizationCode: 'one-time-code',
    }
  )
  assert.throws(
    () => buildDeletionRequest({ confirmation: 'delete' }),
    /Type DELETE/
  )
})

// ── Pending-deletion copy (AGS grace period) ─────────────────────────────────

test('describePendingDeletion returns null when nothing is scheduled', async () => {
  const { describePendingDeletion } = await contractPromise
  assert.equal(describePendingDeletion(null), null)
  assert.equal(describePendingDeletion({ pending: false }), null)
  assert.equal(describePendingDeletion({ pending: false, executionDate: '2026-09-02T00:00:00Z' }), null)
})

test('describePendingDeletion counts the days left in the grace period', async () => {
  const { describePendingDeletion } = await contractPromise
  const now = new Date('2026-08-05T00:00:00Z')
  const result = describePendingDeletion(
    { pending: true, executionDate: '2026-09-02T00:00:00Z' }, now)
  assert.equal(result.daysRemaining, 28)
  assert.match(result.detail, /28 days away/)
  assert.match(result.detail, /keep your account/)
})

test('describePendingDeletion says "1 day", not "1 days"', async () => {
  const { describePendingDeletion } = await contractPromise
  const now = new Date('2026-09-01T00:00:00Z')
  const result = describePendingDeletion(
    { pending: true, executionDate: '2026-09-02T00:00:00Z' }, now)
  assert.equal(result.daysRemaining, 1)
  assert.match(result.detail, /1 day away/)
})

// AGS sends the zero time for "no date recorded" — rendering it naively would
// tell the player their account is being deleted in the year 1.
test('describePendingDeletion still reports a pending deletion with no usable date', async () => {
  const { describePendingDeletion } = await contractPromise
  for (const executionDate of ['0001-01-01T00:00:00Z', '', 'not-a-date']) {
    const result = describePendingDeletion({ pending: true, executionDate })
    assert.ok(result, `expected a pending description for ${JSON.stringify(executionDate)}`)
    assert.equal(result.executionDate, null)
    assert.equal(result.daysRemaining, null)
    assert.match(result.detail, /scheduled for deletion/)
    assert.doesNotMatch(result.detail, /0001|NaN|Invalid/)
  }
})

test('describePendingDeletion never reports negative days once the date passes', async () => {
  const { describePendingDeletion } = await contractPromise
  const now = new Date('2026-10-01T00:00:00Z')
  const result = describePendingDeletion(
    { pending: true, executionDate: '2026-09-02T00:00:00Z' }, now)
  assert.equal(result.daysRemaining, 0)
  assert.doesNotMatch(result.detail, /-\d/)
})

// ── Self-service credentials ─────────────────────────────────────────────────
// AGS authenticates the deletion as the player, so the request carries their
// own credential. Omitting empty ones keeps the payload minimal.

test('buildDeletionRequest carries a password when one is supplied', async () => {
  const { buildDeletionRequest } = await contractPromise
  const body = buildDeletionRequest({ confirmation: 'DELETE', password: 'hunter2' })
  assert.equal(body.password, 'hunter2')
  assert.equal('platformToken' in body, false)
})

test('buildDeletionRequest carries the platform token for Apple accounts', async () => {
  const { buildDeletionRequest } = await contractPromise
  const body = buildDeletionRequest({
    confirmation: 'DELETE',
    appleAuthorizationCode: 'one-time-code',
    platformId: 'apple',
    platformToken: 'identity-token',
  })
  // The code and the token are different things and both must survive: the code
  // revokes the Apple grant, the token authenticates the deletion.
  assert.equal(body.appleAuthorizationCode, 'one-time-code')
  assert.equal(body.platformId, 'apple')
  assert.equal(body.platformToken, 'identity-token')
})

test('buildDeletionRequest omits empty credentials entirely', async () => {
  const { buildDeletionRequest } = await contractPromise
  const body = buildDeletionRequest({ confirmation: 'DELETE' })
  for (const key of ['password', 'platformId', 'platformToken', 'appleAuthorizationCode']) {
    assert.equal(key in body, false, `${key} should be omitted when empty`)
  }
})

test('buildDeletionRequest still refuses a wrong confirmation', async () => {
  const { buildDeletionRequest } = await contractPromise
  assert.throws(() => buildDeletionRequest({ confirmation: 'delete', password: 'hunter2' }))
})

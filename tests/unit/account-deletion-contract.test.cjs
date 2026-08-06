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

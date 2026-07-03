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

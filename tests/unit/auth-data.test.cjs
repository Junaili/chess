const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.resolve(__dirname, '../../src/auth-data.mjs'),
))

test('builds an AGS-safe alphanumeric username from a display name', async () => {
  const { buildUsername } = await modulePromise
  const username = buildUsername(
    'Seal QA Test 1',
    'seal.jun.fani+test1@gmail.com',
    Uint8Array.from([1, 2, 3, 4]),
  )

  assert.match(username, /^[a-z][a-z0-9]{1,31}$/)
  assert.equal(username, 'sealqatest1010203')
})

test('prefixes usernames whose source does not begin with a letter', async () => {
  const { buildUsername } = await modulePromise
  const username = buildUsername('123 ♟', '', Uint8Array.from([35, 35, 35, 35]))

  assert.match(username, /^player123/)
  assert.match(username, /^[a-z0-9]+$/)
  assert.ok(username.length <= 32)
})

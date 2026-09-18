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

test('treats Apple error 1001 as a cancellation, not a failure', async () => {
  const { isAppleCancellation, APPLE_ERROR_CANCELED } = await modulePromise

  // What @capacitor-community/apple-sign-in actually rejects with: Apple's raw
  // NSError description, no structured code.
  assert.equal(isAppleCancellation({
    message: "The operation couldn't be completed. "
      + '(com.apple.AuthenticationServices.AuthorizationError error 1001.)',
  }), true)

  assert.equal(APPLE_ERROR_CANCELED, 1001)
})

test('does not mistake other Apple authorization errors for cancellation', async () => {
  const { isAppleCancellation } = await modulePromise

  // 1000 is `unknown` - a real failure the player should hear about.
  assert.equal(isAppleCancellation({
    message: "The operation couldn't be completed. "
      + '(com.apple.AuthenticationServices.AuthorizationError error 1000.)',
  }), false)

  assert.equal(isAppleCancellation({ message: 'Network request timed out' }), false)
  assert.equal(isAppleCancellation(null), false)
  assert.equal(isAppleCancellation({}), false)
})

test('reads a structured Apple error code when the plugin provides one', async () => {
  const { isAppleCancellation, appleAuthorizationCode } = await modulePromise

  assert.equal(isAppleCancellation({ code: 1001 }), true)
  assert.equal(isAppleCancellation({ code: '1001' }), true)
  assert.equal(appleAuthorizationCode({ code: 1004 }), 1004)
  // A non-numeric Capacitor code must not be read as an error number.
  assert.equal(appleAuthorizationCode({ code: 'UNIMPLEMENTED' }), null)
})

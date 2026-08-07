const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'lobby-liveness.mjs')
))

// The bug this guards: browsers do not throw when send() runs on a CLOSING or
// CLOSED socket — they log "WebSocket is already in CLOSING or CLOSED state"
// and drop the frame. A try/catch around the send cannot catch that, so the
// only defence is refusing to send in the first place.
test('refuses to send on a CLOSING or CLOSED socket', async () => {
  const { canSendOnSocket, WS_CLOSING, WS_CLOSED } = await modulePromise
  assert.equal(canSendOnSocket({ readyState: WS_CLOSING }, true), false)
  assert.equal(canSendOnSocket({ readyState: WS_CLOSED }, true), false)
  // Even when our own connection flag still says "connected" — that flag stays
  // true from the moment the socket starts closing until onClose runs, which is
  // exactly the window the error appeared in.
})

test('refuses to send while still CONNECTING', async () => {
  const { canSendOnSocket, WS_CONNECTING } = await modulePromise
  assert.equal(canSendOnSocket({ readyState: WS_CONNECTING }, true), false)
})

test('allows a send on an OPEN socket', async () => {
  const { canSendOnSocket, WS_OPEN } = await modulePromise
  assert.equal(canSendOnSocket({ readyState: WS_OPEN }, false), true)
})

// If the SDK ever stops letting us capture the native socket, degrade to the
// previous behaviour rather than blocking every send forever.
test('falls back to the connection flag when no native socket was captured', async () => {
  const { canSendOnSocket } = await modulePromise
  assert.equal(canSendOnSocket(null, true), true)
  assert.equal(canSendOnSocket(null, false), false)
  assert.equal(canSendOnSocket(undefined, true), true)
  // A socket-shaped object with no usable readyState is the same situation.
  assert.equal(canSendOnSocket({}, true), true)
  assert.equal(canSendOnSocket({ readyState: 'open' }, false), false)
})

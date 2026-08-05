const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'bot-identity.mjs')
))

// The module reads window; node:test has no DOM.
function withWindow(fn) {
  const had = 'window' in globalThis
  const previous = globalThis.window
  globalThis.window = {}
  try {
    return fn(globalThis.window)
  } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

const ROSTER = [
  { id: 'gambit-gus', userId: 'gus-account-id', name: 'Gambit Gus' },
  { id: 'fortress-fiona', userId: 'fiona-account-id', name: 'Fortress Fiona' },
]

test('recognises every bot in the roster by account id', async () => {
  const { setBotIdentities, isBotIdentity } = await modulePromise
  withWindow(() => {
    setBotIdentities(ROSTER)
    assert.equal(isBotIdentity('gus-account-id'), true)
    // The whole point of per-bot accounts: the second bot must be recognised too.
    assert.equal(isBotIdentity('fiona-account-id'), true)
    assert.equal(isBotIdentity('a-real-player'), false)
  })
})

test('recognises bots by slug and by display name', async () => {
  const { setBotIdentities, isBotIdentity } = await modulePromise
  withWindow(() => {
    setBotIdentities(ROSTER)
    // Legacy match history stores the slug rather than an account id.
    assert.equal(isBotIdentity('fortress-fiona'), true)
    // A peer game reveals the name over the data channel before any AGS id.
    assert.equal(isBotIdentity('', 'Fortress Fiona'), true)
    assert.equal(isBotIdentity('', '  fortress fiona  '), true)
    assert.equal(isBotIdentity('', 'Fiona'), false)
  })
})

test('falls back to the default bot before the roster loads', async () => {
  const { isBotIdentity } = await modulePromise
  withWindow(win => {
    win.agsGambitGusUserId = 'gus-account-id'
    win.agsGambitGusName = 'Gambit Gus'
    // A slow roster fetch must never make a bot look like a human.
    assert.equal(isBotIdentity('gus-account-id'), true)
    assert.equal(isBotIdentity('gambit-gus'), true)
    assert.equal(isBotIdentity('', 'Gambit Gus'), true)
    assert.equal(isBotIdentity('a-real-player'), false)
  })
})

test('keeps the legacy Gus globals published for older readers', async () => {
  const { setBotIdentities, clearBotIdentities } = await modulePromise
  withWindow(win => {
    setBotIdentities(ROSTER)
    assert.equal(win.agsGambitGusUserId, 'gus-account-id')
    assert.equal(win.agsGambitGusName, 'Gambit Gus')
    clearBotIdentities()
    assert.deepEqual(win.agsBotIdentities, [])
    assert.equal(win.agsGambitGusUserId, '')
  })
})

test('an empty or malformed roster does not throw', async () => {
  const { setBotIdentities, isBotIdentity } = await modulePromise
  withWindow(() => {
    setBotIdentities(null)
    assert.equal(isBotIdentity('anyone'), false)
    setBotIdentities([{}, { id: '' }, null])
    assert.equal(isBotIdentity('anyone'), false)
  })
})

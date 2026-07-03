const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const moderationPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'content-moderation.mjs')
))

test('allows ordinary display names and chat', async () => {
  const moderation = await moderationPromise

  assert.deepEqual(
    moderation.validateDisplayNameLocally('Ethan Chess'),
    { ok: true, value: 'Ethan Chess' }
  )
  assert.deepEqual(
    moderation.moderateOutgoingChat('Good game!'),
    { ok: true, value: 'Good game!' }
  )
})

test('rejects profanity in display names, including obfuscated text', async () => {
  const moderation = await moderationPromise

  assert.equal(moderation.validateDisplayNameLocally('fuuuuuck').ok, false)
  assert.equal(moderation.validateDisplayNameLocally('f.u.c.k').ok, false)
})

test('blocks outgoing profanity and hides it when received from older clients', async () => {
  const moderation = await moderationPromise

  assert.equal(moderation.moderateOutgoingChat('fuck you').ok, false)
  assert.equal(
    moderation.moderateIncomingChat('fuck you'),
    moderation.HIDDEN_CHAT_MESSAGE
  )
  assert.equal(moderation.moderateIncomingDisplayName('fuck', 'Opponent'), 'Opponent')
})

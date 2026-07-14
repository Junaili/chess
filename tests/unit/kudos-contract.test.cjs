const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const contractPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'kudos-contract.mjs')
))

test('highFiveTxKey matches the server dedupe key format exactly', async () => {
  const { highFiveTxKey } = await contractPromise
  assert.equal(highFiveTxKey('match-1', 'sender-1'), 'hf:match-1:sender-1')
})

test('deriveHighFiveButton: hidden outside online games', async () => {
  const { deriveHighFiveButton } = await contractPromise
  const result = deriveHighFiveButton({ gameMode: 'computer', senderId: 'me', recipientUserId: 'them', coins: 100 })
  assert.equal(result.visible, false)
})

test('deriveHighFiveButton: hidden for guest opponents (no recipientUserId)', async () => {
  const { deriveHighFiveButton } = await contractPromise
  const result = deriveHighFiveButton({ gameMode: 'online', senderId: 'me', recipientUserId: '', coins: 100 })
  assert.equal(result.visible, false)
})

test('deriveHighFiveButton: hidden vs the bot', async () => {
  const { deriveHighFiveButton } = await contractPromise
  const result = deriveHighFiveButton({ gameMode: 'online', senderId: 'me', recipientUserId: 'gambit-gus', isBot: true, coins: 100 })
  assert.equal(result.visible, false)
})

test('deriveHighFiveButton: hidden for a blocked opponent', async () => {
  const { deriveHighFiveButton } = await contractPromise
  const result = deriveHighFiveButton({ gameMode: 'online', senderId: 'me', recipientUserId: 'them', isBlocked: true, coins: 100 })
  assert.equal(result.visible, false)
})

test('deriveHighFiveButton: hidden when sender === recipient (defensive, should never happen)', async () => {
  const { deriveHighFiveButton } = await contractPromise
  const result = deriveHighFiveButton({ gameMode: 'online', senderId: 'me', recipientUserId: 'me', coins: 100 })
  assert.equal(result.visible, false)
})

test('deriveHighFiveButton: eligible and enabled with enough coins', async () => {
  const { deriveHighFiveButton } = await contractPromise
  const result = deriveHighFiveButton({ gameMode: 'online', senderId: 'me', recipientUserId: 'them', coins: 10 })
  assert.equal(result.visible, true)
  assert.equal(result.disabled, false)
  assert.match(result.label, /10 🪙/)
})

test('deriveHighFiveButton: visible but disabled with insufficient coins', async () => {
  const { deriveHighFiveButton } = await contractPromise
  const result = deriveHighFiveButton({ gameMode: 'online', senderId: 'me', recipientUserId: 'them', coins: 4 })
  assert.equal(result.visible, true)
  assert.equal(result.disabled, true)
  assert.match(result.label, /need 10/)
})

test('deriveHighFiveButton: visible but disabled and relabeled once already sent', async () => {
  const { deriveHighFiveButton } = await contractPromise
  const result = deriveHighFiveButton({ gameMode: 'online', senderId: 'me', recipientUserId: 'them', coins: 100, alreadySent: true })
  assert.equal(result.visible, true)
  assert.equal(result.disabled, true)
  assert.match(result.label, /sent/)
})

test('insufficientCoinsMessage reports the friendly, exact-balance copy', async () => {
  const { insufficientCoinsMessage } = await contractPromise
  assert.equal(insufficientCoinsMessage(4), 'Not enough coins — you have 4 🪙')
  assert.equal(insufficientCoinsMessage(0), 'Not enough coins — you have 0 🪙')
  assert.equal(insufficientCoinsMessage(undefined), 'Not enough coins — you have 0 🪙')
})

test('formatKudosCount renders a plain localized number', async () => {
  const { formatKudosCount } = await contractPromise
  assert.equal(formatKudosCount(0), '0')
  assert.equal(formatKudosCount(7), '7')
  assert.equal(formatKudosCount(1234), '1,234')
  assert.equal(formatKudosCount(undefined), '0')
})

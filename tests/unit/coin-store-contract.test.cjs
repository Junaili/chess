const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const contractPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'coin-store-contract.mjs')
))

const WALNUT = { itemId: 'i-walnut', sku: 'cos-board-walnut', localizations: { en: { title: 'Walnut Board', description: 'A warm walnut wood board theme.' } }, regionData: [{ price: 300 }] }
const DINO = { itemId: 'i-dino', sku: 'cos-pieces-dino', localizations: { en: { title: 'Dinosaur Pieces', description: 'Chess pieces reimagined as dinosaurs.' } }, regionData: [{ price: 500 }] }
const CONFETTI = { itemId: 'i-confetti', sku: 'cos-victory-confetti', localizations: { en: { title: 'Confetti Victory', description: 'A confetti burst when you win.' } }, regionData: [{ price: 150 }] }
const FOUNDER = { itemId: 'i-founder', sku: 'cos-flair-founder', localizations: { en: { title: 'Club Founder Flair', description: 'A badge marking you as an early Club member.' } }, regionData: [{ price: 150 }] }

test('deriveEquipSlot maps each SKU prefix to its slot', async () => {
  const { deriveEquipSlot } = await contractPromise
  assert.equal(deriveEquipSlot('cos-board-walnut'), 'boardTheme')
  assert.equal(deriveEquipSlot('cos-pieces-dino'), 'pieceSet')
  assert.equal(deriveEquipSlot('cos-victory-confetti'), 'victoryFx')
  assert.equal(deriveEquipSlot('cos-flair-founder'), 'flair')
  assert.equal(deriveEquipSlot('club-individual-monthly'), null)
  assert.equal(deriveEquipSlot(''), null)
  assert.equal(deriveEquipSlot(undefined), null)
})

test('slotValueFromSku strips the slot prefix', async () => {
  const { slotValueFromSku } = await contractPromise
  assert.equal(slotValueFromSku('cos-board-walnut'), 'walnut')
  assert.equal(slotValueFromSku('cos-pieces-dino'), 'dino')
  assert.equal(slotValueFromSku('club-individual-monthly'), '')
})

test('normalizeCosmeticsRecord tolerates junk and fills defaults', async () => {
  const { normalizeCosmeticsRecord, DEFAULT_COSMETICS_RECORD } = await contractPromise
  assert.deepEqual(normalizeCosmeticsRecord(null), DEFAULT_COSMETICS_RECORD)
  assert.deepEqual(normalizeCosmeticsRecord(undefined), DEFAULT_COSMETICS_RECORD)
  assert.deepEqual(normalizeCosmeticsRecord('garbage'), DEFAULT_COSMETICS_RECORD)
  assert.deepEqual(normalizeCosmeticsRecord({ boardTheme: 'walnut', extra: 'ignored' }),
    { boardTheme: 'walnut', pieceSet: '', victoryFx: '', flair: '' })
  assert.deepEqual(normalizeCosmeticsRecord({ boardTheme: 5 }), DEFAULT_COSMETICS_RECORD)
})

test('deriveCosmeticCard: not owned, affordable -> Buy', async () => {
  const { deriveCosmeticCard } = await contractPromise
  const card = deriveCosmeticCard(WALNUT, { ownedSkus: [], coins: 300 })
  assert.equal(card.owned, false)
  assert.equal(card.affordable, true)
  assert.equal(card.ctaLabel, 'Buy')
  assert.equal(card.ctaAction, 'buy')
  assert.equal(card.ctaDisabled, false)
  assert.equal(card.price, 300)
  assert.equal(card.slot, 'boardTheme')
})

test('deriveCosmeticCard: not owned, insufficient balance -> disabled with a friendly label', async () => {
  const { deriveCosmeticCard } = await contractPromise
  const card = deriveCosmeticCard(DINO, { ownedSkus: [], coins: 100 })
  assert.equal(card.affordable, false)
  assert.equal(card.ctaLabel, 'Not enough coins')
  assert.equal(card.ctaDisabled, true)
})

test('deriveCosmeticCard: owned but not equipped -> Equip', async () => {
  const { deriveCosmeticCard } = await contractPromise
  const card = deriveCosmeticCard(WALNUT, {
    ownedSkus: ['cos-board-walnut'],
    equipped: { boardTheme: 'galaxy', pieceSet: '', victoryFx: '', flair: '' },
    coins: 0,
  })
  assert.equal(card.owned, true)
  assert.equal(card.isEquipped, false)
  assert.equal(card.ctaLabel, 'Equip')
  assert.equal(card.ctaAction, 'equip')
})

test('deriveCosmeticCard: owned and equipped -> Equipped, unequip action', async () => {
  const { deriveCosmeticCard } = await contractPromise
  const card = deriveCosmeticCard(WALNUT, {
    ownedSkus: ['cos-board-walnut'],
    equipped: { boardTheme: 'walnut', pieceSet: '', victoryFx: '', flair: '' },
    coins: 0,
  })
  assert.equal(card.isEquipped, true)
  assert.equal(card.ctaLabel, '✓ Equipped')
  assert.equal(card.ctaAction, 'unequip')
})

test('sortCosmetics: equipped first, then owned, then affordable, then locked; cheapest first within a group', async () => {
  const { deriveCosmeticCard, sortCosmetics } = await contractPromise
  const equipped = { boardTheme: '', pieceSet: '', victoryFx: 'confetti', flair: '' }
  const cards = [
    deriveCosmeticCard(DINO, { ownedSkus: [], coins: 100, equipped }),       // locked (not affordable)
    deriveCosmeticCard(WALNUT, { ownedSkus: [], coins: 1000, equipped }),    // affordable
    deriveCosmeticCard(CONFETTI, { ownedSkus: ['cos-victory-confetti'], coins: 0, equipped }), // equipped
    deriveCosmeticCard(FOUNDER, { ownedSkus: ['cos-flair-founder'], coins: 0, equipped }),     // owned, not equipped
  ]
  const sorted = sortCosmetics(cards)
  assert.deepEqual(sorted.map(c => c.sku), [
    'cos-victory-confetti', // equipped
    'cos-flair-founder',    // owned
    'cos-board-walnut',     // affordable
    'cos-pieces-dino',      // locked
  ])
})

test('insufficientBalanceMessage reports exactly how many more coins are needed', async () => {
  const { deriveCosmeticCard, insufficientBalanceMessage } = await contractPromise
  const card = deriveCosmeticCard(DINO, { ownedSkus: [], coins: 460 })
  assert.equal(insufficientBalanceMessage(card, 460), 'You need 40 more coins for Dinosaur Pieces.')
  const almost = deriveCosmeticCard(CONFETTI, { ownedSkus: [], coins: 149 })
  assert.equal(insufficientBalanceMessage(almost, 149), 'You need 1 more coin for Confetti Victory.')
})

test('itemRegionData handles both API shapes: public bare array and admin US-keyed map', async () => {
  const { itemRegionData } = await contractPromise
  // Public items/byCriteria (what the store actually fetches) — bare array.
  assert.equal(itemRegionData({ regionData: [{ price: 150, currencyCode: 'ETHC' }] }).price, 150)
  // Admin variant — region-keyed map.
  assert.equal(itemRegionData({ regionData: { US: [{ price: 300 }] } }).price, 300)
  assert.equal(itemRegionData({}), undefined)
  assert.equal(itemRegionData(null), undefined)
})

test('deriveCosmeticCard prices from the public bare-array regionData (regression: price read as 0)', async () => {
  const { deriveCosmeticCard } = await contractPromise
  const item = { sku: 'cos-flair-founder', regionData: [{ price: 150, currencyCode: 'ETHC' }] }
  const broke = deriveCosmeticCard(item, { ownedSkus: [], coins: 50 })
  assert.equal(broke.price, 150)
  assert.equal(broke.ctaDisabled, true)
  const funded = deriveCosmeticCard(item, { ownedSkus: [], coins: 150 })
  assert.equal(funded.ctaDisabled, false)
})

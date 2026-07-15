const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const contractPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'club-contract.mjs')
))

test('formatCoins renders thousands separators and the coin glyph', async () => {
  const { formatCoins } = await contractPromise
  assert.equal(formatCoins(299), '299 🪙')
  assert.equal(formatCoins(2999), '2,999 🪙')
  assert.equal(formatCoins(0), '0 🪙')
  assert.equal(formatCoins(undefined), '0 🪙')
})

test('isSkuCoveredByStatus: family membership covers individual SKUs', async () => {
  const { isSkuCoveredByStatus } = await contractPromise
  const status = { active: true, tier: 'family', lifetime: false, activeSkus: ['club-family-monthly'] }
  assert.equal(isSkuCoveredByStatus('club-individual-monthly', status), true)
  assert.equal(isSkuCoveredByStatus('club-individual-lifetime', status), true)
  assert.equal(isSkuCoveredByStatus('club-family-monthly', status), true)
  assert.equal(isSkuCoveredByStatus('club-family-lifetime', status), false)
})

test('isSkuCoveredByStatus: lifetime covers the same-tier monthly', async () => {
  const { isSkuCoveredByStatus } = await contractPromise
  const status = { active: true, tier: 'individual', lifetime: true, activeSkus: ['club-individual-lifetime'] }
  assert.equal(isSkuCoveredByStatus('club-individual-monthly', status), true)
  assert.equal(isSkuCoveredByStatus('club-family-monthly', status), false)
})

test('isSkuCoveredByStatus: inactive status covers nothing', async () => {
  const { isSkuCoveredByStatus } = await contractPromise
  const status = { active: false, activeSkus: [] }
  assert.equal(isSkuCoveredByStatus('club-individual-monthly', status), false)
})

test('deriveClubUI: child session never sees purchase UI, regardless of status', async () => {
  const { deriveClubUI } = await contractPromise
  const free = deriveClubUI({ active: false, coins: 40, activeSkus: [] }, { isChildSession: true })
  assert.equal(free.showPurchaseUI, false)
  assert.equal(free.showManageSubscription, false)
  assert.deepEqual(free.buttons, [])
  assert.match(free.message, /Ask your parent/)

  const memberChild = deriveClubUI(
    { active: true, tier: 'family', coins: 40, activeSkus: ['club-family-monthly'] },
    { isChildSession: true },
  )
  assert.equal(memberChild.showPurchaseUI, false)
  assert.deepEqual(memberChild.buttons, [])
  assert.equal(memberChild.badgeVisible, true)
  assert.match(memberChild.message, /Club/)
})

test('deriveClubUI: adult family member with inherited access (source: family-guardian) sees no purchase UI', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI(
    { active: true, tier: 'family', coins: 120, activeSkus: [], source: 'family-guardian', expiresAt: '2026-08-01T00:00:00Z' },
    { isChildSession: false },
  )
  assert.equal(ui.showPurchaseUI, false)
  assert.equal(ui.showManageSubscription, false)
  assert.deepEqual(ui.buttons, [])
  assert.equal(ui.active, true)
  assert.equal(ui.badgeVisible, true)
  assert.equal(ui.tierName, 'Family')
  assert.equal(ui.coinsLabel, '120 🪙')
  assert.match(ui.message, /via your family/)
})

test('deriveClubUI: family-guardian source without active status falls through to normal purchase UI', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI({ active: false, coins: 0, activeSkus: [], source: 'family-guardian' }, {})
  assert.equal(ui.showPurchaseUI, true)
  assert.ok(ui.buttons.length > 0)
})

test('deriveClubUI: native session with the IAP plugin not ready disables purchase buttons', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI({ active: false, coins: 0, activeSkus: [], canPurchase: true }, { isNative: true, nativeIAPReady: false })
  assert.equal(ui.showPurchaseUI, true)
  assert.equal(ui.nativePurchasesUnavailable, true)
  assert.equal(ui.showRestorePurchases, true)
  assert.equal(ui.buttons.length, 4)
  assert.ok(ui.buttons.every(b => b.disabled === true))
})

test('deriveClubUI: native session with the IAP plugin ready enables purchase buttons', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI({ active: false, coins: 0, activeSkus: [], canPurchase: true }, { isNative: true, nativeIAPReady: true })
  assert.equal(ui.nativePurchasesUnavailable, false)
  assert.ok(ui.buttons.every(b => b.disabled === false))
})

test('deriveClubUI: web session never shows Restore Purchases', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI({ active: false, coins: 0, activeSkus: [], canPurchase: true }, {})
  assert.equal(ui.showRestorePurchases, false)
})

test('deriveClubUI: web session shows checkout buttons and manage-subscription for an active Stripe member', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI(
    { active: true, tier: 'individual', lifetime: false, coins: 299, activeSkus: ['club-individual-monthly'], canPurchase: true, monthlyOrigin: 'stripe', expiresAt: '2026-08-11T00:00:00Z' },
    {},
  )
  assert.equal(ui.showPurchaseUI, true)
  assert.equal(ui.showManageSubscription, true)
  assert.equal(ui.active, true)
  assert.equal(ui.expiresAt, '2026-08-11T00:00:00Z')
  const ownButton = ui.buttons.find(b => b.sku === 'club-individual-monthly')
  assert.equal(ownButton.covered, true)
  assert.equal(ownButton.disabled, true)
  const familyButton = ui.buttons.find(b => b.sku === 'club-family-monthly')
  assert.equal(familyButton.covered, false)
  assert.equal(familyButton.disabled, false)
})

test('deriveClubUI: Apple-billed monthly hides web manage-subscription and shows the App Store cancel path', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI(
    { active: true, tier: 'individual', lifetime: false, coins: 299, activeSkus: ['club-individual-monthly'], canPurchase: true, monthlyOrigin: 'apple' },
    {},
  )
  assert.equal(ui.showManageSubscription, false)
})

test('deriveClubUI: lifetime member with a still-active monthly gets the double-subscription cancel notice', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI(
    { active: true, tier: 'individual', lifetime: true, coins: 2999, activeSkus: ['club-individual-lifetime', 'club-individual-monthly'], canPurchase: true, monthlyOrigin: 'stripe' },
    {},
  )
  assert.match(ui.monthlyCancelNotice, /cancel your monthly plan/)
})

test('deriveClubUI: canPurchase false (child-role purchaser edge, or role lookup failure) disables buttons with a reason', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI({ active: false, coins: 0, activeSkus: [], canPurchase: false }, {})
  assert.equal(ui.canPurchase, false)
  assert.ok(ui.buttons.every(b => b.disabled === true))
  assert.match(ui.canPurchaseReason, /parent/)
})

test('journalVisibleEntries: free tier caps history at 5, Club and Open Journal Day are unlimited', async () => {
  const { journalVisibleEntries, JOURNAL_FREE_HISTORY_LIMIT } = await contractPromise
  const entries = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}` }))

  const free = journalVisibleEntries(entries, { hasClub: false, journalOpen: null })
  assert.equal(free.visible.length, JOURNAL_FREE_HISTORY_LIMIT)
  assert.equal(free.lockedCount, 3)
  assert.equal(free.unlimited, false)

  const club = journalVisibleEntries(entries, { hasClub: true, journalOpen: null })
  assert.equal(club.visible.length, 8)
  assert.equal(club.lockedCount, 0)
  assert.equal(club.unlimited, true)

  const openDay = journalVisibleEntries(entries, { hasClub: false, journalOpen: { active: true, label: 'Open Journal Sunday' } })
  assert.equal(openDay.visible.length, 8)
  assert.equal(openDay.unlimited, true)

  const closedDay = journalVisibleEntries(entries, { hasClub: false, journalOpen: { active: false } })
  assert.equal(closedDay.unlimited, false)
})

test('journalVisibleEntries: fewer entries than the cap are all visible with zero locked', async () => {
  const { journalVisibleEntries } = await contractPromise
  const result = journalVisibleEntries([{ id: 'a' }, { id: 'b' }], { hasClub: false, journalOpen: null })
  assert.equal(result.visible.length, 2)
  assert.equal(result.lockedCount, 0)
})

test('narrativeHint: Club member is unlimited', async () => {
  const { narrativeHint } = await contractPromise
  const hint = narrativeHint({ hasClub: true })
  assert.equal(hint.allowed, true)
})

test('narrativeHint: free user with the weekly note already used', async () => {
  const { narrativeHint } = await contractPromise
  const hint = narrativeHint({ hasClub: false, journalOpen: null, narrativesRemainingToday: 0 })
  assert.equal(hint.allowed, false)
  assert.match(hint.label, /used/)
})

test('narrativeHint: free user with the weekly note still available', async () => {
  const { narrativeHint } = await contractPromise
  const hint = narrativeHint({ hasClub: false, journalOpen: null, narrativesRemainingToday: 1 })
  assert.equal(hint.allowed, true)
  assert.match(hint.label, /free Coach Gus note/)
})

test('narrativeHint: Open Journal Day with remaining daily quota', async () => {
  const { narrativeHint } = await contractPromise
  const hint = narrativeHint({
    hasClub: false,
    journalOpen: { active: true, label: 'Open Journal Sunday' },
    narrativesRemainingToday: 2,
  })
  assert.equal(hint.allowed, true)
  assert.match(hint.label, /Open Journal Sunday/)
  assert.match(hint.label, /2 Coach Gus notes left today/)
})

test('narrativeHint: Open Journal Day with quota exhausted', async () => {
  const { narrativeHint } = await contractPromise
  const hint = narrativeHint({
    hasClub: false,
    journalOpen: { active: true, label: 'Open Journal Sunday' },
    narrativesRemainingToday: 0,
  })
  assert.equal(hint.allowed, false)
  assert.match(hint.label, /used up/)
})

// ── M9 lifecycle edges (dev-plan §11) ────────────────────────────────────────

test('deriveClubUI: statusUnreachable disables every purchase button with a try-again-later reason', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI(
    { active: false, coins: 40, activeSkus: [], canPurchase: true },
    { statusUnreachable: true },
  )
  assert.equal(ui.statusUnreachable, true)
  assert.match(ui.statusUnreachableReason, /try again later/)
  for (const button of ui.buttons) assert.equal(button.disabled, true)

  // Reads stay honored: the same stale status still renders normally.
  assert.equal(ui.showPurchaseUI, true)
  assert.equal(ui.coinsLabel, '40 🪙')
})

test('deriveClubUI: reachable status leaves buttons enabled and no unreachable reason', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI({ active: false, coins: 0, activeSkus: [], canPurchase: true }, {})
  assert.equal(ui.statusUnreachable, false)
  assert.equal(ui.statusUnreachableReason, '')
  assert.ok(ui.buttons.some(b => !b.disabled))
})

test('deriveClubUI: active monthly shows the access-until-period-end cancel note', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI(
    { active: true, tier: 'individual', lifetime: false, expiresAt: '2026-08-15T00:00:00Z', activeSkus: ['club-individual-monthly'], monthlyOrigin: 'stripe', coins: 0, canPurchase: true },
    {},
  )
  assert.match(ui.cancelNote, /keep Club until/)
})

test('deriveClubUI: lifetime members get no cancel note', async () => {
  const { deriveClubUI } = await contractPromise
  const ui = deriveClubUI(
    { active: true, tier: 'individual', lifetime: true, activeSkus: ['club-individual-lifetime'], coins: 0, canPurchase: true },
    {},
  )
  assert.equal(ui.cancelNote, '')
})

test('deriveClubUI: Stripe individual monthly shows the cancel-first upgrade note on web, not on native', async () => {
  const { deriveClubUI } = await contractPromise
  const status = { active: true, tier: 'individual', lifetime: false, expiresAt: '2026-08-15T00:00:00Z', activeSkus: ['club-individual-monthly'], monthlyOrigin: 'stripe', coins: 0, canPurchase: true }
  const web = deriveClubUI(status, {})
  assert.match(web.upgradeNote, /Cancel your Individual plan first/)
  // Apple prorates individual→family natively inside the subscription
  // group, so a native session gets no cancel-first instruction.
  const native = deriveClubUI(status, { isNative: true, nativeIAPReady: true })
  assert.equal(native.upgradeNote, '')
  // Apple-billed monthly on web: cancel-first doesn't apply either (the
  // upgrade would happen through the App Store, not Stripe).
  const appleBilled = deriveClubUI({ ...status, monthlyOrigin: 'apple' }, {})
  assert.equal(appleBilled.upgradeNote, '')
  // Family members have nothing to upgrade to.
  const family = deriveClubUI({ ...status, tier: 'family', activeSkus: ['club-family-monthly'] }, {})
  assert.equal(family.upgradeNote, '')
})

test('accountDeletionNotices: Apple subscription and coin-balance warnings (dev-plan §11.8)', async () => {
  const { accountDeletionNotices } = await contractPromise
  const both = accountDeletionNotices({ appleClubSubscriptionActive: true, coinBalance: 415 })
  assert.equal(both.length, 2)
  assert.match(both[0], /NOT cancelled by deleting your account/)
  assert.match(both[0], /Settings → Apple ID → Subscriptions/)
  assert.match(both[1], /415 Ethan Coins will be permanently lost/)

  assert.deepEqual(accountDeletionNotices({ appleClubSubscriptionActive: false, coinBalance: 0 }), [])
  assert.equal(accountDeletionNotices({ coinBalance: 1250 })[0].includes('1,250'), true)
  assert.deepEqual(accountDeletionNotices({}), [])
  assert.deepEqual(accountDeletionNotices(), [])
})

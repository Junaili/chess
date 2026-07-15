// Pure, unit-testable display logic for Ethan's Chess Club (dev-plan
// dev-plan/subscription-coins-implementation-plan.md, Milestone 5). No DOM,
// no fetch, no SDK — everything here is a function of plain data in, plain
// data out. Network/orchestration lives in src/club.js.
//
// SKU table mirrors custom-extend-app/ethan-chess-service/cmd/monetization.go's
// clubSKUs map exactly — keep both in sync when changing prices or coin grants.
// appleId mirrors that same map's AppleID field (App Store Connect product ids,
// dev-plan §4/§6.1) — used to register + order native products (§7.3).
export const CLUB_SKUS = {
  'club-individual-monthly': { label: 'Individual', term: 'Monthly', priceLabel: '$2.99/mo', coins: 299, monthly: true, family: false, appleId: 'io.github.junaili.chess.club.individual.monthly' },
  'club-individual-lifetime': { label: 'Individual', term: 'Lifetime', priceLabel: '$29.99', coins: 2999, monthly: false, family: false, appleId: 'io.github.junaili.chess.club.individual.lifetime' },
  'club-family-monthly': { label: 'Family', term: 'Monthly', priceLabel: '$3.99/mo', coins: 399, monthly: true, family: true, appleId: 'io.github.junaili.chess.club.family.monthly' },
  'club-family-lifetime': { label: 'Family', term: 'Lifetime', priceLabel: '$39.99', coins: 3999, monthly: false, family: true, appleId: 'io.github.junaili.chess.club.family.lifetime' },
}

export const CLUB_SKU_ORDER = [
  'club-individual-monthly',
  'club-individual-lifetime',
  'club-family-monthly',
  'club-family-lifetime',
]

// Free-tier limits (dev-plan §1.2). Writing new journal entries is NEVER
// gated — only history depth and LLM narratives are.
export const JOURNAL_FREE_HISTORY_LIMIT = 5
export const FREE_WEEKLY_NARRATIVES = 1

export function formatCoins(amount) {
  const n = Number(amount) || 0
  return `${n.toLocaleString()} 🪙`
}

function tierOf(sku) {
  return CLUB_SKUS[sku]?.family ? 'family' : 'individual'
}

// isSkuCoveredByStatus: true when buying `sku` would be redundant given the
// caller's current /club/status — family membership covers both individual
// SKUs, and an active lifetime covers the same-tier monthly. Used to hide
// "Buy" in favor of an "included" state (dev-plan §7.6, partial: this covers
// the "don't show a redundant buy button" case; upgrade/proration flows are
// out of scope for this pass).
export function isSkuCoveredByStatus(sku, status) {
  const def = CLUB_SKUS[sku]
  if (!def || !status?.active) return false
  const activeSkus = Array.isArray(status.activeSkus) ? status.activeSkus : []
  if (activeSkus.includes(sku)) return true
  if (tierOf(sku) === 'individual' && status.tier === 'family') return true
  if (def.monthly && status.lifetime && status.tier === tierOf(sku)) return true
  return false
}

// journalOpenActive: true when an Open Journal Day (dev-plan §8.5) is live —
// full Club-level journal access for everyone, free tier included.
function journalOpenActive(journalOpen) {
  return !!journalOpen?.active
}

// deriveClubUI decides everything the Club screen + home entry point need to
// render, given the caller's /club/status response and session context.
// Child sessions NEVER see purchase UI (hard rule, dev-plan §0.2) — coins and
// membership state remain visible, but there is nothing to tap.
export function deriveClubUI(status, { isChildSession = false, isNative = false, nativeIAPReady = false, statusUnreachable = false } = {}) {
  const s = status || {}
  const active = !!s.active
  const tierName = s.tier === 'family' ? 'Family' : s.tier === 'individual' ? 'Individual' : ''
  const coinsLabel = formatCoins(s.coins)

  if (isChildSession) {
    return {
      showPurchaseUI: false,
      showManageSubscription: false,
      badgeVisible: active,
      coinsLabel,
      message: active
        ? `Your family has Club ${tierName ? `(${tierName}) ` : ''}♛ — enjoy the perks!`
        : 'Ask your parent about Club ♛',
      buttons: [],
    }
  }

  // Family inheritance (dev-plan §1.4/§10): an adult non-guardian family
  // member (the family 'child' role isn't necessarily a COPPA-protected
  // age — see isProtectedChildSession()) already has Club through the
  // guardian's plan. No purchase UI: buying anything themselves would just
  // be redundant, and the guardian is the billing owner.
  if (s.active && s.source === 'family-guardian') {
    return {
      showPurchaseUI: false,
      showManageSubscription: false,
      badgeVisible: true,
      tierName,
      active: true,
      lifetime: !!s.lifetime,
      expiresAt: s.expiresAt || '',
      coinsLabel,
      message: 'Club · via your family ♛',
      buttons: [],
    }
  }

  const buttons = CLUB_SKU_ORDER.map(sku => {
    const def = CLUB_SKUS[sku]
    const covered = isSkuCoveredByStatus(sku, s)
    return {
      sku,
      label: `${def.label} ${def.term}`,
      priceLabel: def.priceLabel,
      coinsGrantLabel: `+${formatCoins(def.coins)}${def.monthly ? ' per period' : ''}`,
      covered,
      // On native, purchases only route through StoreKit (Apple 3.1.1
      // forbids linking out to web payment for digital subscriptions from
      // the app) — so a native button is only enabled once the IAP plugin
      // has actually registered products and is ready to take an order.
      // Never silently fall back to a web checkout link on native.
      // statusUnreachable (dev-plan §11.6): reads may ride a stale cache,
      // but purchases must never start against unknown membership state.
      disabled: !s.canPurchase || covered || (isNative && !nativeIAPReady) || statusUnreachable,
    }
  })

  let monthlyCancelNotice = ''
  if (s.active && s.lifetime && s.monthlyOrigin) {
    monthlyCancelNotice = s.monthlyOrigin === 'apple'
      ? "You have Lifetime — cancel your monthly plan in Settings → Apple ID → Subscriptions so you aren't billed again."
      : 'You have Lifetime — cancel your monthly plan so you aren\'t billed again.'
  }

  // Cancellation rule copy (dev-plan §11.2): monthly members keep access
  // until the paid period ends — say so wherever a renewal date is shown.
  let cancelNote = ''
  if (active && !s.lifetime && s.expiresAt) {
    cancelNote = `If you cancel, you keep Club until ${new Date(s.expiresAt).toLocaleDateString()}.`
  }

  // Upgrade path copy (dev-plan §7.6/§11.4): Stripe can't prorate across
  // separate Checkout subscriptions, so web individual→family is cancel
  // first, then buy. Apple handles individual→family natively inside the
  // subscription group (StoreKit prorates), so no note there.
  let upgradeNote = ''
  if (active && !s.lifetime && s.tier === 'individual' && s.monthlyOrigin === 'stripe' && !isNative) {
    upgradeNote = 'Upgrading to Family? Cancel your Individual plan first (Manage subscription), then buy a Family plan.'
  }

  return {
    showPurchaseUI: true,
    showManageSubscription: active && !s.lifetime && !isNative && s.monthlyOrigin !== 'apple',
    badgeVisible: active,
    tierName,
    active,
    lifetime: !!s.lifetime,
    expiresAt: s.expiresAt || '',
    coinsLabel,
    canPurchase: s.canPurchase !== false,
    canPurchaseReason: s.canPurchase === false ? 'Ask your parent to buy Club.' : '',
    monthlyCancelNotice,
    cancelNote,
    upgradeNote,
    statusUnreachable: !!statusUnreachable,
    statusUnreachableReason: statusUnreachable ? 'Club purchases are unavailable right now — try again later.' : '',
    isNative,
    nativeIAPReady,
    nativePurchasesUnavailable: isNative && !nativeIAPReady,
    showRestorePurchases: isNative,
    buttons,
  }
}

// accountDeletionNotices (dev-plan §11.8): Club/coins warnings the deletion
// modal must show BEFORE the final confirm. Input is the /account/deletion
// requirements response.
export function accountDeletionNotices({ appleClubSubscriptionActive = false, coinBalance = 0 } = {}) {
  const notices = []
  if (appleClubSubscriptionActive) {
    notices.push('Your App Store subscription is NOT cancelled by deleting your account — cancel it in Settings → Apple ID → Subscriptions.')
  }
  const coins = Number(coinBalance) || 0
  if (coins > 0) {
    notices.push(`Your ${coins.toLocaleString()} Ethan Coins will be permanently lost.`)
  }
  return notices
}

// journalVisibleEntries: which journal entries render given free/Club/
// Open-Journal-Day status. Writing is always free and unaffected by this —
// this only bounds the HISTORY VIEW (dev-plan §1.2).
export function journalVisibleEntries(entries, { hasClub = false, journalOpen = null } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const unlimited = hasClub || journalOpenActive(journalOpen)
  return {
    visible: unlimited ? list : list.slice(0, JOURNAL_FREE_HISTORY_LIMIT),
    lockedCount: unlimited ? 0 : Math.max(0, list.length - JOURNAL_FREE_HISTORY_LIMIT),
    unlimited,
  }
}

// narrativeHint: client-side pre-check so the UI can be honest before ever
// calling /coach/report (server remains authoritative — this only avoids a
// silent-looking failed request when we already know the answer).
export function narrativeHint({ hasClub = false, journalOpen = null, narrativesRemainingToday = null } = {}) {
  if (hasClub) return { allowed: true, label: 'Unlimited Coach Gus notes' }
  if (journalOpenActive(journalOpen)) {
    const remaining = narrativesRemainingToday ?? 0
    return {
      allowed: remaining > 0,
      label: remaining > 0
        ? `📓 ${journalOpen.label || 'Open Journal Day'} — ${remaining} Coach Gus note${remaining === 1 ? '' : 's'} left today`
        : `📓 ${journalOpen.label || 'Open Journal Day'} — today's Coach Gus notes are used up`,
    }
  }
  const remaining = narrativesRemainingToday ?? FREE_WEEKLY_NARRATIVES
  return {
    allowed: remaining > 0,
    label: remaining > 0
      ? `${remaining} free Coach Gus note this week`
      : 'This week\'s free Coach Gus note is used — Club unlocks unlimited notes ♛',
  }
}

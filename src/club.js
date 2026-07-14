// Ethan's Chess Club — status fetch/cache + screen rendering + purchase
// flows, web (Stripe) and native (Apple StoreKit via cordova-plugin-purchase)
// (dev-plan Milestones 5 and 7.3). Display-logic decisions live in
// club-contract.mjs; this module owns extendFetch, the AGS SDK, the
// localStorage/memory cache, and DOM.
//
// ⚠️ NATIVE IAP LIVE-VERIFICATION GAP: this environment has no iOS simulator
// or physical device (see repo notes on the iPad build), so the
// register -> order -> approved -> verify -> AGS sync -> finish pipeline
// below has NOT been exercised against real StoreKit or a real AGS account.
// It's built from cordova-plugin-purchase v13's documented API
// (https://github.com/j3k0/cordova-plugin-purchase/tree/v13/api) and the
// AGS V2 Apple IAP sync endpoint's live-verified schema (dev-plan §16:
// PUT /platform/v2/public/namespaces/{ns}/users/{userId}/iap/apple/receipt,
// body {transactionId}, 204 on success). Before shipping: run this on a real
// device with a sandbox tester and confirm (a) store.order() opens the
// StoreKit sheet, (b) the validator's AGS call succeeds and receipt.finish()
// only fires after that, (c) restorePurchases() re-delivers and re-syncs,
// (d) the cross-account conflict path — currently guessed as AGS error code
// 38121 "Duplicate permanent item exists" — actually fires that way.
//
// Coin store (Milestone 6), High Five (7), and family allowance UI (8) are
// still not implemented here.
import { extendFetch } from './extend-client.js'
import { sdk, agsBaseURL, agsNamespace } from './ags-client.js'
import { fetchWithTimeout } from './network.mjs'
import { deriveClubUI, formatCoins, CLUB_SKUS, CLUB_SKU_ORDER } from './club-contract.mjs'

const CACHE_KEY = 'chess-club-status-v1'
const TTL_MS = 60 * 60 * 1000 // 1h

let cachedStatus = null
let cachedAt = 0

function isNative() {
  return !!window.Capacitor?.isNativePlatform?.()
}

function readLocalStorageCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (raw && typeof raw === 'object' && raw.status && typeof raw.ts === 'number') return raw
  } catch {}
  return null
}

function writeLocalStorageCache(status) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ status, ts: Date.now() }))
  } catch {}
}

// fetchClubStatus: 1h cache (memory mirror + localStorage so it survives a
// reload). Pass {force:true} on the exhaustive refresh-trigger list from
// dev-plan §11.7 (login, logout, return-from-checkout, opening the Club
// screen, insufficient-coins errors, native purchase/restore completing).
export async function fetchClubStatus({ force = false } = {}) {
  const now = Date.now()
  if (!force && cachedStatus && now - cachedAt < TTL_MS) return cachedStatus
  if (!force) {
    const stored = readLocalStorageCache()
    if (stored && now - stored.ts < TTL_MS) {
      cachedStatus = stored.status
      cachedAt = stored.ts
      return cachedStatus
    }
  }
  const res = await extendFetch('/club/status')
  if (!res.ok) throw new Error(`club status ${res.status}`)
  const status = await res.json()
  cachedStatus = status
  cachedAt = now
  writeLocalStorageCache(status)
  return status
}

export function getClubStatus() {
  return cachedStatus
}

export function hasClub() {
  return !!cachedStatus?.active
}

export function getCoins() {
  return cachedStatus?.coins ?? 0
}

export function resetClubStatus() {
  cachedStatus = null
  cachedAt = 0
  try { localStorage.removeItem(CACHE_KEY) } catch {}
  const panel = document.getElementById('ags-club-panel')
  if (panel) panel.style.display = 'none'
}

async function parseError(response, fallback) {
  const payload = await response.json().catch(() => ({}))
  const error = new Error(payload?.message || fallback)
  error.code = payload?.error || ''
  error.status = response.status
  return error
}

// openWebCheckout: creates a Stripe Checkout Session for `sku` and redirects
// the browser to it. Stripe redirects back to `${WEB_BASE_URL}/?club=success`
// (or ?club=cancel) — see consumeClubReturnParams() below.
export async function openWebCheckout(sku) {
  const res = await extendFetch('/club/web-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku }),
  })
  if (!res.ok) throw await parseError(res, 'Could not start checkout. Try again.')
  const { url } = await res.json()
  if (!url) throw new Error('Checkout did not return a URL.')
  window.location.href = url
}

// openManageSubscription: opens the Stripe customer portal (web-billed
// subscribers only — Apple-billed members manage via Settings, see
// club-contract.mjs's monthlyCancelNotice / showManageSubscription).
export async function openManageSubscription() {
  const res = await extendFetch('/club/web-portal', { method: 'POST' })
  if (!res.ok) throw await parseError(res, 'Could not open the billing portal. Try again.')
  const { url } = await res.json()
  if (!url) throw new Error('Billing portal did not return a URL.')
  window.location.href = url
}

// giveCoins: guardian → child allowance (dev-plan §6.8/§10). Server verifies
// the caller is actually the recipient's guardian and debits/credits both
// wallets atomically server-side; this just posts the request and refreshes
// the shared coin cache so getCoins() reflects the guardian's new balance
// (the child's own client, if open elsewhere, picks up its new balance on
// its own next /club/status poll — there's no push channel for this today).
async function parseGiveCoinsError(response, fallback) {
  const payload = await response.json().catch(() => ({}))
  const error = new Error(payload?.message || fallback)
  error.code = payload?.error || ''
  error.status = response.status
  error.balance = payload?.balance
  return error
}

export async function giveCoins(recipientUserId, amount) {
  if (!recipientUserId) throw new Error('Missing recipient.')
  const res = await extendFetch('/coins/give', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipientUserId, amount }),
  })
  if (!res.ok) {
    const error = await parseGiveCoinsError(res, 'Could not give coins. Try again.')
    if (error.code === 'insufficient_coins') {
      error.message = `Not enough coins — you have ${formatCoins(error.balance ?? 0)}.`
    }
    throw error
  }
  const { guardianBalance } = await res.json()
  await fetchClubStatus({ force: true }).catch(() => {})
  return { guardianBalance }
}

// ─── Native (Apple StoreKit) purchases via cordova-plugin-purchase ─────────

let nativeIAPReady = false
let nativeIAPInitStarted = false

export function isNativeIAPReady() {
  return nativeIAPReady
}

// AGS V2 Apple IAP sync (dev-plan §7.3/§16). Direct-to-AGS call (not through
// the Extend service) with the caller's own bearer token, per dev-plan.
// Waits briefly for sign-in if a StoreKit transaction is redelivered before
// hydration finishes (cold-launch race) — never syncs as an unknown user.
async function syncAppleTransaction(transactionId) {
  let userId = window.agsCurrentUserId
  let token = sdk.getToken()?.accessToken
  const deadline = Date.now() + 20000
  while ((!userId || !token) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500))
    userId = window.agsCurrentUserId
    token = sdk.getToken()?.accessToken
  }
  if (!userId || !token) {
    return { ok: false, retryable: true, message: 'Not signed in yet.' }
  }

  const url = `${agsBaseURL}/platform/v2/public/namespaces/${encodeURIComponent(agsNamespace)}/users/${encodeURIComponent(userId)}/iap/apple/receipt`
  let res
  try {
    res = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId }),
    })
  } catch (error) {
    return { ok: false, retryable: true, message: error?.message || 'Network error.' }
  }
  if (res.status === 204) return { ok: true }

  const payload = await res.json().catch(() => ({}))
  // Best-effort mapping of the cross-account conflict case (dev-plan §7.3):
  // AGS binds a transaction to the first AGS user that syncs it, so a
  // restore attempt on a different account should fail. The exact error
  // shape for THIS specific case wasn't in the live-verified schema (only
  // generic "duplicate permanent item" was) — treated as the conflict
  // signal since it's the closest documented match. Confirm on a real
  // two-account restore test before shipping (see file header).
  const conflict = res.status === 409 || payload?.errorCode === 38121
  return {
    ok: false,
    retryable: res.status >= 500,
    conflict,
    message: conflict
      ? 'This purchase belongs to a different player profile. Sign in with the account that made the purchase.'
      : (payload?.errorMessage || payload?.message || 'Could not verify this purchase with the App Store.'),
  }
}

function nativeTransactionId(receipt) {
  const transactions = Array.isArray(receipt?.transactions) ? receipt.transactions : []
  const last = transactions[transactions.length - 1]
  return last?.transactionId || ''
}

// initNativeIAP: registers the 4 Apple products and wires the
// approved -> verify -> (AGS sync) -> verified -> finish pipeline ONCE at
// app startup (dev-plan §7.3 "Finish ordering" — NOT lazily on the Club
// screen), so an unfinished transaction from a previous session gets
// re-delivered and re-synced before the user ever opens the Club screen.
export async function initNativeIAP() {
  if (!isNative() || nativeIAPInitStarted) return
  nativeIAPInitStarted = true

  // The native bridge injects window.CdvPurchase asynchronously relative to
  // this module's own script evaluation — poll briefly rather than assume
  // it's present on the first tick.
  let CdvPurchase = window.CdvPurchase
  const deadline = Date.now() + 5000
  while (!CdvPurchase && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200))
    CdvPurchase = window.CdvPurchase
  }
  if (!CdvPurchase) {
    console.warn('[club] native IAP plugin not available — purchase buttons stay disabled')
    return
  }

  const { store, ProductType, Platform } = CdvPurchase

  store.register(CLUB_SKU_ORDER.map(sku => ({
    id: CLUB_SKUS[sku].appleId,
    type: CLUB_SKUS[sku].monthly ? ProductType.PAID_SUBSCRIPTION : ProductType.NON_CONSUMABLE,
    platform: Platform.APPLE_APPSTORE,
  })))

  // Custom validator: instead of the plugin's own (or a 3rd-party) receipt
  // validation service, we hand the transaction id to AGS, which validates
  // against Apple's App Store Server API itself (dev-plan §3.3 config).
  store.validator = async (receipt, callback) => {
    const transactionId = nativeTransactionId(receipt)
    if (!transactionId) {
      callback({ ok: false, message: 'No transaction id on this receipt.' })
      return
    }
    const result = await syncAppleTransaction(transactionId)
    lastSyncResult = result
    if (result.ok) {
      callback({ ok: true, data: { id: transactionId, latest_receipt: true, transaction: {} } })
    } else {
      callback({ ok: false, message: result.message })
    }
  }

  let lastSyncResult = null

  store.when()
    .approved(transaction => transaction.verify())
    .verified(receipt => {
      // Only finish AFTER the AGS sync (inside the validator, already run
      // by the time .verified fires) has succeeded — mandatory ordering,
      // see file header. A failed sync routes to .unverified instead, and
      // receipt.finish() is never called there, so StoreKit re-delivers.
      receipt.finish()
    })
    .unverified(receipt => {
      const result = lastSyncResult
      lastSyncResult = null
      onNativeTransactionSettled({ ok: false, conflict: result?.conflict, message: result?.message })
    })
    .finished(() => {
      onNativeTransactionSettled({ ok: true })
    })

  store.error(err => {
    console.warn('[club] native IAP store error:', err?.message || err)
  })

  store.initialize([Platform.APPLE_APPSTORE])
  // "Ready" here means registration + handler wiring is complete and
  // store.order() can be called (the library queues orders internally if
  // the underlying store connection is still finishing initialize()) — not
  // a guarantee that initialize() has fully resolved. No store.ready()
  // callback was confirmed in the docs available; revisit if orders placed
  // immediately after a cold launch turn out to be dropped in device
  // testing (see file header).
  nativeIAPReady = true
  renderCurrentScreen()
}

// purchaseNative: opens the StoreKit purchase sheet for `sku`. Resolves once
// the order is PLACED, not once it's complete — completion flows through
// the approved/verified/finished pipeline registered in initNativeIAP(),
// which re-renders the UI itself once settled.
export async function purchaseNative(sku) {
  const def = CLUB_SKUS[sku]
  if (!def) throw new Error('Unknown Club plan.')
  if (!isNative() || !nativeIAPReady || !window.CdvPurchase) {
    throw new Error('The App Store connection isn\'t ready yet — try again in a moment.')
  }
  await window.CdvPurchase.store.order(def.appleId)
}

// restorePurchases: re-delivers past transactions through the same
// approved/verified/finished pipeline (each gets re-synced with AGS), then
// force-refreshes status regardless as a safety net. Required by Apple
// 3.1.1 as a visible button on the purchase screen.
export async function restorePurchases() {
  if (!isNative() || !window.CdvPurchase) throw new Error('Restore is only available in the app.')
  await window.CdvPurchase.store.restorePurchases()
  await fetchClubStatus({ force: true }).catch(() => {})
  renderCurrentScreen()
}

function onNativeTransactionSettled({ ok, conflict, message }) {
  void (async () => {
    try {
      await fetchClubStatus({ force: true })
    } catch (error) {
      console.warn('[club] post-purchase status refresh:', error?.message || error)
    }
    renderCurrentScreen()
    const messageEl = document.getElementById('club-message')
    if (ok) {
      showClubToast(`🎉 Welcome to Club! You now have ${formatCoins(getCoins())}.`)
    } else if (messageEl) {
      messageEl.textContent = message || 'Could not complete the purchase. Try again.'
      messageEl.style.display = ''
      if (conflict) messageEl.dataset.clubConflict = '1'
    }
  })()
}

// Re-renders whichever Club surfaces are currently in the DOM (home card +
// screen, if open) after an async native-purchase event settles.
function renderCurrentScreen() {
  const status = cachedStatus
  if (!status) return
  const isChildSession = !!document.getElementById('club-home-static')
    && document.getElementById('club-home-static').style.display !== 'none'
  renderHomePanel(status, isChildSession)
  if (document.getElementById('screen-club')?.classList.contains('active')) {
    renderClubScreen(status, isChildSession)
  }
}

// ─── Home dashboard entry point ────────────────────────────────────────────

function setText(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

function renderHomePanel(status, isChildSession) {
  const panel = document.getElementById('ags-club-panel')
  if (!panel) return
  const ui = deriveClubUI(status, { isChildSession, isNative: isNative(), nativeIAPReady })
  const actionBtn = document.getElementById('btn-club-open')
  const staticNote = document.getElementById('club-home-static')

  if (isChildSession) {
    if (actionBtn) actionBtn.style.display = 'none'
    if (staticNote) {
      staticNote.style.display = ''
      staticNote.textContent = ui.message
    }
  } else {
    if (actionBtn) actionBtn.style.display = ''
    if (staticNote) staticNote.style.display = 'none'
  }

  setText('club-home-title', ui.active ? `Club ${ui.tierName ? `· ${ui.tierName} ` : ''}♛` : "Ethan's Chess Club ♛")
  setText('club-home-tagline', ui.active
    ? 'Unlimited coaching, full journal history, and Club cosmetics.'
    : 'Unlock unlimited Coach Gus notes, full journal history, and more.')
  setText('club-home-coins', ui.coinsLabel)
  panel.style.display = ''
}

export async function initClubPanel(isChildSession) {
  try {
    const status = await fetchClubStatus()
    renderHomePanel(status, isChildSession)
  } catch (error) {
    console.warn('[club] home panel unavailable:', error?.message || error)
  }
}

// ─── Club screen ────────────────────────────────────────────────────────────

function skuButtonHtml(button) {
  const covered = button.covered
  return `<div class="club-plan-card${covered ? ' covered' : ''}">
    <h4>${button.label}</h4>
    <p class="club-plan-price">${button.priceLabel}</p>
    <p class="club-plan-coins">${button.coinsGrantLabel}</p>
    ${covered
      ? `<span class="club-plan-included">✓ Included</span>`
      : `<button type="button" class="btn btn-primary" data-purchase-ui="1" data-club-buy="${button.sku}" ${button.disabled ? 'disabled' : ''}>Get ${button.label}</button>`}
  </div>`
}

function renderClubScreen(status, isChildSession) {
  const ui = deriveClubUI(status, { isChildSession, isNative: isNative(), nativeIAPReady })
  const statusLine = document.getElementById('club-status-line')
  const grid = document.getElementById('club-purchase-grid')
  const message = document.getElementById('club-message')
  const manageBtn = document.getElementById('btn-club-manage')
  const restoreBtn = document.getElementById('btn-club-restore')
  const legalNote = document.getElementById('club-legal-note')

  if (statusLine) {
    statusLine.textContent = ui.active
      ? `You have Club${ui.tierName ? ` · ${ui.tierName}` : ''}${ui.lifetime ? ' (Lifetime)' : ui.expiresAt ? ` · renews/expires ${new Date(ui.expiresAt).toLocaleDateString()}` : ''} — ${ui.coinsLabel}`
      : `You have ${ui.coinsLabel}. Join Club for unlimited coaching and more.`
  }

  if (grid) {
    if (!ui.showPurchaseUI) {
      grid.innerHTML = ''
      grid.style.display = 'none'
    } else {
      grid.style.display = ''
      grid.innerHTML = ui.buttons.map(skuButtonHtml).join('')
      grid.querySelectorAll('[data-club-buy]').forEach(btn => {
        btn.addEventListener('click', () => handleBuyClick(btn.dataset.clubBuy, btn))
      })
    }
  }

  if (message && !message.dataset.clubConflict) {
    const parts = []
    // ui.message is set for the child-session and family-guardian-inherited
    // branches of deriveClubUI; absent (undefined) for the normal purchase
    // branch, where the other parts below carry any messaging instead.
    if (ui.message) parts.push(ui.message)
    if (ui.nativePurchasesUnavailable) parts.push('The App Store connection isn\'t ready yet — try again in a moment, or use Restore Purchases below if you\'ve bought Club before.')
    if (ui.canPurchaseReason) parts.push(ui.canPurchaseReason)
    if (ui.monthlyCancelNotice) parts.push(ui.monthlyCancelNotice)
    message.textContent = parts.join(' ')
    message.style.display = parts.length ? '' : 'none'
  }
  if (message) delete message.dataset.clubConflict

  if (manageBtn) manageBtn.style.display = ui.showManageSubscription ? '' : 'none'
  if (restoreBtn) restoreBtn.style.display = (ui.showRestorePurchases && !isChildSession) ? '' : 'none'
  if (legalNote) legalNote.style.display = ui.showPurchaseUI ? '' : 'none'
}

async function handleBuyClick(sku, button) {
  if (!CLUB_SKUS[sku]) return
  const originalText = button.textContent
  button.disabled = true
  button.textContent = 'Loading…'
  try {
    if (isNative()) {
      await purchaseNative(sku)
      // Leave the button disabled/"Loading…": StoreKit's own sheet takes
      // over, and the approved/verified/finished pipeline re-renders this
      // whole grid once settled (success or failure) via
      // onNativeTransactionSettled -> renderCurrentScreen.
    } else {
      await openWebCheckout(sku)
    }
  } catch (error) {
    console.warn('[club] purchase:', error?.message || error)
    const message = document.getElementById('club-message')
    if (message) {
      message.textContent = error?.message || 'Could not start the purchase. Try again.'
      message.style.display = ''
    }
    button.disabled = false
    button.textContent = originalText
  }
}

export async function openClubScreen(isChildSession) {
  if (typeof window.showScreen === 'function') window.showScreen('club')
  const statusLine = document.getElementById('club-status-line')
  if (statusLine) statusLine.textContent = 'Loading…'
  try {
    const status = await fetchClubStatus({ force: true })
    renderClubScreen(status, isChildSession)
  } catch (error) {
    console.warn('[club] screen load failed:', error?.message || error)
    if (statusLine) statusLine.textContent = 'Could not load Club status. Try again in a moment.'
    const grid = document.getElementById('club-purchase-grid')
    if (grid) grid.innerHTML = ''
  }
}

export async function refreshClubManageAction() {
  try {
    await openManageSubscription()
  } catch (error) {
    console.warn('[club] manage subscription:', error?.message || error)
    const message = document.getElementById('club-message')
    if (message) {
      message.textContent = error?.message || 'Could not open the billing portal. Try again.'
      message.style.display = ''
    }
  }
}

export async function triggerRestorePurchases() {
  const button = document.getElementById('btn-club-restore')
  const originalText = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Restoring…'
  }
  try {
    await restorePurchases()
  } catch (error) {
    console.warn('[club] restore purchases:', error?.message || error)
    const message = document.getElementById('club-message')
    if (message) {
      message.textContent = error?.message || 'Could not restore purchases. Try again.'
      message.style.display = ''
    }
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = originalText || 'Restore Purchases'
    }
  }
}

function showClubToast(message) {
  const toast = document.getElementById('club-toast')
  if (!toast) return
  const textEl = document.getElementById('club-toast-text')
  if (textEl) textEl.textContent = message
  toast.classList.add('show')
  clearTimeout(showClubToast._timer)
  showClubToast._timer = setTimeout(() => toast.classList.remove('show'), 6000)
}

// ─── Return-from-checkout handling (dev-plan §11.7) ────────────────────────
// Stripe redirects to `${WEB_BASE_URL}/?club=success` or `?club=cancel`.
export function consumeClubReturnParams() {
  const params = new URLSearchParams(window.location.search)
  const club = params.get('club')
  if (!club) return
  window.history.replaceState({}, '', window.location.pathname + window.location.hash)
  if (club === 'success') {
    void (async () => {
      try {
        const status = await fetchClubStatus({ force: true })
        showClubToast(`🎉 Welcome to Club! You now have ${formatCoins(status.coins)}.`)
      } catch (error) {
        console.warn('[club] post-checkout refresh:', error?.message || error)
      }
    })()
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.agsClubStatusForTesting = () => cachedStatus
  window.agsClubNativeIAPReadyForTesting = () => nativeIAPReady
  // Offline e2e seam: render the Club screen (or home panel) from a fabricated
  // status without a real /club/status network round trip.
  window.agsRenderClubForTesting = (status, opts = {}) => {
    cachedStatus = status
    cachedAt = Date.now()
    renderClubScreen(status, !!opts.isChildSession)
    renderHomePanel(status, !!opts.isChildSession)
  }
  // Offline e2e seam: simulate the native IAP plugin becoming ready without
  // window.CdvPurchase / a real Capacitor bridge.
  window.agsSetClubNativeIAPReadyForTesting = ready => {
    nativeIAPReady = !!ready
    renderCurrentScreen()
  }
  // Offline e2e seam: simulate a settled native transaction (success or
  // failure) without a real StoreKit round trip.
  window.agsSimulateNativeTransactionForTesting = (ok, extra = {}) => {
    onNativeTransactionSettled({ ok, ...extra })
  }
}

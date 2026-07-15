// Ethan Coins cosmetics store (dev-plan Milestone 6): catalog + ownership +
// purchase go DIRECTLY to AGS public endpoints (not through the Extend
// service — "AGS-native orders... no custom code", dev-plan §8) using the
// caller's own bearer token, matching the direct-AGS pattern already
// established in src/club.js for the native Apple IAP sync. Equipped
// cosmetics persist in a private CloudSave record and get applied to the
// DOM (board theme class, piece-set class, victory-effect trigger, flair
// next to the caller's own name).
//
// Coin balance is intentionally NOT re-fetched from AGS Wallet directly here
// — src/club.js's fetchClubStatus() already reads the same ETHC wallet
// (admin-side, via the Extend service) and is the single source of truth
// for the balance shown elsewhere in the app. After a purchase this module
// force-refreshes that same cache rather than adding a second wallet read.
import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'
import { sdk, agsBaseURL, agsNamespace } from './ags-client.js'
import { fetchWithTimeout } from './network.mjs'
import {
  deriveEquipSlot, slotValueFromSku, normalizeCosmeticsRecord, DEFAULT_COSMETICS_RECORD,
  deriveCosmeticCard, sortCosmetics, insufficientBalanceMessage, itemRegionData,
} from './coin-store-contract.mjs'
import { fetchClubStatus, getCoins } from './club.js'

const COSMETICS_KEY = 'chess-cosmetics'
const CATALOG_TTL_MS = 60 * 60 * 1000 // 1h — the cosmetics catalog rarely changes

let cachedCatalog = null
let cachedCatalogAt = 0
let ownedSkus = []
let equippedRecord = { ...DEFAULT_COSMETICS_RECORD }
let cosmeticsLoadedForUserId = null

// A small display table for the flair slot's badge — pure data, mirrors the
// club-contract.mjs convention of keeping display decisions out of DOM code.
const FLAIR_BADGES = {
  founder: { emoji: '🌟', label: 'Club Founder' },
}

function cloudSaveApi() {
  const { coreConfig } = sdk.assembly()
  return PublicPlayerRecordApi(sdk, { coreConfig: { ...coreConfig, useSchemaValidation: false } })
}

async function fetchCosmeticsRecord(userId) {
  try {
    const res = await cloudSaveApi().getRecord_ByUserId_ByKey(userId, COSMETICS_KEY)
    return normalizeCosmeticsRecord(res.data?.value)
  } catch (e) {
    if (e?.response?.status !== 404) console.warn('[coin-store] fetch record:', e?.response?.data || e?.message)
    return { ...DEFAULT_COSMETICS_RECORD }
  }
}

async function saveCosmeticsRecord(userId, record) {
  const api = cloudSaveApi()
  try {
    await api.updateRecord_ByUserId_ByKey(userId, COSMETICS_KEY, record)
  } catch (e) {
    if (e?.response?.status !== 404) throw e
    await api.createRecord_ByUserId_ByKey(userId, COSMETICS_KEY, record)
  }
}

function authHeaders() {
  const token = sdk.getToken()?.accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// ─── Direct AGS calls (catalog, ownership, purchase) ───────────────────────

async function fetchCosmeticCatalog({ force = false } = {}) {
  const now = Date.now()
  if (!force && cachedCatalog && now - cachedCatalogAt < CATALOG_TTL_MS) return cachedCatalog
  const url = `${agsBaseURL}/platform/public/namespaces/${encodeURIComponent(agsNamespace)}/items/byCriteria`
    + `?categoryPath=${encodeURIComponent('/cosmetics')}&region=US&language=en&limit=50`
  const res = await fetchWithTimeout(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`cosmetics catalog ${res.status}`)
  const payload = await res.json()
  cachedCatalog = Array.isArray(payload?.data) ? payload.data : []
  cachedCatalogAt = now
  return cachedCatalog
}

// Full entitlement list (not the /ownership/any boolean check) — one call
// gets per-item ownership for the whole store instead of one round trip per
// cosmetic (dev-plan §8's ownership check is per-item; this reads them all
// at once and filters client-side).
async function fetchOwnedCosmeticSkus(userId) {
  const url = `${agsBaseURL}/platform/public/namespaces/${encodeURIComponent(agsNamespace)}/users/${encodeURIComponent(userId)}/entitlements?limit=100`
  const res = await fetchWithTimeout(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`entitlements ${res.status}`)
  const payload = await res.json()
  const list = Array.isArray(payload?.data) ? payload.data : []
  return list.filter(e => (e.status || 'ACTIVE') === 'ACTIVE' && e.sku).map(e => e.sku)
}

// purchaseCosmetic: AGS debits the ETHC wallet and grants the entitlement
// atomically (dev-plan §8 — "no custom code"). price/discountedPrice must
// match the item's own regionData exactly or AGS rejects the order
// (errorCode 32121 "Order price mismatch") — read them from the catalog
// item itself, never hardcode.
export async function purchaseCosmetic(item) {
  const userId = window.agsCurrentUserId
  if (!userId) return { ok: false, message: 'Sign in to buy cosmetics.' }
  const region = itemRegionData(item)
  if (!region) return { ok: false, message: 'This item is not available right now.' }

  const url = `${agsBaseURL}/platform/public/namespaces/${encodeURIComponent(agsNamespace)}/users/${encodeURIComponent(userId)}/orders`
  let res
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemId: item.itemId,
        quantity: 1,
        currencyCode: region.currencyCode || 'ETHC',
        price: Number(region.price || 0),
        discountedPrice: Number(region.discountedPrice ?? region.price ?? 0),
        region: 'US',
        language: 'en',
      }),
    })
  } catch (error) {
    return { ok: false, message: error?.message || 'Network error. Try again.' }
  }

  if (res.status === 201) {
    ownedSkus = [...new Set([...ownedSkus, item.sku])]
    await fetchClubStatus({ force: true }).catch(() => {}) // refresh the shared coin balance
    return { ok: true }
  }

  const payload = await res.json().catch(() => ({}))
  if (payload?.errorCode === 35124) {
    return { ok: false, insufficientBalance: true, message: insufficientBalanceMessage(deriveCosmeticCard(item, { ownedSkus, coins: getCoins() }), getCoins()) }
  }
  if (payload?.errorCode === 31177) {
    // Permanent item already owned (e.g. a second tab bought it first) —
    // not a failure from the player's point of view; resync and treat as OK.
    ownedSkus = [...new Set([...ownedSkus, item.sku])]
    return { ok: true }
  }
  return { ok: false, message: payload?.errorMessage || payload?.message || 'Could not complete the purchase. Try again.' }
}

// ─── Equip / apply to the DOM ───────────────────────────────────────────────

function applyBoardTheme(theme) {
  document.querySelectorAll('.board-container').forEach(container => {
    container.className = container.className.replace(/\bboard-theme-\S+/g, '').trim()
    if (theme) container.classList.add(`board-theme-${theme}`)
  })
}

function applyPieceSet(set) {
  document.body.classList.forEach(cls => {
    if (cls.startsWith('piece-set-')) document.body.classList.remove(cls)
  })
  if (set) document.body.classList.add(`piece-set-${set}`)
}

function applyEquippedCosmetics(record) {
  applyBoardTheme(record.boardTheme)
  applyPieceSet(record.pieceSet)
  // victoryFx is momentary (applied by triggerVictoryEffect at game-over,
  // not a standing DOM state) and flair is read on-demand by
  // getEquippedFlairBadge() from wherever the caller's own name renders —
  // neither has a persistent class to set here.
}

export function getEquippedCosmetics() {
  return equippedRecord
}

export function getEquippedFlairBadge() {
  return FLAIR_BADGES[equippedRecord.flair] || null
}

// triggerVictoryEffect: called from app.js's showGameOver() when the player
// won. Renders a short CSS-animated overlay on the game-over modal if the
// player has a victory effect equipped; no-ops otherwise.
export function triggerVictoryEffect() {
  const fx = equippedRecord.victoryFx
  if (!fx) return
  const modal = document.getElementById('game-over-modal')
  const content = modal?.querySelector('.modal-content')
  if (!content) return
  const layer = document.createElement('div')
  layer.className = `victory-fx victory-fx-${fx}`
  layer.setAttribute('aria-hidden', 'true')
  content.appendChild(layer)
  setTimeout(() => layer.remove(), 3200)
}

async function equipSlotValue(sku, value) {
  const slot = deriveEquipSlot(sku)
  if (!slot) return
  equippedRecord = { ...equippedRecord, [slot]: value }
  applyEquippedCosmetics(equippedRecord)
  renderStoreGrid()
  if (cosmeticsLoadedForUserId) {
    try {
      await saveCosmeticsRecord(cosmeticsLoadedForUserId, equippedRecord)
    } catch (error) {
      console.warn('[coin-store] save equip:', error?.message || error)
    }
  }
}

export function equipCosmetic(sku) {
  return equipSlotValue(sku, slotValueFromSku(sku))
}

export function unequipCosmetic(sku) {
  return equipSlotValue(sku, '')
}

// ─── Lifecycle: login/logout ────────────────────────────────────────────────

// initCosmetics: loads + applies the caller's equipped cosmetics at sign-in.
// Deliberately does NOT fetch the catalog or owned-items list here (only
// needed when the store screen actually opens) — this keeps hydration cheap
// for the common case of a session that never opens the store.
export async function initCosmetics(userId) {
  if (!userId) return
  try {
    equippedRecord = await fetchCosmeticsRecord(userId)
    cosmeticsLoadedForUserId = userId
    applyEquippedCosmetics(equippedRecord)
  } catch (error) {
    console.warn('[coin-store] init unavailable:', error?.message || error)
  }
}

export function resetCosmetics() {
  equippedRecord = { ...DEFAULT_COSMETICS_RECORD }
  cosmeticsLoadedForUserId = null
  ownedSkus = []
  cachedCatalog = null
  cachedCatalogAt = 0
  applyEquippedCosmetics(equippedRecord)
}

// ─── Store screen (modal overlay) ───────────────────────────────────────────

function cardHtml(card) {
  return `<div class="cosmetic-card${card.isEquipped ? ' equipped' : card.owned ? ' owned' : ''}">
    <div class="cosmetic-card-preview cosmetic-preview-${card.sku}" aria-hidden="true"></div>
    <span class="cosmetic-card-name">${escCoin(card.name)}</span>
    <span class="cosmetic-card-desc">${escCoin(card.description)}</span>
    <button type="button" class="btn-mini${card.owned ? (card.isEquipped ? ' success' : '') : ' cosmetic-buy'}"
      data-cosmetic-action="${card.ctaAction}" data-cosmetic-sku="${escCoin(card.sku)}"
      ${card.ctaDisabled ? 'disabled' : ''}>
      ${card.owned ? escCoin(card.ctaLabel) : `${escCoin(card.ctaLabel)}${card.owned ? '' : ` · ${card.price} 🪙`}`}
    </button>
  </div>`
}

function escCoin(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

let lastCatalog = []

function renderStoreGrid() {
  const grid = document.getElementById('coin-store-grid')
  if (!grid) return
  const coins = getCoins()
  const balanceEl = document.getElementById('coin-store-balance')
  if (balanceEl) balanceEl.textContent = `${coins.toLocaleString()} 🪙`
  const cards = lastCatalog.map(item => deriveCosmeticCard(item, { ownedSkus, equipped: equippedRecord, coins }))
  grid.innerHTML = sortCosmetics(cards).map(cardHtml).join('')
  grid.querySelectorAll('[data-cosmetic-action]').forEach(button => {
    button.addEventListener('click', () => handleCardAction(button))
  })
}

async function handleCardAction(button) {
  const sku = button.dataset.cosmeticSku
  const action = button.dataset.cosmeticAction
  const item = lastCatalog.find(i => i.sku === sku)
  const messageEl = document.getElementById('coin-store-message')
  if (messageEl) { messageEl.textContent = ''; messageEl.style.display = 'none' }

  if (action === 'equip') {
    await equipCosmetic(sku)
    return
  }
  if (action === 'unequip') {
    await unequipCosmetic(sku)
    return
  }
  if (action === 'buy' && item) {
    button.disabled = true
    const originalText = button.textContent
    button.textContent = 'Buying…'
    const result = await purchaseCosmetic(item)
    if (result.ok) {
      renderStoreGrid()
    } else {
      button.disabled = false
      button.textContent = originalText
      if (messageEl) {
        messageEl.textContent = result.message || 'Could not complete the purchase. Try again.'
        messageEl.style.display = ''
      }
    }
  }
}

// loadCoinStore: fetches + renders the catalog/ownership data into the grid.
// Show/hide of the overlay itself (focus trap, Escape, backdrop dismiss) is
// owned by main.js's shared createOverlayController — this only loads data,
// matching the DOM-vs-data split already established in club.js.
export async function loadCoinStore() {
  const grid = document.getElementById('coin-store-grid')
  if (grid) grid.innerHTML = '<div class="profile-history-loading"><span></span><span></span><span></span></div>'
  try {
    const userId = window.agsCurrentUserId
    // Force-refresh the shared coin balance every time the store opens, so
    // it's never stale relative to a purchase/spend made elsewhere (Club
    // checkout, a High Five, another device).
    const [catalog, owned] = await Promise.all([
      fetchCosmeticCatalog(),
      userId ? fetchOwnedCosmeticSkus(userId) : Promise.resolve([]),
      fetchClubStatus({ force: true }).catch(() => {}),
    ])
    lastCatalog = catalog
    ownedSkus = owned
    renderStoreGrid()
  } catch (error) {
    console.warn('[coin-store] open failed:', error?.message || error)
    if (grid) grid.innerHTML = '<div class="profile-history-empty"><strong>Could not load the store.</strong><span>Try again in a moment.</span></div>'
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.agsCoinStoreStateForTesting = () => ({ ownedSkus, equippedRecord, lastCatalog })
  // Offline e2e seam: render the store grid from fabricated catalog +
  // ownership data without real AGS network round trips.
  window.agsRenderCoinStoreForTesting = (catalog, owned = [], equipped = null) => {
    lastCatalog = catalog
    ownedSkus = owned
    if (equipped) equippedRecord = normalizeCosmeticsRecord(equipped)
    cosmeticsLoadedForUserId = window.agsCurrentUserId || 'test-user'
    const overlay = document.getElementById('coin-store-overlay')
    if (overlay) overlay.hidden = false
    renderStoreGrid()
  }
  // Offline e2e seam: exercise the real CloudSave read path (initCosmetics)
  // against a mocked **/cloudsave/** route instead of fabricating state.
  window.agsInitCosmeticsForTesting = userId => initCosmetics(userId)
}

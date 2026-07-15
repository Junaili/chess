// Pure, unit-testable display logic for the Ethan Coins cosmetics store
// (dev-plan dev-plan/subscription-coins-implementation-plan.md, Milestone 6).
// No DOM, no fetch, no SDK — network/CloudSave/DOM orchestration lives in
// src/coin-store.js.

// Equip slots mirror the CloudSave record shape (dev-plan §8): one equipped
// value per slot, keyed off the item SKU's prefix so the catalog stays the
// single source of truth (no separate slot-mapping table to keep in sync).
export function deriveEquipSlot(sku) {
  if (!sku) return null
  if (sku.startsWith('cos-board-')) return 'boardTheme'
  if (sku.startsWith('cos-pieces-')) return 'pieceSet'
  if (sku.startsWith('cos-victory-')) return 'victoryFx'
  if (sku.startsWith('cos-flair-')) return 'flair'
  return null
}

// Slot value is the SKU's own suffix (e.g. `cos-board-walnut` -> `walnut`) —
// this is what CSS classes and the CloudSave record store, so a theme class
// like `.board-theme-walnut` maps 1:1 back to the SKU that unlocked it.
export function slotValueFromSku(sku) {
  const slot = deriveEquipSlot(sku)
  if (!slot) return ''
  return sku.replace(/^cos-(board|pieces|victory|flair)-/, '')
}

export const DEFAULT_COSMETICS_RECORD = Object.freeze({ boardTheme: '', pieceSet: '', victoryFx: '', flair: '' })

export function normalizeCosmeticsRecord(value) {
  const v = value && typeof value === 'object' ? value : {}
  return {
    boardTheme: typeof v.boardTheme === 'string' ? v.boardTheme : '',
    pieceSet: typeof v.pieceSet === 'string' ? v.pieceSet : '',
    victoryFx: typeof v.victoryFx === 'string' ? v.victoryFx : '',
    flair: typeof v.flair === 'string' ? v.flair : '',
  }
}

// itemRegionData: the PUBLIC items/byCriteria API returns `regionData` as a
// bare array of the requested region's entries (live-verified 2026-07-14),
// while the ADMIN variant keys it by region ({US: […]}). Parsing only the
// map shape made every public-catalog price read as 0 — free-looking Buy
// buttons that then failed at order time. Accept both shapes here.
export function itemRegionData(item) {
  const rd = item?.regionData
  if (Array.isArray(rd)) return rd[0]
  return rd?.US?.[0]
}

// deriveCosmeticCard: everything one store grid card needs to render, given
// the raw AGS item, the caller's owned-sku set, their equipped-cosmetics
// record, and current coin balance.
export function deriveCosmeticCard(item, { ownedSkus = [], equipped = DEFAULT_COSMETICS_RECORD, coins = 0 } = {}) {
  const sku = item?.sku || ''
  const slot = deriveEquipSlot(sku)
  const slotValue = slotValueFromSku(sku)
  const owned = ownedSkus.includes(sku)
  const equippedValue = slot ? equipped[slot] : ''
  const isEquipped = owned && slot && equippedValue === slotValue
  const price = Number(itemRegionData(item)?.price ?? item?.price ?? 0)
  const affordable = coins >= price

  let ctaLabel = ''
  let ctaAction = ''
  let ctaDisabled = false
  if (owned) {
    if (isEquipped) {
      ctaLabel = '✓ Equipped'
      ctaAction = 'unequip'
    } else {
      ctaLabel = 'Equip'
      ctaAction = 'equip'
    }
  } else {
    ctaLabel = affordable ? 'Buy' : 'Not enough coins'
    ctaAction = 'buy'
    ctaDisabled = !affordable
  }

  return {
    sku,
    itemId: item?.itemId || '',
    name: item?.localizations?.en?.title || item?.name || sku,
    description: item?.localizations?.en?.description || '',
    price,
    slot,
    owned,
    isEquipped,
    affordable,
    ctaLabel,
    ctaAction,
    ctaDisabled,
  }
}

// sortCosmetics: owned-and-equipped first, then owned, then affordable,
// then the rest — cheapest first within each group, so the store reads as
// "here's what you have, here's what you can get next."
export function sortCosmetics(cards) {
  const rank = card => {
    if (card.isEquipped) return 0
    if (card.owned) return 1
    if (card.affordable) return 2
    return 3
  }
  return [...cards].sort((a, b) => rank(a) - rank(b) || a.price - b.price || a.name.localeCompare(b.name))
}

// insufficientBalanceMessage: dev-plan M6 acceptance criteria — "insufficient
// balance shows friendly error."
export function insufficientBalanceMessage(card, coins) {
  const short = Math.max(0, card.price - coins)
  return `You need ${short} more coin${short === 1 ? '' : 's'} for ${card.name}.`
}

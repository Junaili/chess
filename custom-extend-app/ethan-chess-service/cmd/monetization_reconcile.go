package main

// Coin reconciliation (§6.5): for each of the caller's OWN active club
// entitlements, make sure the coins for the current lifetime grant / billing
// period have been credited exactly once — regardless of whether the credit
// was already handled by the Stripe webhook (which writes the SAME `period:`/
// `life:` txKey, see §6.5's double-credit-trap note) or needs to happen here
// because the entitlement came from Apple (no webhook exists for Apple).
//
// This function is deliberately decision-logic-first: reconcileDecisions is
// pure (no network) and unit-tested directly; reconcileCoins is the thin
// side-effecting wrapper /club/status calls.

import (
	"fmt"
	"time"
)

type reconcileDecision struct {
	SKU   string
	TxKey string
	Coins int
	Kind  string // "lifetime" | "period"
}

// reconcileDecisions returns the set of credits that still need to happen for
// the given entitlements, given what's already in the ledger. Pure function —
// no network, easy to hit every edge case in tests.
func reconcileDecisions(entitlements []clubEntitlement, ledger monetizationLedger, now time.Time) []reconcileDecision {
	var decisions []reconcileDecision
	for _, e := range entitlements {
		if !e.isActive(now) {
			continue
		}
		def, ok := clubSKUs[e.SKU]
		if !ok {
			continue
		}
		if !def.Monthly {
			key := txKeyLifetime(e.SKU)
			if _, exists := ledger.Credits[key]; !exists {
				decisions = append(decisions, reconcileDecision{SKU: e.SKU, TxKey: key, Coins: def.Coins, Kind: "lifetime"})
			}
			continue
		}
		if e.EndDate == "" {
			continue // monthly SKU with no window yet — nothing to reconcile
		}
		key := txKeyPeriod(e.SKU, e.EndDate)
		if _, exists := ledger.Credits[key]; !exists {
			decisions = append(decisions, reconcileDecision{SKU: e.SKU, TxKey: key, Coins: def.Coins, Kind: "period"})
		}
	}
	return decisions
}

// reconcileCoins applies reconcileDecisions for userID: ledger-first, then
// wallet credit, per the §6.4 ordering rule. A decision that's already
// present by the time the ledger write lands (a concurrent request beat us to
// it) is silently skipped — mutateLedger's fn returning false handles that.
func (h *monetizationHandler) reconcileCoins(userID string, entitlements []clubEntitlement) error {
	// Read once for the decision pass; mutateLedger re-reads under the hood
	// for the actual write, so a stale read here only costs a redundant
	// (harmless) wallet-credit attempt in the rare race case, never a
	// double-credit — the ledger write is still the source of truth.
	ledger, _, err := h.readLedger(userID)
	if err != nil {
		return fmt.Errorf("read ledger: %w", err)
	}
	decisions := reconcileDecisions(entitlements, ledger, h.now())
	var firstErr error
	for _, d := range decisions {
		_, wrote, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
			if _, exists := l.Credits[d.TxKey]; exists {
				return false
			}
			l.Credits[d.TxKey] = ledgerEntry{Amount: d.Coins, At: timeNowISO(h.now()), Kind: "club-" + d.Kind}
			return true
		})
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("ledger write for %s: %w", d.TxKey, err)
			}
			continue
		}
		if !wrote {
			// A concurrent reconciliation pass (or the Stripe webhook) beat
			// us to this exact txKey — do NOT credit the wallet again. This
			// is the same double-credit trap §6.5 warns about, closed here
			// by mutateLedger's wrote flag instead of re-reading the ledger.
			continue
		}
		if err := h.creditUserWallet(userID, int64(d.Coins), "PURCHASE", "club:"+d.TxKey); err != nil {
			// Roll back: the ledger says we paid but the wallet call failed.
			_, _, _ = h.mutateLedger(userID, func(l *monetizationLedger) bool {
				if _, exists := l.Credits[d.TxKey]; !exists {
					return false
				}
				delete(l.Credits, d.TxKey)
				return true
			})
			if firstErr == nil {
				firstErr = fmt.Errorf("wallet credit for %s: %w", d.TxKey, err)
			}
		}
	}
	// Apple refund clawback (§6.5 last bullet): any period/life credit whose
	// matching entitlement is no longer active gets debited back, once.
	if err := h.applyClawbacks(userID, entitlements, ledger); err != nil && firstErr == nil {
		firstErr = err
	}
	return firstErr
}

// applyClawbacks handles the Apple-refund case: Stripe refunds are handled
// synchronously in the webhook (§6.6); this covers Apple, which has no
// webhook, so a refund is only detectable by the entitlement disappearing.
func (h *monetizationHandler) applyClawbacks(userID string, entitlements []clubEntitlement, ledger monetizationLedger) error {
	activeKeys := map[string]bool{}
	now := h.now()
	for _, e := range entitlements {
		if !e.isActive(now) {
			continue
		}
		if clubSKUs[e.SKU].Monthly && e.EndDate != "" {
			activeKeys[txKeyPeriod(e.SKU, e.EndDate)] = true
		} else if !clubSKUs[e.SKU].Monthly {
			activeKeys[txKeyLifetime(e.SKU)] = true
		}
	}
	var firstErr error
	for key, entry := range ledger.Credits {
		if entry.Kind != "club-lifetime" && entry.Kind != "club-period" {
			continue
		}
		if activeKeys[key] {
			continue
		}
		// §6.5 scopes clawback to entitlements that are "now revoked" — a
		// period whose window simply ran out is a normally-consumed month,
		// not a refund. AGS hides revoked and expired entitlements from its
		// queries alike (live-verified 2026-07-14), so the two cases are
		// told apart by the period end encoded in the txKey: an absent
		// entitlement whose period end is still in the future can only mean
		// it was revoked mid-period.
		if entry.Kind == "club-period" {
			if end, ok := periodEndFromTxKey(key); !ok || !end.After(now) {
				continue
			}
		}
		clawKey := txKeyClawback(key)
		if _, exists := ledger.Debits[clawKey]; exists {
			continue // cheap skip using the snapshot; mutateLedger below is the real (fresh-read) guard
		}
		balance, err := h.getWalletBalance(userID)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		amount := int64(entry.Amount)
		if amount > balance {
			amount = balance
		}
		if amount <= 0 {
			continue
		}
		// Ledger-first (§6.4 ordering): reserve the clawback under a fresh,
		// concurrency-checked read BEFORE touching the wallet, so two
		// concurrent /club/status calls racing this same stale `ledger`
		// snapshot can't both pass the cheap pre-check above and both debit.
		_, wrote, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
			if _, exists := l.Debits[clawKey]; exists {
				return false
			}
			l.Debits[clawKey] = ledgerEntry{Amount: int(amount), At: timeNowISO(h.now()), Kind: "clawback"}
			return true
		})
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !wrote {
			continue // a concurrent call already reserved and applied this clawback
		}
		if err := h.debitUserWallet(userID, amount, "OTHER", "clawback:"+key, true); err != nil {
			// Roll back the reservation so a future pass can retry.
			_, _, _ = h.mutateLedger(userID, func(l *monetizationLedger) bool {
				if _, exists := l.Debits[clawKey]; !exists {
					return false
				}
				delete(l.Debits, clawKey)
				return true
			})
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

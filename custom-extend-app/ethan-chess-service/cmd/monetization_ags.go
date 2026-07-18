package main

// AGS Platform admin calls: entitlements, fulfillment, and the Ethan Coins
// (ETHC) wallet. Field names for write bodies (fulfillment/credit/debit) are
// taken verbatim from the live OpenAPI spec (justice-platform-service
// 6.13.0). Entitlements are granted through the fulfillment API and queried
// by SKU, so this file needs no SKU -> itemId catalog mapping at all (the
// item catalog cache that used to live here — and its live-debugged
// itemId-vs-id parse trap — was deleted when grants moved to fulfillment).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

type clubEntitlement struct {
	ID        string // AGS entitlement id — needed to revoke on refund (§6.6)
	SKU       string
	Status    string
	StartDate string
	EndDate   string // "" for lifetime (no window)
	Origin    string // "stripe" | "apple" | "" (best-effort, derived from AGS `origin`)
}

// isActive: note that AGS hides entitlements from its queries entirely once
// their endDate passes (live-verified 2026-07-14 — expired ones vanish even
// without activeOnly=true), so the grace addend below is belt-and-braces for
// clock skew only; a lapsed window never reaches this check in practice.
func (e clubEntitlement) isActive(now time.Time) bool {
	if !strings.EqualFold(e.Status, "ACTIVE") {
		return false
	}
	if e.EndDate == "" {
		return true // lifetime
	}
	end, err := time.Parse(time.RFC3339, e.EndDate)
	if err != nil {
		return false
	}
	return now.Before(end.Add(monthlyGraceDuration))
}

type agsEntitlementsResponse struct {
	Data []struct {
		ID        string `json:"id"`
		ItemID    string `json:"itemId"`
		Sku       string `json:"sku"`
		Status    string `json:"status"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
		Origin    string `json:"origin"`
	} `json:"data"`
}

// activeClubEntitlements returns the caller's own club standing across all 4
// SKUs (used by /club/status for the "self" source).
func (h *monetizationHandler) activeClubEntitlements(userID string) ([]clubEntitlement, error) {
	all := make([]string, 0, len(clubSKUs))
	for sku := range clubSKUs {
		all = append(all, sku)
	}
	return h.activeClubStatus(userID, all)
}

// activeClubEntitlementsFiltered queries the user's active entitlements once
// and keeps the rows whose response `sku` is in the requested set. This is
// the sole club-standing source for ALL SKUs: lifetime ones have no window,
// monthly ones carry an endDate equal to the billing period end (granted per
// paid Stripe invoice; synced by AGS for Apple IAP). AGS's activeOnly filter
// drops expired/revoked windows on its own. One query replaces the previous
// per-SKU loop (4 round-trips per /club/status), and filtering on the
// response's own sku field removes the need to resolve SKU -> itemId first.
func (h *monetizationHandler) activeClubEntitlementsFiltered(userID string, skus []string) ([]clubEntitlement, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return nil, err
	}
	wanted := make(map[string]struct{}, len(skus))
	for _, sku := range skus {
		wanted[sku] = struct{}{}
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/entitlements?activeOnly=true&limit=100",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// Same convention as the wallet summary: a user with no entitlement
		// records yet is "none", not an error.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, fmt.Errorf("query entitlements for %s returned %d", userID, resp.StatusCode)
	}
	var parsed agsEntitlementsResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode entitlements for %s: %w", userID, err)
	}
	var out []clubEntitlement
	for _, e := range parsed.Data {
		if _, ok := wanted[e.Sku]; !ok {
			continue
		}
		origin := ""
		switch strings.ToUpper(e.Origin) {
		case "IOS":
			origin = "apple"
		case "OTHER", "SYSTEM", "":
			origin = "stripe"
		}
		out = append(out, clubEntitlement{
			ID: e.ID, SKU: e.Sku, Status: e.Status, StartDate: e.StartDate, EndDate: e.EndDate, Origin: origin,
		})
	}
	return out, nil
}

// activeClubStatus returns a user's club standing across a set of SKUs. All
// SKUs — lifetime and monthly — live on plain DURABLE entitlements: this AGS
// deployment has no subscription support (platformSubscribe rejects the
// items with 40121 and the SUBSCRIPTION item type doesn't exist here — see
// dev-plan/subscription-entitlement-redesign.md), so Stripe and Apple own
// recurring billing and AGS only records the resulting access windows.
func (h *monetizationHandler) activeClubStatus(userID string, skus []string) ([]clubEntitlement, error) {
	return h.activeClubEntitlementsFiltered(userID, skus)
}

// revokeClubEntitlements revokes every currently-active entitlement the user
// holds for sku (§6.6: "charge.refunded: revoke the matching entitlement").
// Idempotent: revoked/expired entitlements no longer appear in the
// activeOnly query, so a webhook retry finds nothing left to revoke.
func (h *monetizationHandler) revokeClubEntitlements(userID, sku string) error {
	entitlements, err := h.activeClubEntitlementsFiltered(userID, []string{sku})
	if err != nil {
		return err
	}
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	for _, e := range entitlements {
		if e.ID == "" {
			continue
		}
		endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/entitlements/%s/revoke",
			h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.PathEscape(e.ID))
		req, err := http.NewRequest(http.MethodPut, endpoint, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := h.httpClient.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		status := resp.StatusCode
		resp.Body.Close()
		if status != http.StatusOK {
			return fmt.Errorf("revoke entitlement %s for %s returned %d", e.ID, userID, status)
		}
	}
	return nil
}

// fulfillmentRequest is the Platform fulfillment API's request body
// (FulfillmentRequest, justice-platform-service 6.13.0 — schema confirmed via
// the AGS CLI's bundled spec). Fulfilling by itemSku is what lets this file
// skip SKU -> itemId resolution entirely.
type fulfillmentRequest struct {
	ItemSKU   string     `json:"itemSku"`
	Quantity  int        `json:"quantity"`
	Source    string     `json:"source"`
	Origin    string     `json:"origin,omitempty"`
	StartDate *time.Time `json:"startDate,omitempty"`
	EndDate   *time.Time `json:"endDate,omitempty"`
}

// grantClubEntitlement fulfills one unit of sku to userID via
// POST /platform/admin/.../users/{userId}/fulfillment. endDate is nil for
// lifetime SKUs; for monthly SKUs it MUST be the billing period end exactly —
// reconcileDecisions re-derives the period coin txKey from the entitlement's
// endDate, so any offset between this value and the webhook's txKeyPeriod
// argument would double-credit the period's coins.
//
// NOTE: fulfillment grants whatever the item defines. Today the Club items
// are plain DURABLE items, so this grants exactly the entitlement (same
// behavior as the direct entitlement-grant call it replaced). If the store
// items are later reconfigured as bundles containing an ETHC currency
// reward, this same call would also deposit the period's coins — at that
// point the explicit creditUserWallet calls in the webhook/reconcile paths
// (and their ledger txKeys) must be removed in the same change, or every
// period would double-credit.
func (h *monetizationHandler) grantClubEntitlement(userID, sku, source, origin string, endDate *time.Time) error {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	start := time.Now().UTC()
	raw, err := json.Marshal(fulfillmentRequest{
		ItemSKU:   sku,
		Quantity:  1,
		Source:    source,
		Origin:    origin,
		StartDate: &start,
		EndDate:   endDate,
	})
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/fulfillment",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID))
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fulfill %s for %s returned %d", sku, userID, resp.StatusCode)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Wallet (Ethan Coins, currency code ETHC)
// ---------------------------------------------------------------------------

type agsWalletResponse struct {
	Balance int64 `json:"balance"`
}

func (h *monetizationHandler) getWalletBalance(userID string) (int64, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return 0, err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/wallets/currencies/summary",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return 0, nil // no wallet yet — balance is 0
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return 0, fmt.Errorf("wallet summary for %s returned %d", userID, resp.StatusCode)
	}
	// The summary response is a BARE ARRAY of per-currency wallet objects,
	// not a {data:[…]} page (live-verified 2026-07-14 — the paged shape
	// failed to decode, so every balance silently read as an error → 0).
	var summary []struct {
		CurrencyCode string `json:"currencyCode"`
		Balance      int64  `json:"balance"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&summary); err != nil {
		return 0, fmt.Errorf("decode wallet summary for %s: %w", userID, err)
	}
	for _, w := range summary {
		if strings.EqualFold(w.CurrencyCode, ethanCoinCurrency) {
			return w.Balance, nil
		}
	}
	return 0, nil
}

func (h *monetizationHandler) creditUserWallet(userID string, amount int64, source, reason string) error {
	if amount <= 0 {
		return nil
	}
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{
		"amount": amount,
		"source": source,
		"reason": clampReason(reason),
	})
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/wallets/%s/credit",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.PathEscape(ethanCoinCurrency))
	req, err := http.NewRequest(http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("credit wallet for %s returned %d", userID, resp.StatusCode)
	}
	return nil
}

var errInsufficientBalance = errors.New("insufficient wallet balance")

func isInsufficientBalanceErr(err error) bool {
	return errors.Is(err, errInsufficientBalance)
}

// debitUserWallet always calls with allowOverdraft=false and treats AGS's own
// insufficient-balance response as authoritative — this deliberately avoids a
// separate "check balance then debit" pattern, which would race under
// concurrent spends (two High Fives in flight both pass a pre-check, both
// debit, balance goes negative).
func (h *monetizationHandler) debitUserWallet(userID string, amount int64, source, reason string, allowOverdraft bool) error {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{
		"amount":         amount,
		"balanceSource":  source,
		"reason":         clampReason(reason),
		"allowOverdraft": allowOverdraft,
	})
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/wallets/currencies/%s/debit",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.PathEscape(ethanCoinCurrency))
	req, err := http.NewRequest(http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode == http.StatusBadRequest && strings.Contains(string(raw), "insufficient") {
		return errInsufficientBalance
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("debit wallet for %s returned %d: %s", userID, resp.StatusCode, string(raw))
	}
	return nil
}

// clampReason keeps the AGS wallet "reason" field (max 127 chars per its
// documented schema) safely short.
func clampReason(reason string) string {
	if len(reason) > 120 {
		return reason[:120]
	}
	return reason
}

// ---------------------------------------------------------------------------
// Stat item (kudos-received)
// ---------------------------------------------------------------------------

// incrementKudos bumps the recipient's kudos-received stat by 1. Verified
// live 2026-07-13 against justice-statistics-service 4.5.0: PUT
// /social/v2/admin/.../stats/{statCode}/statitems/value (v2, not v1) with
// body {"updateStrategy":"INCREMENT","value":<n>}.
func (h *monetizationHandler) incrementKudos(userID string) error {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"updateStrategy": "INCREMENT", "value": 1})
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/social/v2/admin/namespaces/%s/users/%s/stats/%s/statitems/value",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.PathEscape(kudosStatCode))
	req, err := http.NewRequest(http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("increment kudos for %s returned %d", userID, resp.StatusCode)
	}
	return nil
}

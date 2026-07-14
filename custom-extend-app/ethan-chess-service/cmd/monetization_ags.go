package main

// AGS Platform admin calls: item catalog (SKU -> itemId), entitlements,
// and the Ethan Coins (ETHC) wallet. Field names for write bodies (grant/credit/debit) are
// taken verbatim from the live OpenAPI spec (justice-platform-service
// 6.13.0). Read response field names (items, entitlements) were not
// available from the schema tool for GET operations, so this file decodes
// the standard AGS Platform admin-list envelope {"data":[...]} with the
// conventional per-item fields (id/sku/status/startDate/endDate) — verify
// against a live /club/status call per the M4 acceptance checklist and fix
// here only if they differ.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Item catalog cache: club-*/cos-* SKU -> AGS itemId
// ---------------------------------------------------------------------------

const itemCatalogTTL = 30 * time.Minute

type itemCatalogCache struct {
	h  *monetizationHandler
	mu sync.RWMutex

	byNamespace map[string]string // sku -> itemId, populated lazily
	loadedAt    time.Time
}

func newItemCatalogCache(h *monetizationHandler) *itemCatalogCache {
	return &itemCatalogCache{h: h, byNamespace: map[string]string{}}
}

// Note the field name: the platform items APIs return `itemId`, NOT `id`
// (live-verified 2026-07-14 — parsing `id` silently yields empty itemIds,
// which then made every SKU lookup "succeed" with an empty string and every
// downstream grant/entitlement query fail).
type agsItemsResponse struct {
	Data []struct {
		ID  string `json:"itemId"`
		SKU string `json:"sku"`
	} `json:"data"`
}

// itemID resolves a SKU to its AGS itemId, refreshing the whole /club and
// /cosmetics category tree at most once per itemCatalogTTL. There are only a
// dozen items total, so a single query per category is cheap.
func (c *itemCatalogCache) itemID(sku string) (string, error) {
	c.mu.RLock()
	stale := time.Since(c.loadedAt) > itemCatalogTTL
	id, ok := c.byNamespace[sku]
	c.mu.RUnlock()
	if ok && !stale {
		return id, nil
	}

	fresh := map[string]string{}
	for _, category := range []string{"/club", "/cosmetics"} {
		items, err := c.h.queryItemsByCategory(category)
		if err != nil {
			return "", fmt.Errorf("load item catalog %s: %w", category, err)
		}
		for _, item := range items.Data {
			// Both guards matter: an empty itemId in the map would make the
			// lookup below "succeed" with "" and break every downstream call
			// that embeds the id in a URL or grant body.
			if item.SKU != "" && item.ID != "" {
				fresh[item.SKU] = item.ID
			}
		}
	}

	c.mu.Lock()
	c.byNamespace = fresh
	c.loadedAt = time.Now()
	c.mu.Unlock()

	id, ok = fresh[sku]
	if !ok {
		return "", fmt.Errorf("sku %q not found in store", sku)
	}
	return id, nil
}

func (h *monetizationHandler) queryItemsByCategory(categoryPath string) (agsItemsResponse, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return agsItemsResponse{}, err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/items/byCriteria?categoryPath=%s&includeSubCategoryItem=true&limit=100",
		h.agsBaseURL, url.PathEscape(h.namespace), url.QueryEscape(categoryPath))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return agsItemsResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return agsItemsResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return agsItemsResponse{}, fmt.Errorf("query items %s returned %d", categoryPath, resp.StatusCode)
	}
	var out agsItemsResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return agsItemsResponse{}, fmt.Errorf("decode items %s: %w", categoryPath, err)
	}
	return out, nil
}

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

// activeClubEntitlementsFiltered queries the user's active entitlements for
// each sku. This is the sole club-standing source for ALL SKUs: lifetime ones
// have no window, monthly ones carry an endDate equal to the billing period
// end (granted per paid Stripe invoice; synced by AGS for Apple IAP). AGS's
// activeOnly filter drops expired/revoked windows on its own.
func (h *monetizationHandler) activeClubEntitlementsFiltered(userID string, skus []string) ([]clubEntitlement, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return nil, err
	}
	var out []clubEntitlement
	for _, sku := range skus {
		itemID, err := h.items.itemID(sku)
		if err != nil {
			// A SKU missing from the store (M1 not yet done, or a typo) must
			// not fail the whole status call for every other SKU.
			continue
		}
		endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/entitlements?itemId=%s&activeOnly=true&limit=10",
			h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.QueryEscape(itemID))
		req, err := http.NewRequest(http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := h.httpClient.Do(req)
		if err != nil {
			return nil, err
		}
		var parsed agsEntitlementsResponse
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&parsed)
		status := resp.StatusCode
		resp.Body.Close()
		if status != http.StatusOK {
			continue // no active entitlement for this SKU
		}
		if decodeErr != nil {
			return nil, fmt.Errorf("decode entitlements for %s: %w", sku, decodeErr)
		}
		for _, e := range parsed.Data {
			origin := ""
			switch strings.ToUpper(e.Origin) {
			case "IOS":
				origin = "apple"
			case "OTHER", "SYSTEM", "":
				origin = "stripe"
			}
			out = append(out, clubEntitlement{
				ID: e.ID, SKU: sku, Status: e.Status, StartDate: e.StartDate, EndDate: e.EndDate, Origin: origin,
			})
		}
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

type grantEntitlementRequest struct {
	ItemID        string     `json:"itemId"`
	ItemNamespace string     `json:"itemNamespace"`
	Quantity      int        `json:"quantity"`
	Source        string     `json:"source"`
	Origin        string     `json:"origin,omitempty"`
	StartDate     *time.Time `json:"startDate,omitempty"`
	EndDate       *time.Time `json:"endDate,omitempty"`
}

// grantClubEntitlement grants one unit of sku to userID. endDate is nil for
// lifetime SKUs; for monthly SKUs it MUST be the billing period end exactly —
// reconcileDecisions re-derives the period coin txKey from the entitlement's
// endDate, so any offset between this value and the webhook's txKeyPeriod
// argument would double-credit the period's coins.
func (h *monetizationHandler) grantClubEntitlement(userID, sku, source, origin string, endDate *time.Time) error {
	itemID, err := h.items.itemID(sku)
	if err != nil {
		return err
	}
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	start := time.Now().UTC()
	body := []grantEntitlementRequest{{
		ItemID:        itemID,
		ItemNamespace: h.namespace,
		Quantity:      1,
		Source:        source,
		Origin:        origin,
		StartDate:     &start,
		EndDate:       endDate,
	}}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/entitlements",
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
		return fmt.Errorf("grant entitlement %s for %s returned %d", sku, userID, resp.StatusCode)
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
	var summary struct {
		Data []struct {
			CurrencyCode string `json:"currencyCode"`
			Balance      int64  `json:"balance"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&summary); err != nil {
		return 0, fmt.Errorf("decode wallet summary for %s: %w", userID, err)
	}
	for _, w := range summary.Data {
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

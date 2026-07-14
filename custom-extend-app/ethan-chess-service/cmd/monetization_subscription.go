package main

// AGS-native Subscription integration for the two monthly club SKUs
// (club-individual-monthly, club-family-monthly). Lifetime SKUs never touch
// this file — a one-time purchase isn't a recurring subscription, so it
// stays on the plain DURABLE-entitlement grant path in monetization_ags.go.
//
// Design (live-verified 2026-07-13 against justice-platform-service 6.13.0):
//   - AGS's own payment/checkout for subscriptions requires a configured
//     real-money payment gateway (Xsolla etc.), which this Shared Cloud tier
//     does not have — confirmed by "Real Currency [USD] not allowed in
//     namespace" when attempting to provision one (see dev-plan M1 notes).
//     So we never call the public subscribe/pay flow.
//   - Instead, Stripe (web) and Apple IAP (native) remain the actual payment
//     processors, exactly as designed. The Extend service tells AGS about
//     the resulting subscription using the ADMIN "platform subscribe"
//     endpoint — "Free subscribe by platform, can used by other justice
//     service to redeem/reward the subscription" — which creates a real
//     AGS Subscription entity (queryable, cancellable, with billing
//     history) WITHOUT going through AGS's own (unavailable) payment flow.
//   - The two monthly items were updated with a `recurring: {cycle:
//     MONTHLY, ...}` block (dev-plan §3.2) to make them subscription-
//     capable; permission group g_subscription was added to the Extend
//     client's IAM permissions (dev-plan §3.4).
//
// ⚠️ ONE REMAINING LIVE-VERIFICATION GAP: platformSubscribe was confirmed
// live to accept this design's request shape and pass permission + item-type
// validation, reaching "user does not exist" (404) for a synthetic test
// user id — i.e. it got past every check except finding a real user. It has
// NOT yet been exercised end-to-end against a real user account. Do this
// before shipping: call platformSubscribeUser with a real dev account's
// userId and confirm (a) it returns 201 with a subscriptionId, (b)
// queryUserSubscriptionsBySKU then finds it as ACTIVE, (c) the response
// field names below match reality (they're the AGS Platform admin-list
// convention seen elsewhere in this package, not directly confirmed for
// this specific endpoint since the schema tool didn't return GET response
// shapes).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type agsSubscription struct {
	SubscriptionID   string `json:"subscriptionId"`
	ItemID           string `json:"itemId"`
	SKU              string `json:"sku"`
	Status           string `json:"status"`           // expected: ACTIVE | CANCELLED | EXPIRED | ...
	ChargeStatus     string `json:"chargeStatus"`     // expected: NONE | CHARGING | ...
	CurrentPeriodEnd string `json:"currentPeriodEnd"` // RFC3339 — used as the coin txKey period boundary
	NextBillingDate  string `json:"nextBillingDate"`
}

// platformSubscribeUser creates a new AGS-native subscription for userID
// against itemID (a monthly club item with a recurring config), backed by
// grantDays free days rather than AGS's own payment flow — see file header.
// Returns the new subscriptionId.
func (h *monetizationHandler) platformSubscribeUser(userID, itemID string, grantDays int, reason, source string) (string, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(map[string]any{
		"itemId":    itemID,
		"grantDays": grantDays,
		"reason":    clampReason(reason),
		"source":    source,
		"region":    "US",
		"language":  "en",
	})
	if err != nil {
		return "", err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/subscriptions/platformSubscribe",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID))
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("platformSubscribe for %s/%s returned %d: %s", userID, itemID, resp.StatusCode, string(raw))
	}
	var sub agsSubscription
	if err := json.Unmarshal(raw, &sub); err != nil {
		return "", fmt.Errorf("decode platformSubscribe response: %w", err)
	}
	if sub.SubscriptionID == "" {
		return "", fmt.Errorf("platformSubscribe for %s/%s returned no subscriptionId", userID, itemID)
	}
	return sub.SubscriptionID, nil
}

// grantSubscriptionDays extends (or, with a negative/zero days, shortens) an
// EXISTING subscription — used for renewals after the first period, so the
// same subscriptionId persists across the member's whole lifetime instead of
// minting a new one every month.
func (h *monetizationHandler) grantSubscriptionDays(userID, subscriptionID string, days int, reason string) error {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"grantDays": days, "reason": clampReason(reason)})
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/subscriptions/%s/grant",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.PathEscape(subscriptionID))
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
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("grant days to subscription %s returned %d: %s", subscriptionID, resp.StatusCode, string(raw))
	}
	return nil
}

// cancelAGSSubscription cancels a subscription — immediate=false runs it to
// the end of the current billing cycle (matches the "access until period
// end" lifecycle rule); immediate=true terminates now (used for refunds).
func (h *monetizationHandler) cancelAGSSubscription(userID, subscriptionID string, immediate bool, reason string) error {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"immediate": immediate, "reason": clampReason(reason)})
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/subscriptions/%s/cancel",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.PathEscape(subscriptionID))
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
	// 409 "not active" is a benign race (already cancelled/expired by the
	// time we got here) — not an error worth surfacing.
	if resp.StatusCode == http.StatusConflict {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("cancel subscription %s returned %d: %s", subscriptionID, resp.StatusCode, string(raw))
	}
	return nil
}

type agsSubscriptionsResponse struct {
	Data []agsSubscription `json:"data"`
}

// queryUserSubscriptionsBySKU returns the user's subscriptions for sku,
// normalized into the SAME clubEntitlement shape used for lifetime SKUs —
// this lets bestActiveEntitlement's ranking logic and computeStatus work
// identically regardless of whether a club SKU is subscription-backed
// (monthly) or entitlement-backed (lifetime).
func (h *monetizationHandler) queryUserSubscriptionsBySKU(userID, sku string) ([]clubEntitlement, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return nil, err
	}
	endpoint := fmt.Sprintf("%s/platform/admin/namespaces/%s/users/%s/subscriptions?sku=%s&limit=10",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.QueryEscape(sku))
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
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, fmt.Errorf("query subscriptions for %s/%s returned %d", userID, sku, resp.StatusCode)
	}
	var parsed agsSubscriptionsResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode subscriptions for %s/%s: %w", userID, sku, err)
	}
	out := make([]clubEntitlement, 0, len(parsed.Data))
	for _, s := range parsed.Data {
		endDate := s.CurrentPeriodEnd
		if endDate == "" {
			endDate = s.NextBillingDate
		}
		origin := "stripe"
		// AGS doesn't tag platform-subscribed subscriptions with an IAP
		// origin the way entitlements are (origin=IOS); Apple-originated
		// subscriptions are distinguished at the ledger level instead (no
		// stripeCustomerId recorded for that sku). Left "stripe" here as the
		// safe default; §7.6's monthlyOrigin lookup already falls back to
		// the ledger's stripeCustomerId presence, not this field, for the
		// double-subscription guard.
		out = append(out, clubEntitlement{
			SKU: sku, Status: normalizeSubscriptionStatus(s.Status), EndDate: endDate, Origin: origin,
		})
	}
	return out, nil
}

// normalizeSubscriptionStatus maps AGS Subscription status values onto the
// same "ACTIVE" string clubEntitlement.isActive checks for entitlements —
// keeps bestActiveEntitlement's logic source-agnostic.
func normalizeSubscriptionStatus(status string) string {
	if strings.EqualFold(status, "ACTIVE") {
		return "ACTIVE"
	}
	return status
}

// monthlyPeriodDays converts a club SKU's monthly cadence into a day count
// for grantDays/platformSubscribe. Stripe's actual invoice period (used for
// the coin txKey, see monetization_stripe.go) is the source of truth for
// WHEN a period ends; this is only the AGS-side grant length, which the
// grace-window design (monthlyGraceDuration) already tolerates being
// approximate by a few days.
const monthlyPeriodDays = 30

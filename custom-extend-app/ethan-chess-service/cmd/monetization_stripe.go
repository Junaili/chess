package main

// Stripe integration (§6.6, §7.4): Checkout Session creation, the Customer
// Portal, and the webhook. Hand-rolled against the plain Stripe HTTP API
// (form-encoded POST, Bearer secret key) rather than the official stripe-go
// SDK — this matches the rest of the service's convention of no third-party
// API SDKs (see account_deletion.go's hand-rolled Apple JWT signing). Webhook
// signature verification follows Stripe's publicly documented algorithm:
// https://stripe.com/docs/webhooks#verify-manually — a well-known, stable
// scheme, not something that needed live API verification.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const stripeWebhookTolerance = 5 * time.Minute

// ---------------------------------------------------------------------------
// Checkout + portal session creation
// ---------------------------------------------------------------------------

func (h *monetizationHandler) stripePriceIDForSKU(sku string) (string, error) {
	form := url.Values{}
	form.Set("lookup_keys[]", sku)
	form.Set("active", "true")
	raw, err := h.stripeRequest(http.MethodGet, "/v1/prices?"+form.Encode(), nil)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("decode stripe prices for %s: %w", sku, err)
	}
	if len(parsed.Data) == 0 {
		return "", fmt.Errorf("no Stripe price found with lookup_key %q", sku)
	}
	return parsed.Data[0].ID, nil
}

// createStripeCheckoutSession creates an embedded Checkout Session for sku
// and returns its client secret (for Stripe.js's createEmbeddedCheckoutPage,
// mounted inline in the Club screen — see src/club.js's openWebCheckout —
// rather than a hosted-page redirect) plus the resulting customer id (for the
// ledger's stripeCustomerId, so /club/web-portal can find it later).
func (h *monetizationHandler) createStripeCheckoutSession(userID, sku string) (clientSecret string, customerID string, err error) {
	priceID, err := h.stripePriceIDForSKU(sku)
	if err != nil {
		return "", "", err
	}
	def := clubSKUs[sku]
	mode := "payment"
	if def.Monthly {
		mode = "subscription"
	}

	form := url.Values{}
	form.Set("mode", mode)
	form.Set("client_reference_id", userID)
	form.Set("line_items[0][price]", priceID)
	form.Set("line_items[0][quantity]", "1")
	// Embedded mode takes a single return_url (fired only after a completed
	// payment) instead of hosted mode's success_url/cancel_url pair — there's
	// no cancel_url equivalent because the widget never navigates away;
	// cancelling is just the caller unmounting it.
	form.Set("ui_mode", "embedded")
	form.Set("return_url", h.webBaseURL+"/?club=success")
	// Per-session branding override (verified live against the real Checkout
	// Sessions API — it echoes these back on the created session) so the
	// embedded widget matches the app's dark theme (style.css --bg-2 /
	// --accent-2) instead of Stripe's default white/blue card.
	form.Set("branding_settings[background_color]", "#1d1820")
	form.Set("branding_settings[button_color]", "#f0c37a")
	if mode == "subscription" {
		// Metadata on the SUBSCRIPTION (not just the session) so invoice.paid
		// — which references a subscription, not a session — can recover
		// userId/sku without a reverse customer-id lookup.
		form.Set("subscription_data[metadata][userId]", userID)
		form.Set("subscription_data[metadata][sku]", sku)
	} else {
		form.Set("payment_intent_data[metadata][userId]", userID)
		form.Set("payment_intent_data[metadata][sku]", sku)
		form.Set("customer_creation", "always")
	}
	form.Set("metadata[userId]", userID)
	form.Set("metadata[sku]", sku)

	raw, err := h.stripeRequest(http.MethodPost, "/v1/checkout/sessions", form)
	if err != nil {
		return "", "", err
	}
	var session struct {
		ClientSecret string `json:"client_secret"`
		Customer     string `json:"customer"`
	}
	if err := json.Unmarshal(raw, &session); err != nil {
		return "", "", fmt.Errorf("decode checkout session: %w", err)
	}
	if session.ClientSecret == "" {
		return "", "", errors.New("stripe returned no checkout client secret")
	}
	return session.ClientSecret, session.Customer, nil
}

// cancelStripeSubscriptionsForCustomer cancels every active subscription for
// a Stripe customer — used by account deletion (§11.8) so a deleted account
// doesn't keep billing forever. Best-effort: the caller (account_deletion.go)
// logs-and-continues on failure rather than blocking deletion, per the plan.
func (h *monetizationHandler) cancelStripeSubscriptionsForCustomer(customerID string) error {
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("status", "active")
	raw, err := h.stripeRequest(http.MethodGet, "/v1/subscriptions?"+form.Encode(), nil)
	if err != nil {
		return err
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return fmt.Errorf("decode subscriptions for %s: %w", customerID, err)
	}
	var firstErr error
	for _, sub := range parsed.Data {
		if _, err := h.stripeRequest(http.MethodDelete, "/v1/subscriptions/"+url.PathEscape(sub.ID), nil); err != nil {
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

func (h *monetizationHandler) createStripePortalSession(customerID string) (string, error) {
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("return_url", h.webBaseURL+"/")
	raw, err := h.stripeRequest(http.MethodPost, "/v1/billing_portal/sessions", form)
	if err != nil {
		return "", err
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("decode portal session: %w", err)
	}
	if out.URL == "" {
		return "", errors.New("stripe returned no portal url")
	}
	return out.URL, nil
}

func (h *monetizationHandler) stripeRequest(method, path string, form url.Values) ([]byte, error) {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequest(method, "https://api.stripe.com"+path, body)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(h.stripeSecretKey, "")
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("stripe %s %s returned %d: %s", method, path, resp.StatusCode, string(raw))
	}
	return raw, nil
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

// verifyStripeSignature implements Stripe's documented manual verification:
// header is "t=<unix ts>,v1=<hex hmac>[,v1=<hex hmac>...]"; the signed
// payload is "<ts>.<raw body>", HMAC-SHA256 with the webhook secret.
func verifyStripeSignature(payload []byte, header, secret string, now time.Time) error {
	var timestamp int64
	var signatures []string
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			ts, err := strconv.ParseInt(kv[1], 10, 64)
			if err != nil {
				return errors.New("invalid stripe signature timestamp")
			}
			timestamp = ts
		case "v1":
			signatures = append(signatures, kv[1])
		}
	}
	if timestamp == 0 || len(signatures) == 0 {
		return errors.New("malformed stripe signature header")
	}
	age := now.Sub(time.Unix(timestamp, 0))
	if age < 0 {
		age = -age
	}
	if age > stripeWebhookTolerance {
		return errors.New("stripe signature timestamp outside tolerance")
	}

	signedPayload := fmt.Sprintf("%d.%s", timestamp, payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signedPayload))
	expected := hex.EncodeToString(mac.Sum(nil))

	for _, sig := range signatures {
		if subtle.ConstantTimeCompare([]byte(sig), []byte(expected)) == 1 {
			return nil
		}
	}
	return errors.New("stripe signature mismatch")
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

type stripeEvent struct {
	Type string `json:"type"`
	Data struct {
		Object json.RawMessage `json:"object"`
	} `json:"data"`
}

func (h *monetizationHandler) stripeWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMonetizationError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 256<<10))
	if err != nil {
		writeMonetizationError(w, http.StatusBadRequest, "invalid_body", "Could not read webhook body.")
		return
	}
	if err := verifyStripeSignature(raw, r.Header.Get("Stripe-Signature"), h.stripeWebhookSecret, h.now()); err != nil {
		writeMonetizationError(w, http.StatusBadRequest, "invalid_signature", "Invalid webhook signature.")
		return
	}

	var event stripeEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		writeMonetizationError(w, http.StatusBadRequest, "invalid_event", "Could not parse webhook event.")
		return
	}

	var handleErr error
	switch event.Type {
	case "checkout.session.completed":
		handleErr = h.handleCheckoutCompleted(event.Data.Object)
	case "invoice.paid":
		handleErr = h.handleInvoicePaid(event.Data.Object)
	case "charge.refunded":
		handleErr = h.handleChargeRefunded(event.Data.Object)
	case "customer.subscription.deleted":
		handleErr = h.handleSubscriptionDeleted(event.Data.Object)
	}
	if handleErr != nil {
		// Non-2xx makes Stripe retry with backoff for days AND surfaces the
		// failure in Stripe's own webhook dashboard. The 2026-07-14 outage
		// (every invoice.paid dying on a dead AGS call) went unnoticed
		// precisely because this used to log-and-200.
		fmt.Printf("[monetization] stripe webhook %s failed (Stripe will retry): %v\n", event.Type, handleErr)
		writeMonetizationError(w, http.StatusInternalServerError, "webhook_failed", "Webhook processing failed.")
		return
	}
	w.WriteHeader(http.StatusOK)
}

type stripeCheckoutSessionObject struct {
	Mode              string `json:"mode"`
	ClientReferenceID string `json:"client_reference_id"`
	Customer          string `json:"customer"`
	Metadata          struct {
		UserID string `json:"userId"`
		SKU    string `json:"sku"`
	} `json:"metadata"`
	ID string `json:"id"`
}

func (h *monetizationHandler) handleCheckoutCompleted(raw json.RawMessage) error {
	var session stripeCheckoutSessionObject
	if err := json.Unmarshal(raw, &session); err != nil {
		return fmt.Errorf("decode checkout session: %w", err)
	}
	if session.Mode != "payment" {
		return nil // subscription mode is handled by invoice.paid instead
	}
	userID := firstNonEmpty(session.ClientReferenceID, session.Metadata.UserID)
	sku := session.Metadata.SKU
	if userID == "" || !isClubSKU(sku) {
		return fmt.Errorf("checkout session %s missing userId/sku metadata", session.ID)
	}

	if session.Customer != "" {
		if _, _, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
			if l.StripeCustomerID == session.Customer {
				return false
			}
			l.StripeCustomerID = session.Customer
			return true
		}); err != nil {
			return fmt.Errorf("persist stripeCustomerId: %w", err)
		}
	}

	lifetimeKey := txKeyLifetime(sku)
	replayKey := "stripe-session:" + session.ID
	ledger, _, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
		if _, exists := l.Credits[replayKey]; exists {
			return false // this exact webhook delivery already handled
		}
		l.Credits[replayKey] = ledgerEntry{Amount: 0, At: timeNowISO(h.now()), Kind: "stripe-session-replay-guard"}
		return true
	})
	if err != nil {
		return fmt.Errorf("replay-guard ledger write: %w", err)
	}
	if _, alreadyCredited := ledger.Credits[lifetimeKey]; alreadyCredited {
		return nil // reconciliation or a prior delivery already credited this lifetime grant — this
		// check is safe (unlike the one below) because it reads a DIFFERENT key than the one just
		// written above, so `ledger`'s reflection of current reality is meaningful here.
	}

	if err := h.grantClubEntitlement(userID, sku, "PURCHASE", "Other", nil); err != nil {
		return fmt.Errorf("grant lifetime entitlement: %w", err)
	}
	def := clubSKUs[sku]
	_, wrote, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
		if _, exists := l.Credits[lifetimeKey]; exists {
			return false
		}
		l.Credits[lifetimeKey] = ledgerEntry{Amount: def.Coins, At: timeNowISO(h.now()), Kind: "club-lifetime"}
		return true
	})
	if err != nil {
		return fmt.Errorf("ledger lifetime credit: %w", err)
	}
	if !wrote {
		return nil // a concurrent call already credited this lifetime grant — do NOT credit the wallet again
	}
	if err := h.creditUserWallet(userID, int64(def.Coins), "PURCHASE", "club:"+lifetimeKey); err != nil {
		_, _, _ = h.mutateLedger(userID, func(l *monetizationLedger) bool {
			if _, exists := l.Credits[lifetimeKey]; !exists {
				return false
			}
			delete(l.Credits, lifetimeKey)
			return true
		})
		return fmt.Errorf("wallet credit lifetime: %w", err)
	}
	return nil
}

type stripeInvoiceObject struct {
	ID           string `json:"id"`
	Subscription string `json:"subscription"`
	AmountPaid   int64  `json:"amount_paid"`
	Lines        struct {
		Data []struct {
			Period struct {
				End int64 `json:"end"`
			} `json:"period"`
		} `json:"data"`
	} `json:"lines"`
}

func (h *monetizationHandler) handleInvoicePaid(raw json.RawMessage) error {
	var invoice stripeInvoiceObject
	if err := json.Unmarshal(raw, &invoice); err != nil {
		return fmt.Errorf("decode invoice: %w", err)
	}
	if invoice.Subscription == "" {
		return nil // not a subscription invoice
	}

	subRaw, err := h.stripeRequest(http.MethodGet, "/v1/subscriptions/"+url.PathEscape(invoice.Subscription), nil)
	if err != nil {
		return fmt.Errorf("fetch subscription %s: %w", invoice.Subscription, err)
	}
	var sub struct {
		Metadata struct {
			UserID string `json:"userId"`
			SKU    string `json:"sku"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(subRaw, &sub); err != nil {
		return fmt.Errorf("decode subscription %s: %w", invoice.Subscription, err)
	}
	userID, sku := sub.Metadata.UserID, sub.Metadata.SKU
	if userID == "" || !isClubSKU(sku) {
		return fmt.Errorf("subscription %s missing userId/sku metadata", invoice.Subscription)
	}

	replayKey := "stripe-invoice:" + invoice.ID
	if _, _, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
		if _, exists := l.Debits[replayKey]; exists { // reuse Debits map as a 0-amount replay-guard bucket
			return false
		}
		l.Debits[replayKey] = ledgerEntry{Amount: 0, At: timeNowISO(h.now()), Kind: "stripe-invoice-replay-guard"}
		return true
	}); err != nil {
		return fmt.Errorf("replay-guard ledger write: %w", err)
	} // if this races with a duplicate delivery, the redundant grant call below is a harmless no-op
	// (re-extending the same window); the wallet credit itself is still gated on `wrote` below.

	var periodEnd int64
	if len(invoice.Lines.Data) > 0 {
		periodEnd = invoice.Lines.Data[0].Period.End
	}
	if periodEnd == 0 {
		return fmt.Errorf("invoice %s has no line-item period end", invoice.ID)
	}
	endDateISO := time.Unix(periodEnd, 0).UTC().Format(time.RFC3339)

	// Time-boxed DURABLE entitlement, windowed to the Stripe billing period
	// (dev-plan/subscription-entitlement-redesign.md — this AGS deployment
	// has no subscription support, so Stripe alone owns recurring billing).
	// Renewals grant a fresh window; expired windows drop out of AGS queries
	// on their own. The endDate is the same instant txKeyPeriod keys the
	// coin credit with below — reconcileDecisions re-derives that key from
	// the entitlement's endDate, and a mismatch would double-credit.
	end := time.Unix(periodEnd, 0).UTC()
	if err := h.grantClubEntitlement(userID, sku, "PURCHASE", "Other", &end); err != nil {
		return fmt.Errorf("grant period entitlement for %s/%s: %w", userID, sku, err)
	}

	if invoice.AmountPaid <= 0 {
		return nil // $0 invoice (e.g. a coupon) — extend access, no coins
	}
	periodKey := txKeyPeriod(sku, endDateISO)
	_, wrote, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
		if _, exists := l.Credits[periodKey]; exists {
			return false
		}
		l.Credits[periodKey] = ledgerEntry{Amount: int(invoice.AmountPaid), At: timeNowISO(h.now()), Kind: "club-period"}
		return true
	})
	if err != nil {
		return fmt.Errorf("ledger period credit: %w", err)
	}
	if !wrote {
		return nil // someone else (a concurrent reconciliation pass, or a replayed delivery) already credited this exact period
	}
	if err := h.creditUserWallet(userID, invoice.AmountPaid, "PURCHASE", "club:"+periodKey); err != nil {
		_, _, _ = h.mutateLedger(userID, func(l *monetizationLedger) bool {
			if _, exists := l.Credits[periodKey]; !exists {
				return false
			}
			delete(l.Credits, periodKey)
			return true
		})
		return fmt.Errorf("wallet credit period: %w", err)
	}
	return nil
}

type stripeSubscriptionObject struct {
	ID       string `json:"id"`
	Metadata struct {
		UserID string `json:"userId"`
		SKU    string `json:"sku"`
	} `json:"metadata"`
}

// handleSubscriptionDeleted needs no AGS call at all: monthly access is a
// time-boxed entitlement that lapses at its period end on its own, which IS
// the "access until period end" cancellation rule (§11). Kept as a handled
// event so the Stripe webhook config stays unchanged and the cancellation is
// visible in the service log.
func (h *monetizationHandler) handleSubscriptionDeleted(raw json.RawMessage) error {
	var sub stripeSubscriptionObject
	if err := json.Unmarshal(raw, &sub); err != nil {
		return fmt.Errorf("decode subscription: %w", err)
	}
	userID, sku := sub.Metadata.UserID, sub.Metadata.SKU
	if userID == "" || !isClubSKU(sku) {
		return nil // not a Club subscription
	}
	fmt.Printf("[monetization] stripe subscription %s (%s/%s) cancelled — access lapses when the current entitlement window ends\n", sub.ID, userID, sku)
	return nil
}

type stripeChargeObject struct {
	ID            string `json:"id"`
	PaymentIntent string `json:"payment_intent"`
	Metadata      struct {
		UserID string `json:"userId"`
		SKU    string `json:"sku"`
	} `json:"metadata"`
}

func (h *monetizationHandler) handleChargeRefunded(raw json.RawMessage) error {
	var charge stripeChargeObject
	if err := json.Unmarshal(raw, &charge); err != nil {
		return fmt.Errorf("decode charge: %w", err)
	}
	userID, sku := charge.Metadata.UserID, charge.Metadata.SKU
	if userID == "" || !isClubSKU(sku) {
		return nil // not a Club charge (or a subscription-invoice charge, which lacks this metadata by design — those refunds are handled by the Apple/Stripe cancellation path instead of this hook)
	}

	lifetimeKey := txKeyLifetime(sku)
	clawKey := txKeyClawback(lifetimeKey)
	ledger, _, err := h.readLedger(userID)
	if err != nil {
		return fmt.Errorf("read ledger: %w", err)
	}
	entry, credited := ledger.Credits[lifetimeKey]
	if !credited {
		return nil
	}
	if _, already := ledger.Debits[clawKey]; already {
		return nil
	}

	// §6.6: a refund revokes the entitlement itself, not just the coins.
	// Runs BEFORE the coin clawback is reserved so a failure here leaves the
	// whole handler retryable (Stripe redelivers on our 5xx; the clawKey
	// guard hasn't been written yet, and re-revoking is a no-op).
	if err := h.revokeClubEntitlements(userID, sku); err != nil {
		return fmt.Errorf("revoke entitlements for %s/%s: %w", userID, sku, err)
	}

	balance, err := h.getWalletBalance(userID)
	if err != nil {
		return fmt.Errorf("wallet balance: %w", err)
	}
	amount := int64(entry.Amount)
	if amount > balance {
		amount = balance
	}
	if amount <= 0 {
		return nil
	}

	// Ledger-first (§6.4 ordering, same fix as applyClawbacks): reserve the
	// clawback under a fresh, concurrency-checked write BEFORE debiting the
	// wallet, so a webhook replay racing this exact handler can't both pass
	// the stale-snapshot check above and both debit.
	_, wrote, err := h.mutateLedger(userID, func(l *monetizationLedger) bool {
		if _, exists := l.Debits[clawKey]; exists {
			return false
		}
		l.Debits[clawKey] = ledgerEntry{Amount: int(amount), At: timeNowISO(h.now()), Kind: "clawback"}
		return true
	})
	if err != nil {
		return fmt.Errorf("clawback ledger write: %w", err)
	}
	if !wrote {
		return nil // a concurrent/replayed delivery already applied this clawback
	}
	if err := h.debitUserWallet(userID, amount, "OTHER", "refund-clawback:"+lifetimeKey, true); err != nil {
		_, _, _ = h.mutateLedger(userID, func(l *monetizationLedger) bool {
			if _, exists := l.Debits[clawKey]; !exists {
				return false
			}
			delete(l.Debits, clawKey)
			return true
		})
		return fmt.Errorf("clawback debit: %w", err)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func signStripePayload(secret string, timestamp int64, payload []byte) string {
	signedPayload := fmt.Sprintf("%d.%s", timestamp, payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signedPayload))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyStripeSignatureAccepts(t *testing.T) {
	secret := "whsec_test"
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	payload := []byte(`{"type":"checkout.session.completed"}`)
	sig := signStripePayload(secret, now.Unix(), payload)
	header := fmt.Sprintf("t=%d,v1=%s", now.Unix(), sig)

	if err := verifyStripeSignature(payload, header, secret, now); err != nil {
		t.Fatalf("expected valid signature to pass, got %v", err)
	}
}

func TestVerifyStripeSignatureRejectsWrongSecret(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	payload := []byte(`{"type":"checkout.session.completed"}`)
	sig := signStripePayload("whsec_other", now.Unix(), payload)
	header := fmt.Sprintf("t=%d,v1=%s", now.Unix(), sig)

	if err := verifyStripeSignature(payload, header, "whsec_test", now); err == nil {
		t.Fatal("expected signature mismatch to fail")
	}
}

func TestVerifyStripeSignatureRejectsTamperedPayload(t *testing.T) {
	secret := "whsec_test"
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	sig := signStripePayload(secret, now.Unix(), []byte(`{"type":"checkout.session.completed"}`))
	header := fmt.Sprintf("t=%d,v1=%s", now.Unix(), sig)

	tampered := []byte(`{"type":"charge.refunded"}`)
	if err := verifyStripeSignature(tampered, header, secret, now); err == nil {
		t.Fatal("expected tampered payload to fail verification")
	}
}

func TestVerifyStripeSignatureRejectsStaleTimestamp(t *testing.T) {
	secret := "whsec_test"
	eventTime := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	payload := []byte(`{"type":"invoice.paid"}`)
	sig := signStripePayload(secret, eventTime.Unix(), payload)
	header := fmt.Sprintf("t=%d,v1=%s", eventTime.Unix(), sig)

	tenMinutesLater := eventTime.Add(10 * time.Minute)
	if err := verifyStripeSignature(payload, header, secret, tenMinutesLater); err == nil {
		t.Fatal("expected a timestamp outside tolerance to fail")
	}
}

func TestVerifyStripeSignatureMalformedHeader(t *testing.T) {
	if err := verifyStripeSignature([]byte("{}"), "garbage", "secret", time.Now()); err == nil {
		t.Fatal("expected malformed header to fail")
	}
	if err := verifyStripeSignature([]byte("{}"), "", "secret", time.Now()); err == nil {
		t.Fatal("expected empty header to fail")
	}
}

// ---------------------------------------------------------------------------
// Webhook end-to-end dispatch, with a fake Stripe + AGS transport.
// ---------------------------------------------------------------------------

type stripeWebhookRoundTripper struct {
	ledger             map[string]json.RawMessage
	ledgerUpdated      map[string]string
	entitlements       int
	credits            int
	debits             int
	revokes            int
	subscription       string // canned GET /v1/subscriptions/{id} response (Stripe)
	activeEntitlements string // canned GET /entitlements response (AGS)
	entitlementStatus  int    // non-zero forces the entitlement grant POST to fail with this code
}

func (f *stripeWebhookRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	switch {
	case req.URL.Path == "/iam/v3/oauth/token":
		return jsonResponse(200, `{"access_token":"server-token"}`), nil
	case req.URL.Host == "api.stripe.com" && strings.HasPrefix(req.URL.Path, "/v1/subscriptions/"):
		return jsonResponse(200, f.subscription), nil
	case strings.Contains(req.URL.Path, "/entitlements/") && strings.HasSuffix(req.URL.Path, "/revoke"):
		f.revokes++
		return jsonResponse(200, `{"status":"REVOKED"}`), nil
	case strings.Contains(req.URL.Path, "/entitlements") && req.Method == http.MethodGet:
		if f.activeEntitlements == "" {
			return jsonResponse(200, `{"data":[]}`), nil
		}
		return jsonResponse(200, f.activeEntitlements), nil
	case strings.Contains(req.URL.Path, "/items/byCriteria"):
		if strings.Contains(req.URL.RawQuery, "%2Fclub") || strings.Contains(req.URL.RawQuery, "/club") {
			return jsonResponse(200, `{"data":[
				{"id":"item-individual-monthly","sku":"club-individual-monthly"},
				{"id":"item-individual-lifetime","sku":"club-individual-lifetime"},
				{"id":"item-family-monthly","sku":"club-family-monthly"},
				{"id":"item-family-lifetime","sku":"club-family-lifetime"}
			]}`), nil
		}
		return jsonResponse(200, `{"data":[]}`), nil
	case strings.Contains(req.URL.Path, "/entitlements") && req.Method == http.MethodPost:
		f.entitlements++
		if f.entitlementStatus != 0 {
			return jsonResponse(f.entitlementStatus, `{"errorCode":40121}`), nil
		}
		return jsonResponse(201, `{}`), nil
	case strings.Contains(req.URL.Path, "/wallets/") && strings.HasSuffix(req.URL.Path, "/credit"):
		f.credits++
		return jsonResponse(200, `{}`), nil
	case strings.Contains(req.URL.Path, "/wallets/") && strings.HasSuffix(req.URL.Path, "/debit"):
		f.debits++
		return jsonResponse(200, `{}`), nil
	case strings.HasSuffix(req.URL.Path, "/wallets/currencies/summary"):
		return jsonResponse(200, `{"data":[{"currencyCode":"ETHC","balance":5000}]}`), nil
	case strings.Contains(req.URL.Path, "adminrecords/"):
		// Matches both the plain GET path (getAdminPlayerRecord) and the
		// concurrent PUT path (putAdminPlayerRecordConcurrent) — see the
		// identical comment in monetization_openjournal_test.go. The two
		// paths differ by a "/concurrent" segment, so normalize it out of
		// the map key or a PUT and the following GET would address two
		// different "records".
		key := strings.Replace(req.URL.Path, "/concurrent/adminrecords/", "/adminrecords/", 1)
		if req.Method == http.MethodGet {
			raw, ok := f.ledger[key]
			if !ok {
				return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
			}
			body, _ := json.Marshal(map[string]any{"value": raw, "updatedAt": f.ledgerUpdated[key]})
			return jsonResponse(200, string(body)), nil
		}
		raw, _ := io.ReadAll(req.Body)
		var body struct {
			Value     json.RawMessage `json:"value"`
			UpdatedAt string          `json:"updatedAt"`
		}
		_ = json.Unmarshal(raw, &body)
		if f.ledger == nil {
			f.ledger = map[string]json.RawMessage{}
			f.ledgerUpdated = map[string]string{}
		}
		f.ledger[key] = body.Value
		f.ledgerUpdated[key] = time.Now().UTC().Format(time.RFC3339Nano)
		return jsonResponse(200, `{}`), nil
	}
	return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
}

func TestHandleInvoicePaidGrantsAndCreditsOnce(t *testing.T) {
	transport := &stripeWebhookRoundTripper{
		subscription: `{"metadata":{"userId":"user-1","sku":"club-individual-monthly"}}`,
	}
	h := testMonetizationHandler(transport)
	h.stripeSecretKey = "sk_test"

	invoice := stripeInvoiceObject{
		ID:           "in_123",
		Subscription: "sub_123",
		AmountPaid:   299,
	}
	invoice.Lines.Data = []struct {
		Period struct {
			End int64 `json:"end"`
		} `json:"period"`
	}{{Period: struct {
		End int64 `json:"end"`
	}{End: time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC).Unix()}}}
	raw, _ := json.Marshal(invoice)

	if err := h.handleInvoicePaid(raw); err != nil {
		t.Fatal(err)
	}
	if transport.entitlements != 1 {
		t.Fatalf("expected exactly 1 entitlement grant (windowed to the invoice period end), got %d", transport.entitlements)
	}
	if transport.credits != 1 {
		t.Fatalf("expected exactly 1 wallet credit, got %d", transport.credits)
	}

	// Replaying the SAME invoice event (Stripe retries / redelivers) must not
	// double-credit. The entitlement grant DOES run again — a second grant of
	// the identical absolute window is harmless (queries just see two
	// entitlements covering the same period) and keeps a crashed-after-guard
	// first delivery recoverable.
	if err := h.handleInvoicePaid(raw); err != nil {
		t.Fatal(err)
	}
	if transport.entitlements != 2 {
		t.Fatalf("expected the replay to re-grant the same window (crash-recovery property), got %d grants", transport.entitlements)
	}
	if transport.credits != 1 {
		t.Fatalf("expected replay to skip the credit, still got %d", transport.credits)
	}
}

func TestHandleInvoicePaidRenewalGrantsNewWindow(t *testing.T) {
	existingLedger, _ := json.Marshal(monetizationLedger{
		Credits: map[string]ledgerEntry{"period:club-individual-monthly:2026-08-11T00:00:00Z": {Amount: 299, Kind: "club-period"}},
		Debits:  map[string]ledgerEntry{},
	})
	transport := &stripeWebhookRoundTripper{
		subscription:  `{"metadata":{"userId":"user-1","sku":"club-individual-monthly"}}`,
		ledger:        map[string]json.RawMessage{"/cloudsave/v1/admin/namespaces/chess/users/user-1/adminrecords/monetization-ledger": existingLedger},
		ledgerUpdated: map[string]string{"/cloudsave/v1/admin/namespaces/chess/users/user-1/adminrecords/monetization-ledger": "2026-08-11T00:00:00Z"},
	}
	h := testMonetizationHandler(transport)
	h.stripeSecretKey = "sk_test"

	// A SECOND, later invoice — the next month's renewal grants a FRESH
	// entitlement window; the previous one lapses on its own.
	invoice := stripeInvoiceObject{ID: "in_renewal", Subscription: "sub_123", AmountPaid: 299}
	invoice.Lines.Data = []struct {
		Period struct {
			End int64 `json:"end"`
		} `json:"period"`
	}{{Period: struct {
		End int64 `json:"end"`
	}{End: time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC).Unix()}}}
	raw, _ := json.Marshal(invoice)

	if err := h.handleInvoicePaid(raw); err != nil {
		t.Fatal(err)
	}
	if transport.entitlements != 1 {
		t.Fatalf("expected exactly 1 entitlement grant for the renewal's new window, got %d", transport.entitlements)
	}
	if transport.credits != 1 {
		t.Fatalf("expected the new period to be credited once, got %d", transport.credits)
	}
}

func TestHandleInvoicePaidSkipsZeroAmountInvoice(t *testing.T) {
	transport := &stripeWebhookRoundTripper{
		subscription: `{"metadata":{"userId":"user-1","sku":"club-individual-monthly"}}`,
	}
	h := testMonetizationHandler(transport)
	h.stripeSecretKey = "sk_test"

	invoice := stripeInvoiceObject{ID: "in_free", Subscription: "sub_123", AmountPaid: 0}
	invoice.Lines.Data = []struct {
		Period struct {
			End int64 `json:"end"`
		} `json:"period"`
	}{{Period: struct {
		End int64 `json:"end"`
	}{End: time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC).Unix()}}}
	raw, _ := json.Marshal(invoice)

	if err := h.handleInvoicePaid(raw); err != nil {
		t.Fatal(err)
	}
	if transport.entitlements != 1 {
		t.Fatalf("expected the entitlement window to still be granted even for a $0 invoice, got %d", transport.entitlements)
	}
	if transport.credits != 0 {
		t.Fatalf("expected NO coin credit for a $0 invoice, got %d", transport.credits)
	}
}

func TestHandleSubscriptionDeletedNeedsNoAGSCall(t *testing.T) {
	// Cancellation is "access until period end" — the time-boxed entitlement
	// lapses on its own, so the handler must touch nothing in AGS.
	transport := &stripeWebhookRoundTripper{}
	h := testMonetizationHandler(transport)

	sub := stripeSubscriptionObject{ID: "sub_123"}
	sub.Metadata.UserID = "user-1"
	sub.Metadata.SKU = "club-individual-monthly"
	raw, _ := json.Marshal(sub)

	if err := h.handleSubscriptionDeleted(raw); err != nil {
		t.Fatal(err)
	}
	if transport.entitlements != 0 || transport.revokes != 0 || transport.credits != 0 || transport.debits != 0 {
		t.Fatalf("expected no AGS traffic at all, got grants=%d revokes=%d credits=%d debits=%d",
			transport.entitlements, transport.revokes, transport.credits, transport.debits)
	}
}

func TestHandleChargeRefundedRevokesEntitlementAndClawsBackCoins(t *testing.T) {
	existingLedger, _ := json.Marshal(monetizationLedger{
		Credits: map[string]ledgerEntry{"life:club-individual-lifetime": {Amount: 2999, Kind: "club-lifetime"}},
		Debits:  map[string]ledgerEntry{},
	})
	transport := &stripeWebhookRoundTripper{
		ledger:             map[string]json.RawMessage{"/cloudsave/v1/admin/namespaces/chess/users/user-1/adminrecords/monetization-ledger": existingLedger},
		ledgerUpdated:      map[string]string{"/cloudsave/v1/admin/namespaces/chess/users/user-1/adminrecords/monetization-ledger": "2026-07-11T00:00:00Z"},
		activeEntitlements: `{"data":[{"id":"ent-life-1","status":"ACTIVE","sku":"club-individual-lifetime"}]}`,
	}
	h := testMonetizationHandler(transport)

	charge := stripeChargeObject{ID: "ch_1"}
	charge.Metadata.UserID = "user-1"
	charge.Metadata.SKU = "club-individual-lifetime"
	raw, _ := json.Marshal(charge)

	if err := h.handleChargeRefunded(raw); err != nil {
		t.Fatal(err)
	}
	if transport.revokes != 1 {
		t.Fatalf("expected the refunded entitlement to be revoked (§6.6), got %d revokes", transport.revokes)
	}
	if transport.debits != 1 {
		t.Fatalf("expected exactly 1 coin clawback debit, got %d", transport.debits)
	}

	// Replay: the clawKey guard must keep it single-shot; the (idempotent)
	// revoke pass runs again but the activeOnly query is what makes a real
	// AGS re-revoke a no-op — the fake still answers, so only assert coins.
	if err := h.handleChargeRefunded(raw); err != nil {
		t.Fatal(err)
	}
	if transport.debits != 1 {
		t.Fatalf("expected the replayed refund to skip the clawback, got %d debits", transport.debits)
	}
}

func TestStripeWebhookReturns500OnHandlerFailure(t *testing.T) {
	// A failing downstream call (here: the entitlement grant, the exact call
	// that died in the 2026-07-14 outage) must surface as a non-2xx so
	// Stripe retries and its dashboard shows the failure.
	transport := &stripeWebhookRoundTripper{
		subscription:      `{"metadata":{"userId":"user-1","sku":"club-individual-monthly"}}`,
		entitlementStatus: 400,
	}
	h := testMonetizationHandler(transport)
	h.stripeWebhookSecret = "whsec_test"

	payload := []byte(`{"type":"invoice.paid","data":{"object":{"id":"in_500","subscription":"sub_123","amount_paid":299,"lines":{"data":[{"period":{"end":1786406400}}]}}}}`)
	now := h.now()
	sig := signStripePayload("whsec_test", now.Unix(), payload)

	req := httptest.NewRequest(http.MethodPost, "/stripe/webhook", bytes.NewReader(payload))
	req.Header.Set("Stripe-Signature", fmt.Sprintf("t=%d,v1=%s", now.Unix(), sig))
	rec := httptest.NewRecorder()
	h.stripeWebhook(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for a failed handler (so Stripe retries), got %d — body: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleCheckoutCompletedIgnoresSubscriptionMode(t *testing.T) {
	transport := &stripeWebhookRoundTripper{}
	h := testMonetizationHandler(transport)
	h.stripeSecretKey = "sk_test"

	session := stripeCheckoutSessionObject{Mode: "subscription", ID: "cs_1", ClientReferenceID: "user-1"}
	raw, _ := json.Marshal(session)
	if err := h.handleCheckoutCompleted(raw); err != nil {
		t.Fatal(err)
	}
	if transport.entitlements != 0 || transport.credits != 0 {
		t.Fatalf("subscription-mode checkout.session.completed must be a no-op (invoice.paid handles it), got grants=%d credits=%d", transport.entitlements, transport.credits)
	}
}

func TestHandleCheckoutCompletedRejectsMissingMetadata(t *testing.T) {
	h := testMonetizationHandler(&stripeWebhookRoundTripper{})
	session := stripeCheckoutSessionObject{Mode: "payment", ID: "cs_2"} // no client_reference_id, no metadata
	raw, _ := json.Marshal(session)
	if err := h.handleCheckoutCompleted(raw); err == nil {
		t.Fatal("expected an error for a checkout session with no recoverable userId/sku")
	}
}

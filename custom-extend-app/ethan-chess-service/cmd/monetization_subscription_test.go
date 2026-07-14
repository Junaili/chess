package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type subscriptionAPIRoundTripper struct {
	subscribeStatus int
	subscribeBody   string
	grantStatus     int
	cancelStatus    int
	queryBody       string // canned GET .../subscriptions response
	queryStatus     int
}

func (f *subscriptionAPIRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Path == "/iam/v3/oauth/token" {
		return jsonResponse(200, `{"access_token":"server-token"}`), nil
	}
	switch {
	case strings.HasSuffix(req.URL.Path, "/subscriptions/platformSubscribe"):
		status := f.subscribeStatus
		if status == 0 {
			status = 201
		}
		body := f.subscribeBody
		if body == "" {
			body = `{"subscriptionId":"ags-sub-1"}`
		}
		return jsonResponse(status, body), nil
	case strings.HasSuffix(req.URL.Path, "/grant"):
		status := f.grantStatus
		if status == 0 {
			status = 200
		}
		return jsonResponse(status, `{"subscriptionId":"ags-sub-1"}`), nil
	case strings.HasSuffix(req.URL.Path, "/cancel"):
		status := f.cancelStatus
		if status == 0 {
			status = 200
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
	case strings.HasSuffix(req.URL.Path, "/subscriptions"):
		status := f.queryStatus
		if status == 0 {
			status = 200
		}
		return jsonResponse(status, f.queryBody), nil
	}
	return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
}

func TestPlatformSubscribeUserReturnsSubscriptionID(t *testing.T) {
	transport := &subscriptionAPIRoundTripper{subscribeBody: `{"subscriptionId":"ags-sub-42"}`}
	h := testMonetizationHandler(transport)

	id, err := h.platformSubscribeUser("user-1", "item-1", 30, "test", "STRIPE")
	if err != nil {
		t.Fatal(err)
	}
	if id != "ags-sub-42" {
		t.Fatalf("subscriptionId = %q, want ags-sub-42", id)
	}
}

func TestPlatformSubscribeUserErrorsOnMissingSubscriptionID(t *testing.T) {
	transport := &subscriptionAPIRoundTripper{subscribeBody: `{}`}
	h := testMonetizationHandler(transport)

	if _, err := h.platformSubscribeUser("user-1", "item-1", 30, "test", "STRIPE"); err == nil {
		t.Fatal("expected an error when AGS returns no subscriptionId")
	}
}

func TestPlatformSubscribeUserPropagatesHTTPError(t *testing.T) {
	transport := &subscriptionAPIRoundTripper{subscribeStatus: 400, subscribeBody: `{"errorCode":40121,"errorMessage":"Item type does not support"}`}
	h := testMonetizationHandler(transport)

	if _, err := h.platformSubscribeUser("user-1", "item-1", 30, "test", "STRIPE"); err == nil {
		t.Fatal("expected an error on a non-2xx platformSubscribe response")
	}
}

func TestCancelAGSSubscriptionTreatsConflictAsBenign(t *testing.T) {
	transport := &subscriptionAPIRoundTripper{cancelStatus: 409}
	h := testMonetizationHandler(transport)

	// A 409 (subscription already not-active) must not surface as an error —
	// it's a benign race, not a failure worth retrying/alerting on.
	if err := h.cancelAGSSubscription("user-1", "ags-sub-1", false, "test"); err != nil {
		t.Fatalf("expected 409 to be treated as success, got %v", err)
	}
}

func TestCancelAGSSubscriptionPropagatesOtherErrors(t *testing.T) {
	transport := &subscriptionAPIRoundTripper{cancelStatus: 500}
	h := testMonetizationHandler(transport)

	if err := h.cancelAGSSubscription("user-1", "ags-sub-1", false, "test"); err == nil {
		t.Fatal("expected a 500 to surface as an error")
	}
}

func TestQueryUserSubscriptionsBySKUNormalizesToClubEntitlement(t *testing.T) {
	transport := &subscriptionAPIRoundTripper{
		queryBody: `{"data":[{"subscriptionId":"ags-sub-1","itemId":"item-1","status":"ACTIVE","currentPeriodEnd":"2026-08-11T00:00:00Z"}]}`,
	}
	h := testMonetizationHandler(transport)

	out, err := h.queryUserSubscriptionsBySKU("user-1", "club-individual-monthly")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 normalized entitlement, got %d", len(out))
	}
	e := out[0]
	if e.SKU != "club-individual-monthly" || e.Status != "ACTIVE" || e.EndDate != "2026-08-11T00:00:00Z" {
		t.Fatalf("unexpected normalization: %#v", e)
	}
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	if !e.isActive(now) {
		t.Fatal("expected the normalized subscription to report active via the shared isActive logic")
	}
}

func TestQueryUserSubscriptionsBySKUFallsBackToNextBillingDate(t *testing.T) {
	transport := &subscriptionAPIRoundTripper{
		queryBody: `{"data":[{"subscriptionId":"ags-sub-1","itemId":"item-1","status":"ACTIVE","nextBillingDate":"2026-08-11T00:00:00Z"}]}`,
	}
	h := testMonetizationHandler(transport)

	out, err := h.queryUserSubscriptionsBySKU("user-1", "club-individual-monthly")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].EndDate != "2026-08-11T00:00:00Z" {
		t.Fatalf("expected nextBillingDate fallback, got %#v", out)
	}
}

func TestQueryUserSubscriptionsBySKUNoSubscriptionsIsEmpty(t *testing.T) {
	transport := &subscriptionAPIRoundTripper{queryStatus: 404}
	h := testMonetizationHandler(transport)

	out, err := h.queryUserSubscriptionsBySKU("user-1", "club-individual-monthly")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 {
		t.Fatalf("expected no entitlements for a 404, got %#v", out)
	}
}

// ---------------------------------------------------------------------------
// activeClubStatus routing: lifetime SKUs -> entitlements, monthly -> subscriptions
// ---------------------------------------------------------------------------

type routingRoundTripper struct {
	entitlementCalls  int
	subscriptionCalls int
}

func (f *routingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Path == "/iam/v3/oauth/token" {
		return jsonResponse(200, `{"access_token":"server-token"}`), nil
	}
	switch {
	case strings.Contains(req.URL.Path, "/items/byCriteria"):
		return jsonResponse(200, `{"data":[
			{"id":"item-individual-monthly","sku":"club-individual-monthly"},
			{"id":"item-individual-lifetime","sku":"club-individual-lifetime"},
			{"id":"item-family-monthly","sku":"club-family-monthly"},
			{"id":"item-family-lifetime","sku":"club-family-lifetime"}
		]}`), nil
	case strings.Contains(req.URL.Path, "/entitlements"):
		f.entitlementCalls++
		return jsonResponse(200, `{"data":[]}`), nil
	case strings.HasSuffix(req.URL.Path, "/subscriptions"):
		f.subscriptionCalls++
		return jsonResponse(200, `{"data":[]}`), nil
	}
	return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
}

func TestActiveClubStatusRoutesLifetimeAndMonthlySeparately(t *testing.T) {
	transport := &routingRoundTripper{}
	h := testMonetizationHandler(transport)

	all := []string{"club-individual-monthly", "club-individual-lifetime", "club-family-monthly", "club-family-lifetime"}
	if _, err := h.activeClubStatus("user-1", all); err != nil {
		t.Fatal(err)
	}
	if transport.entitlementCalls != 2 {
		t.Fatalf("expected 2 entitlement queries (the 2 lifetime SKUs), got %d", transport.entitlementCalls)
	}
	if transport.subscriptionCalls != 2 {
		t.Fatalf("expected 2 subscription queries (the 2 monthly SKUs), got %d", transport.subscriptionCalls)
	}
}

func TestActiveClubStatusFamilyOnlyRoutesBothFamilySKUs(t *testing.T) {
	transport := &routingRoundTripper{}
	h := testMonetizationHandler(transport)

	if _, err := h.activeClubStatus("user-1", clubSKUsForFamily()); err != nil {
		t.Fatal(err)
	}
	if transport.entitlementCalls != 1 {
		t.Fatalf("expected 1 entitlement query (club-family-lifetime), got %d", transport.entitlementCalls)
	}
	if transport.subscriptionCalls != 1 {
		t.Fatalf("expected 1 subscription query (club-family-monthly), got %d", transport.subscriptionCalls)
	}
}

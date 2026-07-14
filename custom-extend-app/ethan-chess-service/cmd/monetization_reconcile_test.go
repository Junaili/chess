package main

import (
	"testing"
	"time"
)

func TestReconcileDecisionsLifetimeNotYetCredited(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{{SKU: "club-individual-lifetime", Status: "ACTIVE"}}
	ledger := newLedger()

	decisions := reconcileDecisions(entitlements, ledger, now)
	if len(decisions) != 1 {
		t.Fatalf("expected 1 decision, got %d", len(decisions))
	}
	if decisions[0].TxKey != "life:club-individual-lifetime" || decisions[0].Coins != 2999 {
		t.Fatalf("unexpected decision: %#v", decisions[0])
	}
}

func TestReconcileDecisionsLifetimeAlreadyCreditedIsNoOp(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{{SKU: "club-individual-lifetime", Status: "ACTIVE"}}
	ledger := newLedger()
	ledger.Credits["life:club-individual-lifetime"] = ledgerEntry{Amount: 2999}

	decisions := reconcileDecisions(entitlements, ledger, now)
	if len(decisions) != 0 {
		t.Fatalf("expected 0 decisions (already credited), got %d: %#v", len(decisions), decisions)
	}
}

func TestReconcileDecisionsMonthlyPeriodKeyedByEndDate(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{{SKU: "club-family-monthly", Status: "ACTIVE", EndDate: "2026-08-11T00:00:00Z"}}
	ledger := newLedger()

	decisions := reconcileDecisions(entitlements, ledger, now)
	if len(decisions) != 1 {
		t.Fatalf("expected 1 decision, got %d", len(decisions))
	}
	want := "period:club-family-monthly:2026-08-11T00:00:00Z"
	if decisions[0].TxKey != want {
		t.Fatalf("txKey = %q, want %q", decisions[0].TxKey, want)
	}
	if decisions[0].Coins != 399 {
		t.Fatalf("coins = %d, want 399", decisions[0].Coins)
	}
}

// This is the exact scenario the plan's §6.5 "double-credit trap" warns
// about: a Stripe subscriber whose webhook already credited the period must
// NOT be credited again by reconciliation, because both paths write the same
// platform-neutral txKey.
func TestReconcileDecisionsSkipsPeriodAlreadyCreditedByStripeWebhook(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{{SKU: "club-individual-monthly", Status: "ACTIVE", EndDate: "2026-08-11T00:00:00Z", Origin: "stripe"}}
	ledger := newLedger()
	// Simulate the webhook having already written this period's credit.
	ledger.Credits["period:club-individual-monthly:2026-08-11T00:00:00Z"] = ledgerEntry{Amount: 299, Kind: "club-period"}

	decisions := reconcileDecisions(entitlements, ledger, now)
	if len(decisions) != 0 {
		t.Fatalf("expected reconciliation to skip an already-webhook-credited period, got %#v", decisions)
	}
}

func TestReconcileDecisionsNewRenewalPeriodGetsNewTxKey(t *testing.T) {
	now := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{{SKU: "club-individual-monthly", Status: "ACTIVE", EndDate: "2026-09-11T00:00:00Z"}}
	ledger := newLedger()
	// A prior period was already credited — the renewal moved endDate, so a
	// NEW period must be credited, exactly once.
	ledger.Credits["period:club-individual-monthly:2026-08-11T00:00:00Z"] = ledgerEntry{Amount: 299, Kind: "club-period"}

	decisions := reconcileDecisions(entitlements, ledger, now)
	if len(decisions) != 1 {
		t.Fatalf("expected exactly 1 new-period decision, got %d: %#v", len(decisions), decisions)
	}
	if decisions[0].TxKey != "period:club-individual-monthly:2026-09-11T00:00:00Z" {
		t.Fatalf("unexpected txKey: %s", decisions[0].TxKey)
	}
}

func TestReconcileDecisionsIgnoresInactiveEntitlement(t *testing.T) {
	now := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC) // well past endDate + grace
	entitlements := []clubEntitlement{{SKU: "club-individual-monthly", Status: "ACTIVE", EndDate: "2026-08-11T00:00:00Z"}}
	decisions := reconcileDecisions(entitlements, newLedger(), now)
	if len(decisions) != 0 {
		t.Fatalf("expected lapsed entitlement to produce no decisions, got %#v", decisions)
	}
}

func TestReconcileDecisionsIgnoresNonActiveStatus(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{{SKU: "club-individual-lifetime", Status: "REVOKED"}}
	decisions := reconcileDecisions(entitlements, newLedger(), now)
	if len(decisions) != 0 {
		t.Fatalf("expected revoked entitlement to produce no decisions, got %#v", decisions)
	}
}

func TestBestActiveEntitlementPrefersLifetimeOverMonthly(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{
		{SKU: "club-individual-monthly", Status: "ACTIVE", EndDate: "2026-08-11T00:00:00Z"},
		{SKU: "club-individual-lifetime", Status: "ACTIVE"},
	}
	best := bestActiveEntitlement(entitlements, now)
	if best == nil || best.SKU != "club-individual-lifetime" {
		t.Fatalf("expected lifetime to win, got %#v", best)
	}
}

func TestBestActiveEntitlementPrefersFamilyOverIndividual(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{
		{SKU: "club-individual-monthly", Status: "ACTIVE", EndDate: "2026-08-11T00:00:00Z"},
		{SKU: "club-family-monthly", Status: "ACTIVE", EndDate: "2026-08-11T00:00:00Z"},
	}
	best := bestActiveEntitlement(entitlements, now)
	if best == nil || best.SKU != "club-family-monthly" {
		t.Fatalf("expected family to win over individual, got %#v", best)
	}
}

func TestBestActiveEntitlementNilWhenNoneActive(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	entitlements := []clubEntitlement{{SKU: "club-individual-monthly", Status: "ACTIVE", EndDate: "2026-01-01T00:00:00Z"}}
	if best := bestActiveEntitlement(entitlements, now); best != nil {
		t.Fatalf("expected nil, got %#v", best)
	}
}

func TestEntitlementActiveWithinGracePeriod(t *testing.T) {
	e := clubEntitlement{SKU: "club-individual-monthly", Status: "ACTIVE", EndDate: "2026-07-10T00:00:00Z"}
	justAfterEnd := time.Date(2026, 7, 11, 0, 0, 0, 0, time.UTC) // 1 day after endDate, within 3-day grace
	if !e.isActive(justAfterEnd) {
		t.Fatal("expected entitlement to still be active within the grace period")
	}
	wellAfterGrace := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	if e.isActive(wellAfterGrace) {
		t.Fatal("expected entitlement to have lapsed after the grace period")
	}
}

// The webhook keys periods with "…T00:00:00Z" while AGS echoes entitlement
// endDates as "…T00:00:00.000Z" — txKeyPeriod must canonicalize both to ONE
// key or reconciliation double-credits every period (§6.5 trap).
func TestTxKeyPeriodCanonicalizesMillisecondEndDates(t *testing.T) {
	webhook := txKeyPeriod("club-family-monthly", "2026-08-11T00:00:00Z")
	agsEcho := txKeyPeriod("club-family-monthly", "2026-08-11T00:00:00.000Z")
	if webhook != agsEcho {
		t.Fatalf("same period produced two keys: %q vs %q", webhook, agsEcho)
	}
	if webhook != "period:club-family-monthly:2026-08-11T00:00:00Z" {
		t.Fatalf("canonical key = %q", webhook)
	}
}

func TestReconcileDecisionsCanonicalizesAGSEndDateAgainstWebhookKey(t *testing.T) {
	now := time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)
	// Entitlement endDate exactly as AGS echoes it (milliseconds)…
	entitlements := []clubEntitlement{{SKU: "club-family-monthly", Status: "ACTIVE", EndDate: "2026-08-11T00:00:00.000Z"}}
	ledger := newLedger()
	// …but the webhook already credited the period under its own formatting.
	ledger.Credits["period:club-family-monthly:2026-08-11T00:00:00Z"] = ledgerEntry{Amount: 399, Kind: "club-period"}

	decisions := reconcileDecisions(entitlements, ledger, now)
	if len(decisions) != 0 {
		t.Fatalf("expected 0 decisions (period already credited by the webhook), got %d: %#v", len(decisions), decisions)
	}
}

func TestPeriodEndFromTxKey(t *testing.T) {
	end, ok := periodEndFromTxKey("period:club-family-monthly:2026-08-11T00:00:00Z")
	if !ok || !end.Equal(time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("parse failed: ok=%v end=%v", ok, end)
	}
	if _, ok := periodEndFromTxKey("life:club-individual-lifetime"); ok {
		t.Fatal("lifetime key must not parse as a period key")
	}
	if _, ok := periodEndFromTxKey("period:garbage"); ok {
		t.Fatal("malformed period key must not parse")
	}
}

// §6.5 scopes clawback to REVOKED entitlements. A period that ran out
// normally (its end date is in the past, so AGS no longer returns the
// entitlement) is a fully-consumed month — the coins stay.
func TestApplyClawbacksSkipsNaturallyExpiredPeriods(t *testing.T) {
	transport := &stripeWebhookRoundTripper{}
	h := testMonetizationHandler(transport) // now = 2026-07-12T12:00Z

	ledger := newLedger()
	ledger.Credits["period:club-family-monthly:2026-07-01T00:00:00Z"] = ledgerEntry{Amount: 399, Kind: "club-period"}

	if err := h.applyClawbacks("user-1", nil, ledger); err != nil {
		t.Fatal(err)
	}
	if transport.debits != 0 {
		t.Fatalf("a normally-expired period must NOT be clawed back, got %d debits", transport.debits)
	}
}

// An absent entitlement whose period end is still in the FUTURE can only
// mean it was revoked mid-period (Apple refund) — that one IS clawed back.
func TestApplyClawbacksDebitsRevokedMidPeriodCredit(t *testing.T) {
	transport := &stripeWebhookRoundTripper{}
	h := testMonetizationHandler(transport) // now = 2026-07-12T12:00Z

	ledger := newLedger()
	ledger.Credits["period:club-family-monthly:2026-08-11T00:00:00Z"] = ledgerEntry{Amount: 399, Kind: "club-period"}

	if err := h.applyClawbacks("user-1", nil, ledger); err != nil {
		t.Fatal(err)
	}
	if transport.debits != 1 {
		t.Fatalf("a mid-period revocation must be clawed back exactly once, got %d debits", transport.debits)
	}
}

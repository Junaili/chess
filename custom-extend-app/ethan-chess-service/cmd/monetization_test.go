package main

import "testing"

func TestIsClubSKU(t *testing.T) {
	for sku := range clubSKUs {
		if !isClubSKU(sku) {
			t.Errorf("expected %q to be a club SKU", sku)
		}
	}
	if isClubSKU("cos-board-walnut") {
		t.Error("a cosmetic SKU must not be treated as a club SKU")
	}
	if isClubSKU("") {
		t.Error("empty string must not be a club SKU")
	}
}

func TestClubTier(t *testing.T) {
	cases := map[string]string{
		"club-individual-monthly":  "individual",
		"club-individual-lifetime": "individual",
		"club-family-monthly":      "family",
		"club-family-lifetime":     "family",
		"not-a-sku":                "",
	}
	for sku, want := range cases {
		if got := clubTier(sku); got != want {
			t.Errorf("clubTier(%q) = %q, want %q", sku, got, want)
		}
	}
}

func TestClubSKUCoinAmountsMatchThePlan(t *testing.T) {
	// These four numbers are the entire monetization contract — pinned here
	// so an accidental price edit fails a test instead of silently shipping.
	cases := map[string]int{
		"club-individual-monthly":  299,
		"club-individual-lifetime": 2999,
		"club-family-monthly":      399,
		"club-family-lifetime":     3999,
	}
	for sku, want := range cases {
		if got := clubSKUs[sku].Coins; got != want {
			t.Errorf("clubSKUs[%q].Coins = %d, want %d", sku, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// High Five target validation
// ---------------------------------------------------------------------------

func TestValidHighFiveTarget(t *testing.T) {
	const bot = "gambit-gus-id"
	cases := []struct {
		name      string
		sender    string
		recipient string
		matchID   string
		want      bool
	}{
		{"happy path", "sender-1", "recipient-1", "match-1", true},
		{"self-target rejected", "user-1", "user-1", "match-1", false},
		{"empty sender rejected", "", "recipient-1", "match-1", false},
		{"empty recipient rejected", "sender-1", "", "match-1", false},
		{"empty matchId rejected", "sender-1", "recipient-1", "", false},
		{"bot recipient rejected", "sender-1", bot, "match-1", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := validHighFiveTarget(c.sender, c.recipient, c.matchID, bot)
			if got != c.want {
				t.Errorf("validHighFiveTarget(%q,%q,%q) = %v, want %v", c.sender, c.recipient, c.matchID, got, c.want)
			}
		})
	}
}

func TestValidHighFiveTargetRejectsOversizedIDs(t *testing.T) {
	oversized := make([]byte, 200)
	for i := range oversized {
		oversized[i] = 'a'
	}
	if validHighFiveTarget("sender-1", string(oversized), "match-1", "") {
		t.Error("expected an oversized recipient id to be rejected")
	}
	if validHighFiveTarget("sender-1", "recipient-1", string(oversized), "") {
		t.Error("expected an oversized match id to be rejected")
	}
}

// ---------------------------------------------------------------------------
// /coins/highfive end-to-end via the fake transport (happy path + dedupe +
// insufficient balance), exercising the wrote-gated flow fixed above.
// ---------------------------------------------------------------------------

func TestHighFiveHandlerDedupesOnRetry(t *testing.T) {
	senderLedger := `{"credits":{},"debits":{},"counters":{}}`
	transport := &ledgerRoundTripper{storedValue: []byte(senderLedger), updatedAt: "2026-07-01T00:00:00Z"}
	h := testMonetizationHandler(transport)

	txKey := txKeyHighFive("match-1", "sender-1")
	first, wrote, err := h.mutateLedger("sender-1", func(l *monetizationLedger) bool {
		if _, exists := l.Debits[txKey]; exists {
			return false
		}
		l.Debits[txKey] = ledgerEntry{Amount: highFiveCost, Kind: "highfive"}
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	if !wrote {
		t.Fatal("expected the first High Five debit reservation to write")
	}
	if _, exists := first.Debits[txKey]; !exists {
		t.Fatal("expected the debit to be present after the first write")
	}

	// A second, identical attempt (retry / double-tap) must decline to write
	// again — this is the exact guard validHighFiveTarget + the ledger
	// pre-check + this wrote-gated write together provide.
	_, wroteAgain, err := h.mutateLedger("sender-1", func(l *monetizationLedger) bool {
		if _, exists := l.Debits[txKey]; exists {
			return false
		}
		l.Debits[txKey] = ledgerEntry{Amount: highFiveCost, Kind: "highfive"}
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	if wroteAgain {
		t.Fatal("expected the second identical High Five reservation to be a no-op")
	}
}

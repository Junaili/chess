package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTxKeyFormats(t *testing.T) {
	cases := []struct {
		got  string
		want string
	}{
		{txKeyPeriod("club-individual-monthly", "2026-08-11T00:00:00Z"), "period:club-individual-monthly:2026-08-11T00:00:00Z"},
		{txKeyLifetime("club-family-lifetime"), "life:club-family-lifetime"},
		{txKeyHighFive("match-1", "sender-1"), "hf:match-1:sender-1"},
		{txKeyAllowance("uuid-1"), "alw:uuid-1"},
		{txKeyClawback("life:club-individual-lifetime"), "clawback:life:club-individual-lifetime"},
		{txKeyNarrativeDay("2026-07-12"), "narr:2026-07-12"},
		{txKeyNarrativeWeek("2026-W28"), "narr-week:2026-W28"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("got %q, want %q", c.got, c.want)
		}
	}
}

func TestPruneEntriesKeepsMostRecent(t *testing.T) {
	m := map[string]ledgerEntry{}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 450; i++ {
		at := base.Add(time.Duration(i) * time.Hour).Format(time.RFC3339)
		m[at] = ledgerEntry{Amount: i, At: at}
	}
	pruneEntries(m)
	if len(m) != ledgerPruneKeepEntries {
		t.Fatalf("len = %d, want %d", len(m), ledgerPruneKeepEntries)
	}
	// The most recent 300 (highest i, i.e. i in [150,449]) must survive.
	for i := 150; i < 450; i++ {
		at := base.Add(time.Duration(i) * time.Hour).Format(time.RFC3339)
		if _, ok := m[at]; !ok {
			t.Fatalf("expected entry %d (at=%s) to survive pruning", i, at)
		}
	}
}

func TestPruneEntriesNoOpUnderLimit(t *testing.T) {
	m := map[string]ledgerEntry{"a": {Amount: 1, At: "2026-01-01T00:00:00Z"}}
	pruneEntries(m)
	if len(m) != 1 {
		t.Fatalf("expected no pruning, got len=%d", len(m))
	}
}

// ---------------------------------------------------------------------------
// mutateLedger concurrency: fake transport that simulates a 412 on the first
// write attempt (another writer raced us), then succeeds on retry.
// ---------------------------------------------------------------------------

type ledgerRoundTripper struct {
	mu          sync.Mutex
	getCalls    int
	putCalls    int
	conflictOn  int // fail the Nth PUT (1-indexed) with 412; 0 = never conflict
	storedValue json.RawMessage
	updatedAt   string
}

func (f *ledgerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if req.URL.Path == "/iam/v3/oauth/token" {
		return jsonResponse(200, `{"access_token":"server-token"}`), nil
	}
	switch req.Method {
	case http.MethodGet:
		f.getCalls++
		if f.storedValue == nil {
			return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
		}
		body, _ := json.Marshal(map[string]any{"value": f.storedValue, "updatedAt": f.updatedAt})
		return jsonResponse(200, string(body)), nil
	case http.MethodPut:
		f.putCalls++
		if f.conflictOn > 0 && f.putCalls == f.conflictOn {
			return &http.Response{StatusCode: 412, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
		}
		raw, _ := io.ReadAll(req.Body)
		var body struct {
			Value     json.RawMessage `json:"value"`
			UpdatedAt string          `json:"updatedAt"`
		}
		_ = json.Unmarshal(raw, &body)
		f.storedValue = body.Value
		f.updatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
	}
	return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func testMonetizationHandler(transport http.RoundTripper) *monetizationHandler {
	h := &monetizationHandler{
		agsBaseURL:   "https://ags.test",
		namespace:    "chess",
		clientID:     "server-client",
		clientSecret: "server-secret",
		webBaseURL:   "https://web.test",
		botUserID:    "gambit-gus-id",
		httpClient:   &http.Client{Transport: transport},
		now:          func() time.Time { return time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC) },
	}
	h.items = newItemCatalogCache(h)
	h.roles = newFamilyRolesCache(h)
	h.journal = newOpenJournalConfigCache(h)
	return h
}

func TestMutateLedgerCreatesRecordWhenNoneExists(t *testing.T) {
	transport := &ledgerRoundTripper{}
	h := testMonetizationHandler(transport)

	ledger, wrote, err := h.mutateLedger("user-1", func(l *monetizationLedger) bool {
		l.Credits["life:club-individual-lifetime"] = ledgerEntry{Amount: 2999, At: "2026-07-12T00:00:00Z", Kind: "club-lifetime"}
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	if !wrote {
		t.Fatal("expected a write to occur for a brand new record")
	}
	if ledger.Credits["life:club-individual-lifetime"].Amount != 2999 {
		t.Fatalf("credit not applied: %#v", ledger.Credits)
	}
	if transport.putCalls != 1 {
		t.Fatalf("putCalls = %d, want 1", transport.putCalls)
	}
}

func TestMutateLedgerRetriesOn412(t *testing.T) {
	transport := &ledgerRoundTripper{conflictOn: 1}
	h := testMonetizationHandler(transport)

	_, wrote, err := h.mutateLedger("user-1", func(l *monetizationLedger) bool {
		l.Credits["hf:match-1:sender-1"] = ledgerEntry{Amount: 5, At: "2026-07-12T00:00:00Z", Kind: "highfive-reward"}
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	if !wrote {
		t.Fatal("expected the retried write to eventually succeed")
	}
	if transport.putCalls != 2 {
		t.Fatalf("expected exactly one retry (2 PUTs), got %d", transport.putCalls)
	}
	if transport.getCalls != 2 {
		t.Fatalf("expected a fresh GET before the retry (2 GETs), got %d", transport.getCalls)
	}
}

func TestMutateLedgerNoWriteWhenFnDeclinesChange(t *testing.T) {
	existing, _ := json.Marshal(monetizationLedger{
		Credits: map[string]ledgerEntry{"life:club-individual-lifetime": {Amount: 2999, At: "x", Kind: "club-lifetime"}},
		Debits:  map[string]ledgerEntry{},
	})
	transport := &ledgerRoundTripper{storedValue: existing, updatedAt: "2026-07-01T00:00:00Z"}
	h := testMonetizationHandler(transport)

	_, wrote, err := h.mutateLedger("user-1", func(l *monetizationLedger) bool {
		if _, exists := l.Credits["life:club-individual-lifetime"]; exists {
			return false // already credited — the exact idempotency check every credit path uses
		}
		l.Credits["life:club-individual-lifetime"] = ledgerEntry{Amount: 2999}
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	if wrote {
		t.Fatal("expected wrote=false when fn declines to change anything")
	}
	if transport.putCalls != 0 {
		t.Fatalf("expected no write when the txKey already exists, got %d PUTs", transport.putCalls)
	}
}

func TestMutateLedgerGivesUpAfterMaxRetries(t *testing.T) {
	h := testMonetizationHandler(&alwaysConflictTransport{})
	_, _, err := h.mutateLedger("user-1", func(l *monetizationLedger) bool {
		l.Credits["x"] = ledgerEntry{Amount: 1}
		return true
	})
	if err == nil {
		t.Fatal("expected an error after exceeding max retries")
	}
}

type alwaysConflictTransport struct{}

func (alwaysConflictTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Path == "/iam/v3/oauth/token" {
		return jsonResponse(200, `{"access_token":"server-token"}`), nil
	}
	if req.Method == http.MethodGet {
		return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
	}
	return &http.Response{StatusCode: 412, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
}

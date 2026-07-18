package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestJournalOpenNowWeeklyDayActive(t *testing.T) {
	sunday := 0
	cfg := openJournalConfig{WeeklyDay: &sunday, NarrativeDailyCap: 3}
	// 2026-07-12 is a Sunday.
	now := time.Date(2026, 7, 12, 15, 0, 0, 0, time.UTC)
	info := journalOpenNow(cfg, now)
	if !info.Active {
		t.Fatal("expected Sunday to be an active Open Journal Day")
	}
}

func TestJournalOpenNowWeeklyDayInactiveOtherDays(t *testing.T) {
	sunday := 0
	cfg := openJournalConfig{WeeklyDay: &sunday, NarrativeDailyCap: 3}
	monday := time.Date(2026, 7, 13, 15, 0, 0, 0, time.UTC)
	info := journalOpenNow(cfg, monday)
	if info.Active {
		t.Fatal("expected Monday to be inactive")
	}
}

func TestJournalOpenNowWeeklyDayDisabledWhenNil(t *testing.T) {
	cfg := openJournalConfig{WeeklyDay: nil, NarrativeDailyCap: 3}
	sunday := time.Date(2026, 7, 12, 15, 0, 0, 0, time.UTC)
	info := journalOpenNow(cfg, sunday)
	if info.Active {
		t.Fatal("expected a nil WeeklyDay to disable the weekly occasion entirely")
	}
}

func TestJournalOpenNowOneOffDateRangeInclusiveBoundaries(t *testing.T) {
	cfg := openJournalConfig{
		Dates: []openJournalDateRange{{Start: "2026-12-24", End: "2026-12-26", Label: "Holiday Journal Days"}},
	}
	cases := []struct {
		name string
		now  time.Time
		want bool
	}{
		{"day before start", time.Date(2026, 12, 23, 23, 59, 0, 0, time.UTC), false},
		{"start date, early", time.Date(2026, 12, 24, 0, 0, 1, 0, time.UTC), true},
		{"middle date", time.Date(2026, 12, 25, 12, 0, 0, 0, time.UTC), true},
		{"end date, late", time.Date(2026, 12, 26, 23, 59, 59, 0, time.UTC), true},
		{"day after end", time.Date(2026, 12, 27, 0, 0, 1, 0, time.UTC), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			info := journalOpenNow(cfg, c.now)
			if info.Active != c.want {
				t.Fatalf("active = %v, want %v", info.Active, c.want)
			}
		})
	}
}

func TestJournalOpenNowOneOffDateTakesLabel(t *testing.T) {
	cfg := openJournalConfig{
		Dates: []openJournalDateRange{{Start: "2026-12-24", End: "2026-12-26", Label: "Holiday Journal Days"}},
	}
	info := journalOpenNow(cfg, time.Date(2026, 12, 25, 0, 0, 0, 0, time.UTC))
	if info.Label != "Holiday Journal Days" {
		t.Fatalf("label = %q", info.Label)
	}
}

func TestJournalOpenNowMalformedRecordFailsClosed(t *testing.T) {
	// A cache with a zero-value config (what get() falls back to on a decode
	// failure) must never report active — §8.5's explicit acceptance
	// criterion: "malformed record (fail closed = not active)".
	cfg := openJournalConfig{}
	info := journalOpenNow(cfg, time.Now())
	if info.Active {
		t.Fatal("expected zero-value config to be inactive")
	}
}

func TestOpenJournalConfigCacheDecodeFailureFailsClosed(t *testing.T) {
	transport := &gateRoundTripper{configValue: json.RawMessage(`not valid json`)}
	h := testMonetizationHandler(transport)
	cfg := h.journal.get()
	if journalOpenNow(cfg, time.Now()).Active {
		t.Fatal("expected malformed config record to fail closed (not active)")
	}
}

// ---------------------------------------------------------------------------
// coachReportGate decision matrix
// ---------------------------------------------------------------------------

func TestCoachReportGateExhaustedAtExactCapBoundary(t *testing.T) {
	// This is the exact scenario the wrote-vs-comparison bug (fixed during
	// implementation, see the comment in coachReportGate) would get wrong:
	// counter already sitting exactly at the cap.
	existingLedger, _ := json.Marshal(monetizationLedger{
		Credits:  map[string]ledgerEntry{},
		Debits:   map[string]ledgerEntry{},
		Counters: map[string]int{"narr:2026-07-12": 3},
	})
	sunday := 0
	cfgRaw, _ := json.Marshal(openJournalConfig{WeeklyDay: &sunday, NarrativeDailyCap: 3})
	transport := &gateRoundTripper{ledgerValue: existingLedger, configValue: cfgRaw}
	h := testMonetizationHandler(transport)
	h.now = func() time.Time { return time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC) } // a Sunday

	decision, err := h.coachReportGate("user-1", "fake-user-token")
	if err != nil {
		t.Fatal(err)
	}
	if decision.Allowed {
		t.Fatal("expected the gate to refuse once the daily cap is already reached")
	}
	if decision.Reason != "exhausted" {
		t.Fatalf("reason = %q, want exhausted", decision.Reason)
	}
}

func TestCoachReportGateAllowsUnderCap(t *testing.T) {
	existingLedger, _ := json.Marshal(monetizationLedger{
		Credits:  map[string]ledgerEntry{},
		Debits:   map[string]ledgerEntry{},
		Counters: map[string]int{"narr:2026-07-12": 2},
	})
	sunday := 0
	cfgRaw, _ := json.Marshal(openJournalConfig{WeeklyDay: &sunday, NarrativeDailyCap: 3})
	transport := &gateRoundTripper{ledgerValue: existingLedger, configValue: cfgRaw}
	h := testMonetizationHandler(transport)
	h.now = func() time.Time { return time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC) }

	decision, err := h.coachReportGate("user-1", "fake-user-token")
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Allowed || decision.Reason != "open-day" {
		t.Fatalf("decision = %#v, want allowed/open-day", decision)
	}
}

func TestCoachReportGateWeeklyFreeWhenNoOpenDay(t *testing.T) {
	// A Monday, no weekly occasion configured, no prior narrative used this
	// ISO week.
	transport := &gateRoundTripper{configValue: json.RawMessage(`{}`)}
	h := testMonetizationHandler(transport)
	h.now = func() time.Time { return time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC) }

	decision, err := h.coachReportGate("user-1", "fake-user-token")
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Allowed || decision.Reason != "weekly-free" {
		t.Fatalf("decision = %#v, want allowed/weekly-free", decision)
	}
}

func TestCoachReportGateWeeklyFreeExhaustedSecondCallSameWeek(t *testing.T) {
	existingLedger, _ := json.Marshal(monetizationLedger{
		Credits:  map[string]ledgerEntry{},
		Debits:   map[string]ledgerEntry{},
		Counters: map[string]int{"narr-week:2026-W29": 1},
	})
	transport := &gateRoundTripper{ledgerValue: existingLedger, configValue: json.RawMessage(`{}`)}
	h := testMonetizationHandler(transport)
	h.now = func() time.Time { return time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC) } // ISO week 29

	decision, err := h.coachReportGate("user-1", "fake-user-token")
	if err != nil {
		t.Fatal(err)
	}
	if decision.Allowed {
		t.Fatal("expected the second same-week narrative to be refused")
	}
}

func TestCoachReportGateClubMemberUnlimited(t *testing.T) {
	transport := &gateRoundTripper{
		configValue:  json.RawMessage(`{}`),
		entitlements: `{"data":[{"itemId":"item-individual-lifetime","sku":"club-individual-lifetime","status":"ACTIVE"}]}`,
	}
	h := testMonetizationHandler(transport)
	h.now = func() time.Time { return time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC) }

	decision, err := h.coachReportGate("user-1", "fake-user-token")
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Allowed || decision.Reason != "club" {
		t.Fatalf("decision = %#v, want allowed/club", decision)
	}
}

// ---------------------------------------------------------------------------
// gateRoundTripper: fake transport serving the token, CloudSave ledger
// (concurrent player record), CloudSave namespace config (game record),
// item catalog, entitlement, and group-membership endpoints that
// coachReportGate's call graph touches.
// ---------------------------------------------------------------------------

type gateRoundTripper struct {
	ledgerValue  json.RawMessage
	ledgerAt     string
	configValue  json.RawMessage
	entitlements string // canned response body for the entitlements query; "" = no active entitlement
}

func (f *gateRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	switch {
	case req.URL.Path == "/iam/v3/oauth/token":
		return jsonResponse(200, `{"access_token":"server-token"}`), nil

	case strings.Contains(req.URL.Path, "/adminrecords/club-open-journal-config"):
		if f.configValue == nil {
			return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
		}
		body, _ := json.Marshal(map[string]any{"value": f.configValue})
		return jsonResponse(200, string(body)), nil

	case strings.Contains(req.URL.Path, "adminrecords/monetization-ledger"):
		// Matches BOTH the plain GET path (getAdminPlayerRecord reads
		// .../adminrecords/{key}) and the concurrent PUT path
		// (putAdminPlayerRecordConcurrent writes .../concurrent/adminrecords/{key}) —
		// this is the real, intentional AGS CloudSave asymmetry, not a bug.
		if req.Method == http.MethodGet {
			if f.ledgerValue == nil {
				return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
			}
			body, _ := json.Marshal(map[string]any{"value": f.ledgerValue, "updated_at": f.ledgerAt})
			return jsonResponse(200, string(body)), nil
		}
		// PUT: accept unconditionally and remember the new value so a
		// second GET in the same test sees the write (only one test here
		// issues two gate calls in sequence, but this keeps behavior sane).
		raw, _ := io.ReadAll(req.Body)
		var body struct {
			Value json.RawMessage `json:"value"`
		}
		_ = json.Unmarshal(raw, &body)
		f.ledgerValue = body.Value
		f.ledgerAt = time.Now().UTC().Format(time.RFC3339Nano)
		return jsonResponse(200, `{}`), nil

	case strings.Contains(req.URL.Path, "/entitlements"):
		if f.entitlements == "" {
			return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
		}
		return jsonResponse(200, f.entitlements), nil

	case strings.Contains(req.URL.Path, "/group/v2/admin/") && strings.HasSuffix(req.URL.Path, "/groups"):
		// No family group for this user — computeClubActiveOnly's guardian
		// lookup short-circuits to "not a child, no guardian".
		return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
	}
	return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: req}, nil
}

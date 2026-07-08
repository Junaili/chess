package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// stubAMS serves the oauth token endpoint plus whatever AMS routes the test
// registers, and points both AB_BASE_URL (used for the token call) and the
// watcher's amsBase at the same stub server.
func stubAMS(t *testing.T, routes map[string]func(w http.ResponseWriter, r *http.Request)) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/iam/v3/oauth/token" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"access_token":"stub-token","expires_in":3600}`)
			return
		}
		mu.Lock()
		handler, ok := routes[r.Method+" "+r.URL.Path]
		mu.Unlock()
		if !ok {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AB_BASE_URL", srv.URL)
	t.Setenv("AB_CLIENT_ID", "test-client")
	t.Setenv("AB_CLIENT_SECRET", "test-secret")
	t.Setenv("AB_NAMESPACE", "test-ns")
	return srv
}

func TestClaimOnce_ClaimByKeys_SendsRegionsArray(t *testing.T) {
	var capturedBody map[string]any
	srv := stubAMS(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"PUT /ams/v1/namespaces/test-ns/servers/claim": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&capturedBody)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ip":"1.2.3.4","ports":{"trigger":9000}}`)
		},
	})

	w := &MatchWatcher{
		amsBase:      srv.URL,
		amsClaimKeys: []string{"ethan-chess-bot"},
		amsRegion:    "us-east-2",
		amsPortName:  "trigger",
	}
	addr, notReady, err := w.claimOnce(srv.URL, "test-ns", "stub-token", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if notReady {
		t.Fatalf("expected a ready claim, got notReady=true")
	}
	if addr != "1.2.3.4:9000" {
		t.Fatalf("addr = %q, want 1.2.3.4:9000", addr)
	}

	if _, hasRegion := capturedBody["region"]; hasRegion {
		t.Errorf("request body has singular %q key — API requires the plural array form", "region")
	}
	regions, ok := capturedBody["regions"].([]any)
	if !ok {
		t.Fatalf("request body missing \"regions\" array, got: %+v", capturedBody)
	}
	if len(regions) != 1 || regions[0] != "us-east-2" {
		t.Errorf("regions = %v, want [\"us-east-2\"]", regions)
	}
}

func TestClaimServer_UsesClaimByKeys_WhenClaimKeysConfigured(t *testing.T) {
	var hitClaimByKeys, hitClaimByFleetID, hitFleetListing bool
	srv := stubAMS(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"PUT /ams/v1/namespaces/test-ns/servers/claim": func(w http.ResponseWriter, r *http.Request) {
			hitClaimByKeys = true
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ip":"1.2.3.4","ports":{"trigger":9000}}`)
		},
		"GET /ams/v1/admin/namespaces/test-ns/fleets": func(w http.ResponseWriter, r *http.Request) {
			hitFleetListing = true
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"fleets":[{"id":"flt-1","name":"ethan-chess-bot-live"}]}`)
		},
		// A hit here means the resolve-and-claim-by-ID path ran — the bug
		// this test guards against. It should never be reached.
		"PUT /ams/v1/namespaces/test-ns/fleets/flt-1/claim": func(w http.ResponseWriter, r *http.Request) {
			hitClaimByFleetID = true
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ip":"9.9.9.9","ports":{"trigger":1}}`)
		},
	})

	w := &MatchWatcher{
		amsBase:        srv.URL,
		amsClaimKeys:   []string{"ethan-chess-bot"},
		amsRegion:      "us-east-2",
		amsPortName:    "trigger",
		amsClaimRetryS: 5,
	}
	addr, err := w.claimServer()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if addr != "1.2.3.4:9000" {
		t.Fatalf("addr = %q, want 1.2.3.4:9000", addr)
	}
	if !hitClaimByKeys {
		t.Errorf("expected claim-by-keys (PUT /servers/claim) to be called")
	}
	if hitFleetListing {
		t.Errorf("fleet listing was called — claimServer should skip fleet-ID resolution entirely when AMS_CLAIM_KEYS is set")
	}
	if hitClaimByFleetID {
		t.Errorf("claim-by-fleet-ID was called — this is the path that can never trigger an on-demand launch")
	}
}

func TestClaimServer_FallsBackToFleetID_WhenNoClaimKeysConfigured(t *testing.T) {
	var claimedFleetID string
	srv := stubAMS(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"PUT /ams/v1/namespaces/test-ns/fleets/flt-fixed/claim": func(w http.ResponseWriter, r *http.Request) {
			claimedFleetID = "flt-fixed"
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ip":"5.6.7.8","ports":{"trigger":9001}}`)
		},
	})

	// Legacy fixed-fleet-ID mode: no claim keys configured at all.
	w := &MatchWatcher{
		amsBase:        srv.URL,
		amsFleetID:     "flt-fixed",
		amsRegion:      "us-east-2",
		amsPortName:    "trigger",
		amsClaimRetryS: 5,
	}
	addr, err := w.claimServer()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if addr != "5.6.7.8:9001" {
		t.Fatalf("addr = %q, want 5.6.7.8:9001", addr)
	}
	if claimedFleetID != "flt-fixed" {
		t.Errorf("expected the legacy fixed-fleet-ID path to still claim by fleet ID")
	}
}

func TestClaimOnce_ClaimByKeys_OmitsRegionsWhenRegionEmpty(t *testing.T) {
	var capturedBody map[string]any
	srv := stubAMS(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"PUT /ams/v1/namespaces/test-ns/servers/claim": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&capturedBody)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ip":"1.2.3.4","ports":{"trigger":9000}}`)
		},
	})

	w := &MatchWatcher{
		amsBase:      srv.URL,
		amsClaimKeys: []string{"ethan-chess-bot"},
		amsPortName:  "trigger",
	}
	if _, _, err := w.claimOnce(srv.URL, "test-ns", "stub-token", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := capturedBody["regions"]; ok {
		t.Errorf("regions should be omitted entirely when amsRegion is empty, got: %+v", capturedBody)
	}
}

func TestClaimOnce_NotFoundIsRetryable(t *testing.T) {
	srv := stubAMS(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"PUT /ams/v1/namespaces/test-ns/servers/claim": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		},
	})
	w := &MatchWatcher{amsClaimKeys: []string{"ethan-chess-bot"}, amsRegion: "us-east-2", amsPortName: "trigger"}
	addr, notReady, err := w.claimOnce(srv.URL, "test-ns", "stub-token", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !notReady || addr != "" {
		t.Fatalf("notReady=%v addr=%q, want notReady=true addr=\"\"", notReady, addr)
	}
}

// sanity check: the region string doesn't leak stray whitespace/formatting
// issues into the JSON encoding.
func TestClaimOnce_ClaimByKeys_RequestBodyShape(t *testing.T) {
	var raw string
	srv := stubAMS(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"PUT /ams/v1/namespaces/test-ns/servers/claim": func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			raw = string(body)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ip":"1.2.3.4","ports":{"trigger":9000}}`)
		},
	})
	w := &MatchWatcher{amsClaimKeys: []string{"k1", "k2"}, amsRegion: "us-east-2", amsPortName: "trigger"}
	if _, _, err := w.claimOnce(srv.URL, "test-ns", "stub-token", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(raw, `"regions":["us-east-2"]`) {
		t.Errorf("expected literal \"regions\":[\"us-east-2\"] in the request body, got: %s", raw)
	}
}

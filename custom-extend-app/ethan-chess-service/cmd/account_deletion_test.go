package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type deletionRoundTripper struct {
	mu           sync.Mutex
	calls        []string
	revokeStatus int
	appleLinked  bool
}

func (f *deletionRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	f.calls = append(f.calls, req.URL.Host+req.URL.Path)
	f.mu.Unlock()

	status := http.StatusOK
	body := `{}`
	switch {
	case req.URL.Host == "ags.test" && req.URL.Path == "/iam/v3/oauth/token":
		body = `{"access_token":"server-token"}`
	case req.URL.Host == "ags.test" && strings.HasSuffix(req.URL.Path, "/platforms/distinct"):
		if f.appleLinked {
			body = `{"platforms":[{"platformName":"apple","status":"LINKED","linkedAt":"2026-07-02T00:00:00Z","platformGroup":"apple"}]}`
		} else {
			body = `{"platforms":[]}`
		}
	case req.URL.Host == "apple.test" && req.URL.Path == "/auth/token":
		body = `{"refresh_token":"apple-refresh"}`
	case req.URL.Host == "apple.test" && req.URL.Path == "/auth/revoke":
		status = f.revokeStatus
		if status == 0 {
			status = http.StatusOK
		}
	case req.URL.Host == "ags.test" && strings.Contains(req.URL.Path, "/gdpr/admin/"):
		status = http.StatusNoContent
	default:
		status = http.StatusNotFound
	}
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}, nil
}

func testApplePrivateKey(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	return base64.StdEncoding.EncodeToString(pemBytes)
}

func testDeletionHandler(t *testing.T, transport *deletionRoundTripper) *accountDeletionHandler {
	t.Helper()
	return &accountDeletionHandler{
		agsBaseURL:      "https://ags.test",
		namespace:       "chess",
		clientID:        "server-client",
		clientSecret:    "server-secret",
		appleBaseURL:    "https://apple.test",
		appleTeamID:     "TEAM123",
		appleKeyID:      "KEY123",
		appleClientID:   "io.example.chess",
		applePrivateKey: testApplePrivateKey(t),
		httpClient:      &http.Client{Transport: transport},
		now:             func() time.Time { return time.Unix(1_750_000_000, 0) },
	}
}

func authenticatedDeletionRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	return req.WithContext(context.WithValue(req.Context(), subCtxKey, "player-123"))
}

func TestDeletionRequirementsDetectsAppleLink(t *testing.T) {
	transport := &deletionRoundTripper{appleLinked: true}
	handler := testDeletionHandler(t, transport)
	recorder := httptest.NewRecorder()

	handler.requirements(recorder, authenticatedDeletionRequest(http.MethodGet, "/account/deletion-requirements", ""))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["appleReauthorizationRequired"] != true {
		t.Fatalf("expected Apple reauthorization, payload = %#v", payload)
	}
}

func TestDeletionStopsBeforeGDPRWhenAppleRevocationFails(t *testing.T) {
	transport := &deletionRoundTripper{
		appleLinked:  true,
		revokeStatus: http.StatusBadRequest,
	}
	handler := testDeletionHandler(t, transport)
	recorder := httptest.NewRecorder()

	handler.deleteAccount(recorder, authenticatedDeletionRequest(
		http.MethodPost,
		"/account/deletion",
		`{"confirmation":"DELETE","appleAuthorizationCode":"one-time-code"}`,
	))

	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	for _, call := range transport.calls {
		if strings.Contains(call, "/gdpr/admin/") {
			t.Fatalf("GDPR deletion must not run after Apple revocation failure: %v", transport.calls)
		}
	}
}

func TestDeletionRevokesAppleBeforeSubmittingGDPR(t *testing.T) {
	transport := &deletionRoundTripper{appleLinked: true}
	handler := testDeletionHandler(t, transport)
	recorder := httptest.NewRecorder()

	handler.deleteAccount(recorder, authenticatedDeletionRequest(
		http.MethodPost,
		"/account/deletion",
		`{"confirmation":"DELETE","appleAuthorizationCode":"one-time-code"}`,
	))

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	revokeIndex, gdprIndex := -1, -1
	for index, call := range transport.calls {
		if strings.Contains(call, "apple.test/auth/revoke") {
			revokeIndex = index
		}
		if strings.Contains(call, "/gdpr/admin/") {
			gdprIndex = index
		}
	}
	if revokeIndex < 0 || gdprIndex < 0 || revokeIndex >= gdprIndex {
		t.Fatalf("expected Apple revoke before GDPR deletion, calls = %v", transport.calls)
	}
}

func TestDeletionUsesAdminGDPRForGameUser(t *testing.T) {
	transport := &deletionRoundTripper{}
	handler := testDeletionHandler(t, transport)
	recorder := httptest.NewRecorder()

	handler.deleteAccount(recorder, authenticatedDeletionRequest(
		http.MethodPost,
		"/account/deletion",
		`{"confirmation":"DELETE"}`,
	))

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	for _, call := range transport.calls {
		if strings.Contains(call, "/gdpr/admin/namespaces/chess/users/player-123/deletions") {
			return
		}
	}
	t.Fatalf("expected admin GDPR deletion request, calls = %v", transport.calls)
}

func TestAppleClientSecretUsesES256Shape(t *testing.T) {
	handler := testDeletionHandler(t, &deletionRoundTripper{})
	secret, err := handler.appleClientSecret()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(secret, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT has %d segments", len(parts))
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	if len(signature) != 64 {
		t.Fatalf("ES256 signature length = %d", len(signature))
	}
}

// ── Pending-deletion status + cancel ─────────────────────────────────────────

// statusRoundTripper serves the GDPR status/cancel routes and records what was
// called with which credentials.
type statusRoundTripper struct {
	statusCode   int
	statusBody   string
	cancelStatus int

	gotStatusPath string
	gotCancelPath string
	gotAuth       string
	gotMethods    []string
}

func (f *statusRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	f.gotMethods = append(f.gotMethods, req.Method)
	f.gotAuth = req.Header.Get("Authorization")
	status, body := http.StatusOK, `{}`
	switch {
	case strings.HasSuffix(req.URL.Path, "/deletions/status"):
		f.gotStatusPath = req.URL.Path
		status, body = f.statusCode, f.statusBody
	case strings.HasSuffix(req.URL.Path, "/deletions") && req.Method == http.MethodDelete:
		f.gotCancelPath = req.URL.Path
		status = f.cancelStatus
	}
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
	}, nil
}

func deletionStatusRequest(method string) *http.Request {
	req := httptest.NewRequest(method, "/account/deletion", nil)
	ctx := context.WithValue(req.Context(), subCtxKey, "player-123")
	ctx = context.WithValue(ctx, accessTokenCtxKey, "player-token")
	return req.WithContext(ctx)
}

func statusHandler(rt *statusRoundTripper) *accountDeletionHandler {
	return &accountDeletionHandler{
		agsBaseURL: "https://ags.test",
		namespace:  "chess",
		httpClient: &http.Client{Transport: rt},
		now:        func() time.Time { return time.Unix(1_750_000_000, 0) },
	}
}

func TestDeletionStatusReportsScheduledDeletion(t *testing.T) {
	rt := &statusRoundTripper{
		statusCode: http.StatusOK,
		// AGS really does use PascalCase on this payload.
		statusBody: `{"UserID":"pub-1","Status":"Pending","DeletionStatus":true,"ExecutionDate":"2026-09-02T00:00:00Z"}`,
	}
	rec := httptest.NewRecorder()
	statusHandler(rt).handle(rec, deletionStatusRequest(http.MethodGet))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["pending"] != true {
		t.Errorf("pending = %v, want true", out["pending"])
	}
	if out["executionDate"] != "2026-09-02T00:00:00Z" {
		t.Errorf("executionDate = %v", out["executionDate"])
	}
	// A player's own token, never the service's admin credentials: this must
	// never be able to read another player's deletion.
	if rt.gotAuth != "Bearer player-token" {
		t.Errorf("auth = %q, want the caller's own token", rt.gotAuth)
	}
	if !strings.Contains(rt.gotStatusPath, "/chess/users/player-123/deletions/status") {
		t.Errorf("status path = %q", rt.gotStatusPath)
	}
}

// AGS returns the zero time when no date is recorded; it must not surface as a
// real execution date.
func TestDeletionStatusDropsZeroExecutionDate(t *testing.T) {
	rt := &statusRoundTripper{
		statusCode: http.StatusOK,
		statusBody: `{"Status":"","DeletionStatus":false,"ExecutionDate":"0001-01-01T00:00:00Z"}`,
	}
	rec := httptest.NewRecorder()
	statusHandler(rt).handle(rec, deletionStatusRequest(http.MethodGet))

	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["pending"] != false {
		t.Errorf("pending = %v, want false", out["pending"])
	}
	if _, present := out["executionDate"]; present {
		t.Errorf("zero execution date must not be reported: %v", out)
	}
}

// No deletion on file is a normal state, not an error — otherwise every profile
// open would surface a failure.
func TestDeletionStatusTreatsNotFoundAsNotPending(t *testing.T) {
	rt := &statusRoundTripper{statusCode: http.StatusNotFound, statusBody: `{}`}
	rec := httptest.NewRecorder()
	statusHandler(rt).handle(rec, deletionStatusRequest(http.MethodGet))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["pending"] != false {
		t.Errorf("pending = %v, want false", out["pending"])
	}
}

func TestDeletionCancelUsesPlayerTokenAndDelete(t *testing.T) {
	rt := &statusRoundTripper{cancelStatus: http.StatusOK}
	rec := httptest.NewRecorder()
	statusHandler(rt).handle(rec, deletionStatusRequest(http.MethodDelete))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rt.gotCancelPath == "" {
		t.Fatal("cancel endpoint was never called")
	}
	if strings.HasSuffix(rt.gotCancelPath, "/status") {
		t.Errorf("cancel hit the status route: %q", rt.gotCancelPath)
	}
	if rt.gotAuth != "Bearer player-token" {
		t.Errorf("auth = %q, want the caller's own token", rt.gotAuth)
	}
}

// Nothing to cancel means the player already has what they want.
func TestDeletionCancelTreatsNotFoundAsSuccess(t *testing.T) {
	rt := &statusRoundTripper{cancelStatus: http.StatusNotFound}
	rec := httptest.NewRecorder()
	statusHandler(rt).handle(rec, deletionStatusRequest(http.MethodDelete))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

// An unauthenticated caller must never reach AGS.
func TestDeletionStatusRequiresAPlayerToken(t *testing.T) {
	rt := &statusRoundTripper{statusCode: http.StatusOK, statusBody: `{}`}
	req := httptest.NewRequest(http.MethodGet, "/account/deletion", nil)
	req = req.WithContext(context.WithValue(req.Context(), subCtxKey, "player-123")) // no token
	rec := httptest.NewRecorder()
	statusHandler(rt).handle(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(rt.gotMethods) != 0 {
		t.Errorf("unauthenticated request reached AGS: %v", rt.gotMethods)
	}
}

// Submitting or cancelling a deletion invalidates the player's tokens, so the
// next status call can return 401. Surfacing that as a vague outage would tell
// a player to "try again" when what they need is to sign in again.
func TestDeletionStatusPassesThroughUpstreamAuthFailure(t *testing.T) {
	for _, upstream := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		rt := &statusRoundTripper{statusCode: upstream, statusBody: `{"errorCode":20001}`}
		rec := httptest.NewRecorder()
		statusHandler(rt).handle(rec, deletionStatusRequest(http.MethodGet))

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("upstream %d produced %d, want 401", upstream, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "Sign in again") {
			t.Errorf("upstream %d body = %s", upstream, rec.Body.String())
		}
	}
}

// Sign in with Apple accounts cannot be deleted without all four Apple
// settings. A partial config is the dangerous case: web players keep working
// while every iOS player is silently blocked, which is how this reached
// production unnoticed.
func TestMissingAppleConfigNamesEveryGap(t *testing.T) {
	full := &accountDeletionHandler{
		appleTeamID: "TEAM", appleKeyID: "KEY", appleClientID: "io.example.chess",
		applePrivateKey: "cGVt",
	}
	if got := full.missingAppleConfig(); len(got) != 0 {
		t.Errorf("fully configured handler reported gaps: %v", got)
	}
	if !full.appleConfigured() {
		t.Error("fully configured handler reported not configured")
	}

	none := &accountDeletionHandler{}
	if got := none.missingAppleConfig(); len(got) != 4 {
		t.Errorf("empty config reported %v, want all four named", got)
	}

	for _, tc := range []struct {
		name    string
		mutate  func(*accountDeletionHandler)
		wantGap string
	}{
		{"team id", func(h *accountDeletionHandler) { h.appleTeamID = "" }, "APPLE_TEAM_ID"},
		{"key id", func(h *accountDeletionHandler) { h.appleKeyID = "" }, "APPLE_KEY_ID"},
		{"client id", func(h *accountDeletionHandler) { h.appleClientID = "" }, "APPLE_CLIENT_ID"},
		{"private key", func(h *accountDeletionHandler) { h.applePrivateKey = "" }, "APPLE_PRIVATE_KEY_B64"},
		// Whitespace is not configuration.
		{"blank team id", func(h *accountDeletionHandler) { h.appleTeamID = "   " }, "APPLE_TEAM_ID"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := *full
			tc.mutate(&h)
			got := h.missingAppleConfig()
			if len(got) != 1 || got[0] != tc.wantGap {
				t.Errorf("missingAppleConfig = %v, want exactly [%s]", got, tc.wantGap)
			}
			if h.appleConfigured() {
				t.Error("a partial config must not count as configured")
			}
		})
	}
}

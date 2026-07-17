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

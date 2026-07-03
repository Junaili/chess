package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func TestInternalGatewayAuthInterceptor(t *testing.T) {
	t.Parallel()

	interceptor := internalGatewayAuthInterceptor("expected")
	info := &grpc.UnaryServerInfo{FullMethod: "/chessservice.ChessService/SendInvite"}
	handler := func(context.Context, interface{}) (interface{}, error) { return "ok", nil }

	if _, err := interceptor(context.Background(), nil, info, handler); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected unauthenticated without token, got %v", err)
	}

	wrong := metadata.NewIncomingContext(context.Background(), metadata.Pairs("x-internal-gateway-token", "wrong"))
	if _, err := interceptor(wrong, nil, info, handler); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected unauthenticated with wrong token, got %v", err)
	}

	valid := metadata.NewIncomingContext(context.Background(), metadata.Pairs("x-internal-gateway-token", "expected"))
	result, err := interceptor(valid, nil, info, handler)
	if err != nil || result != "ok" {
		t.Fatalf("expected authenticated call, got result=%v err=%v", result, err)
	}

	malformed := &grpc.UnaryServerInfo{FullMethod: "chessservice.ChessService/SendInvite"}
	if _, err := interceptor(valid, nil, malformed, handler); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected malformed method path to be denied, got %v", err)
	}
}

func TestCORSMiddlewareRejectsUnknownOrigin(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := corsMiddleware(map[string]struct{}{"https://junaili.github.io": {}}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		nextCalled = true
	}))
	req := httptest.NewRequest(http.MethodPost, "https://service.example/invite/email", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
	if nextCalled {
		t.Fatal("next handler must not run for an unapproved origin")
	}
}

func TestCORSMiddlewareAllowsPlayerAuthorizationHeader(t *testing.T) {
	t.Parallel()

	handler := corsMiddleware(
		map[string]struct{}{"https://junaili.github.io": {}},
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}),
	)
	req := httptest.NewRequest(http.MethodOptions, "https://service.example/safety/reasons", nil)
	req.Header.Set("Origin", "https://junaili.github.io")
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	req.Header.Set("Access-Control-Request-Headers", "x-chess-player-authorization")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "X-Chess-Player-Authorization") {
		t.Fatalf("player authorization header is not allowed: %q", got)
	}
}

func TestGenerateInternalGatewayToken(t *testing.T) {
	t.Parallel()

	first, err := generateInternalGatewayToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := generateInternalGatewayToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 || first == second {
		t.Fatalf("expected distinct 256-bit hex tokens")
	}
}

// TestAuthMiddlewareWrap locks the auth contract that produced the friend-lookup
// 401: a missing, inactive/expired, or wrong-namespace token must be rejected
// with 401, and a valid token must pass through to the handler. The IAM token
// introspection endpoint is stubbed.
func TestAuthMiddlewareWrap(t *testing.T) {
	t.Parallel()

	const ns = "seal-chessags"
	iam := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/iam/v3/oauth/introspect" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		switch r.FormValue("token") {
		case "valid":
			fmt.Fprintf(w, `{"active":true,"sub":"user-1","namespace":%q}`, ns)
		case "wrong-namespace":
			fmt.Fprint(w, `{"active":true,"sub":"user-1","namespace":"other-namespace"}`)
		default: // "expired" / anything else
			fmt.Fprint(w, `{"active":false}`)
		}
	}))
	defer iam.Close()

	auth := newAuthMiddleware(iam.URL, "client", "secret", ns)
	nextCalled := false
	handler := auth.wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
	}))

	cases := []struct {
		name     string
		token    string // "" means no Authorization header
		wantCode int
		wantNext bool
	}{
		{"missing token", "", http.StatusUnauthorized, false},
		{"expired/inactive token", "expired", http.StatusUnauthorized, false},
		{"wrong namespace", "wrong-namespace", http.StatusUnauthorized, false},
		{"valid token", "valid", http.StatusOK, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			nextCalled = false
			req := httptest.NewRequest(http.MethodGet, "https://service.example/lookup/email?email=x@example.com", nil)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.wantCode {
				t.Fatalf("status: got %d, want %d", rec.Code, tc.wantCode)
			}
			if nextCalled != tc.wantNext {
				t.Fatalf("next called: got %v, want %v", nextCalled, tc.wantNext)
			}
		})
	}

	t.Run("valid token in player authorization header", func(t *testing.T) {
		nextCalled = false
		req := httptest.NewRequest(http.MethodGet, "https://service.example/safety/reasons", nil)
		req.Header.Set("X-Chess-Player-Authorization", "Bearer valid")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !nextCalled {
			t.Fatalf("custom player token header failed: status=%d next=%v", rec.Code, nextCalled)
		}
	})
}

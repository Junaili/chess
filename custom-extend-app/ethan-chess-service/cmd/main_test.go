package main

import (
	"context"
	"net/http"
	"net/http/httptest"
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

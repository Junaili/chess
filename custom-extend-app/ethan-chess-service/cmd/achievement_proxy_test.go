package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// authedAchievementRequest mimics what auth.wrap puts in the context.
func authedAchievementRequest(method, path string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	ctx := context.WithValue(req.Context(), subCtxKey, "player-1")
	ctx = context.WithValue(ctx, accessTokenCtxKey, "player-token")
	return req.WithContext(ctx)
}

func TestAchievementCatalogProxyForwardsPlayerTokenAndPaging(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/achievement/v1/public/namespaces/seal-chessags/achievements" {
			t.Errorf("path: got %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("language"); got != "en" {
			t.Errorf("language: got %q, want en", got)
		}
		if got := r.URL.Query().Get("limit"); got != "100" {
			t.Errorf("limit: got %q, want 100", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer player-token" {
			t.Errorf("authorization: got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"achievementCode":"chess-clean-game"}]}`)
	}))
	defer upstream.Close()

	proxy := &achievementProxy{baseURL: upstream.URL, namespace: "seal-chessags", httpClient: upstream.Client()}
	rec := httptest.NewRecorder()

	proxy.handle(rec, authedAchievementRequest(http.MethodGet, "/achievement/catalog?language=en&limit=100&offset=0"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"chess-clean-game"`) {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

// The user id must come from the token, so a caller can never read or unlock
// another player's achievements by editing the path or query.
func TestAchievementUserFetchUsesTokenSubjectNotRequest(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "/achievement/v1/public/namespaces/seal-chessags/users/player-1/achievements"
		if r.URL.Path != want {
			t.Errorf("path: got %s, want %s", r.URL.Path, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"achievementCode":"chess-clean-game","status":2}]}`)
	}))
	defer upstream.Close()

	proxy := &achievementProxy{baseURL: upstream.URL, namespace: "seal-chessags", httpClient: upstream.Client()}
	rec := httptest.NewRecorder()

	proxy.handle(rec, authedAchievementRequest(http.MethodGet, "/achievement/me?userId=victim&limit=100"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
}

func TestAchievementUnlockForwardsPutForTokenSubject(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method: got %s, want PUT", r.Method)
		}
		want := "/achievement/v1/public/namespaces/seal-chessags/users/player-1/achievements/chess-first-friend/unlock"
		if r.URL.Path != want {
			t.Errorf("path: got %s, want %s", r.URL.Path, want)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	proxy := &achievementProxy{baseURL: upstream.URL, namespace: "seal-chessags", httpClient: upstream.Client()}
	rec := httptest.NewRecorder()

	proxy.handle(rec, authedAchievementRequest(http.MethodPut, "/achievement/me/unlock/chess-first-friend"))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status: got %d, want 204", rec.Code)
	}
}

// A repeat unlock is the normal case; the client relies on 409 surviving.
func TestAchievementUnlockPassesThroughConflict(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"errorCode":40172}`)
	}))
	defer upstream.Close()

	proxy := &achievementProxy{baseURL: upstream.URL, namespace: "seal-chessags", httpClient: upstream.Client()}
	rec := httptest.NewRecorder()

	proxy.handle(rec, authedAchievementRequest(http.MethodPut, "/achievement/me/unlock/chess-first-friend"))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status: got %d, want 409", rec.Code)
	}
}

func TestAchievementProxyRejectsUnsupportedRoutes(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream must not be called for %s", r.URL.Path)
	}))
	defer upstream.Close()

	proxy := &achievementProxy{baseURL: upstream.URL, namespace: "seal-chessags", httpClient: upstream.Client()}

	cases := []struct {
		name   string
		method string
		path   string
		want   int
	}{
		{"admin route", http.MethodGet, "/achievement/v1/admin/namespaces/seal-chessags/achievements", http.StatusNotFound},
		{"other user", http.MethodGet, "/achievement/users/victim/achievements", http.StatusNotFound},
		{"catalog write", http.MethodPost, "/achievement/catalog", http.StatusNotFound},
		{"traversal code", http.MethodPut, "/achievement/me/unlock/..%2f..%2fadmin", http.StatusBadRequest},
		{"empty code", http.MethodPut, "/achievement/me/unlock/", http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			proxy.handle(rec, authedAchievementRequest(tc.method, tc.path))
			if rec.Code != tc.want {
				t.Fatalf("status: got %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestAchievementProxyRequiresAuthenticatedSubject(t *testing.T) {
	t.Parallel()

	proxy := &achievementProxy{baseURL: "http://unused", namespace: "seal-chessags", httpClient: http.DefaultClient}
	rec := httptest.NewRecorder()

	proxy.handle(rec, httptest.NewRequest(http.MethodGet, "/achievement/me", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status: got %d, want 401", rec.Code)
	}
}

func TestAchievementPagingIsClamped(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/achievement/catalog?limit=100000&offset=-5", nil)
	query := achievementPagingQuery(req)

	if got := query.Get("limit"); got != "100" {
		t.Errorf("limit: got %q, want 100", got)
	}
	if got := query.Get("offset"); got != "0" {
		t.Errorf("offset: got %q, want 0", got)
	}
}

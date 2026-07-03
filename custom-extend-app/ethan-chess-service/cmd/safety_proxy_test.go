package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSafetyReasonsProxyForwardsPlayerTokenAndFixedQuery(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method: got %s, want GET", r.Method)
		}
		if r.URL.Path != "/reporting/v1/public/namespaces/seal-chessags/reasons" {
			t.Errorf("path: got %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("group"); got != "" {
			t.Errorf("group must not be set: got %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer player-token" {
			t.Errorf("authorization: got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"title":"Harassment","description":"Abusive behavior"}]}`)
	}))
	defer upstream.Close()

	proxy := &safetyProxy{
		baseURL:    upstream.URL,
		namespace:  "seal-chessags",
		httpClient: upstream.Client(),
	}
	req := httptest.NewRequest(http.MethodGet, "/safety/reasons", nil)
	req.Header.Set("Authorization", "Bearer player-token")
	rec := httptest.NewRecorder()

	proxy.reasons(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"title":"Harassment"`) {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

func TestSafetyReportsProxyForwardsValidatedReport(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method: got %s, want POST", r.Method)
		}
		if r.URL.Path != "/reporting/v1/public/namespaces/seal-chessags/reports" {
			t.Errorf("path: got %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer player-token" {
			t.Errorf("authorization: got %q", got)
		}
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode report: %v", err)
		}
		if payload["category"] != "USER" || payload["userId"] != "opponent-1" {
			t.Errorf("unexpected report: %#v", payload)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"ticketId":"ticket-1","status":"OPEN"}`)
	}))
	defer upstream.Close()

	proxy := &safetyProxy{
		baseURL:    upstream.URL,
		namespace:  "seal-chessags",
		httpClient: upstream.Client(),
	}
	req := httptest.NewRequest(
		http.MethodPost,
		"/safety/reports",
		strings.NewReader(`{"category":"USER","userId":"opponent-1","reason":"Harassment"}`),
	)
	req.Header.Set("Authorization", "Bearer player-token")
	rec := httptest.NewRecorder()

	proxy.reports(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status: got %d, want 201", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ticketId":"ticket-1"`) {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

func TestSafetyReportsProxyRejectsUnsupportedCategory(t *testing.T) {
	t.Parallel()

	proxy := &safetyProxy{
		baseURL:    "https://unused.example",
		namespace:  "seal-chessags",
		httpClient: http.DefaultClient,
	}
	req := httptest.NewRequest(
		http.MethodPost,
		"/safety/reports",
		strings.NewReader(`{"category":"UGC","userId":"opponent-1","reason":"Spam"}`),
	)
	rec := httptest.NewRecorder()

	proxy.reports(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", rec.Code)
	}
}

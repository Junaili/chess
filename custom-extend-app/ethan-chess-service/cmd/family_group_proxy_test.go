package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newFamilyProxyRequest(method, path, body string) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	// auth.wrap normally stashes the introspected player token in the context
	// (browser calls arrive with the access_token cookie, not a header).
	ctx := context.WithValue(req.Context(), accessTokenCtxKey, "player-token")
	return req.WithContext(ctx)
}

func TestFamilyGroupProxyForwardsMyGroupsWithPlayerToken(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method: got %s, want GET", r.Method)
		}
		if r.URL.Path != "/group/v2/public/namespaces/seal-chessags/users/me/groups" {
			t.Errorf("path: got %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "10" {
			t.Errorf("limit: got %q, want 10", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer player-token" {
			t.Errorf("authorization: got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"groupId":"g1","status":"JOINED"}]}`)
	}))
	defer upstream.Close()

	proxy := &familyGroupProxy{
		baseURL:    upstream.URL,
		namespace:  "seal-chessags",
		httpClient: upstream.Client(),
	}
	req := newFamilyProxyRequest(http.MethodGet,
		"/family/group/v2/public/namespaces/seal-chessags/users/me/groups?limit=10", "")
	rec := httptest.NewRecorder()

	proxy.handle(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"groupId":"g1"`) {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

func TestFamilyGroupProxyNormalizesNoJoinedGroup(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/group/v2/public/namespaces/seal-chessags/users/me/groups" {
			t.Errorf("path: got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"errorCode":73034,"message":"user has not joined a group"}`)
	}))
	defer upstream.Close()

	proxy := &familyGroupProxy{
		baseURL:    upstream.URL,
		namespace:  "seal-chessags",
		httpClient: upstream.Client(),
	}
	req := newFamilyProxyRequest(http.MethodGet,
		"/family/group/v2/public/namespaces/seal-chessags/users/me/groups?limit=10", "")
	rec := httptest.NewRecorder()

	proxy.handle(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if strings.TrimSpace(rec.Body.String()) != `{"data":[]}` {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

func TestFamilyGroupProxyPreservesOtherNotFound(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"errorCode":73035,"message":"group not found"}`)
	}))
	defer upstream.Close()

	proxy := &familyGroupProxy{
		baseURL:    upstream.URL,
		namespace:  "seal-chessags",
		httpClient: upstream.Client(),
	}
	req := newFamilyProxyRequest(http.MethodGet,
		"/family/group/v2/public/namespaces/seal-chessags/users/me/groups?limit=10", "")
	rec := httptest.NewRecorder()

	proxy.handle(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status: got %d, want 404: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"errorCode":73035`) {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

func TestFamilyGroupProxyForwardsValidatedCreate(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method: got %s, want POST", r.Method)
		}
		if r.URL.Path != "/group/v2/public/namespaces/seal-chessags/groups" {
			t.Errorf("path: got %s", r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("content-type: got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"groupId":"g-new"}`)
	}))
	defer upstream.Close()

	proxy := &familyGroupProxy{
		baseURL:    upstream.URL,
		namespace:  "seal-chessags",
		httpClient: upstream.Client(),
	}
	req := newFamilyProxyRequest(http.MethodPost,
		"/family/group/v2/public/namespaces/seal-chessags/groups",
		`{"groupName":"My Family","groupRegion":"us","groupType":"PRIVATE","configurationCode":"chess-family","groupMaxMember":8}`)
	rec := httptest.NewRecorder()

	proxy.handle(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status: got %d, want 201: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"groupId":"g-new"`) {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

func TestFamilyGroupProxyRejectsNonFamilyCreate(t *testing.T) {
	t.Parallel()

	proxy := &familyGroupProxy{
		baseURL:    "https://unused.example",
		namespace:  "seal-chessags",
		httpClient: http.DefaultClient,
	}
	for name, body := range map[string]string{
		"wrong configuration": `{"groupName":"Clan","groupType":"PRIVATE","configurationCode":"pro-clan","groupMaxMember":8}`,
		"public group":        `{"groupName":"Open","groupType":"PUBLIC","configurationCode":"chess-family","groupMaxMember":8}`,
		"oversized group":     `{"groupName":"Big","groupType":"PRIVATE","configurationCode":"chess-family","groupMaxMember":100}`,
		"not json":            `groupName=Family`,
	} {
		req := newFamilyProxyRequest(http.MethodPost,
			"/family/group/v2/public/namespaces/seal-chessags/groups", body)
		rec := httptest.NewRecorder()

		proxy.handle(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status got %d, want 400", name, rec.Code)
		}
	}
}

func TestFamilyGroupProxyRejectsUnlistedPaths(t *testing.T) {
	t.Parallel()

	proxy := &familyGroupProxy{
		baseURL:    "https://unused.example",
		namespace:  "seal-chessags",
		httpClient: http.DefaultClient,
	}
	cases := map[string]struct {
		method string
		path   string
	}{
		"admin endpoint":         {http.MethodGet, "/family/group/v1/admin/namespaces/seal-chessags/groups"},
		"traversal group id":     {http.MethodPost, "/family/group/v2/public/namespaces/seal-chessags/groups/../leave"},
		"other service":          {http.MethodGet, "/family/group/../iam/v3/public/users/me"},
		"delete via post":        {http.MethodPost, "/family/group/v1/public/namespaces/seal-chessags/groups/abc123/whatever"},
		"member role assignment": {http.MethodPost, "/family/group/v2/public/namespaces/seal-chessags/roles/r1/members"},
	}
	for name, tc := range cases {
		req := newFamilyProxyRequest(tc.method, tc.path, "")
		rec := httptest.NewRecorder()

		proxy.handle(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status got %d, want 404", name, rec.Code)
		}
	}
}

func TestFamilyGroupProxyRejectsForeignNamespace(t *testing.T) {
	t.Parallel()

	proxy := &familyGroupProxy{
		baseURL:    "https://unused.example",
		namespace:  "seal-chessags",
		httpClient: http.DefaultClient,
	}
	req := newFamilyProxyRequest(http.MethodGet,
		"/family/group/v2/public/namespaces/other-namespace/users/me/groups", "")
	rec := httptest.NewRecorder()

	proxy.handle(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status: got %d, want 403", rec.Code)
	}
}

func TestFamilyGroupProxyRequiresPlayerToken(t *testing.T) {
	t.Parallel()

	proxy := &familyGroupProxy{
		baseURL:    "https://unused.example",
		namespace:  "seal-chessags",
		httpClient: http.DefaultClient,
	}
	// No token in context and no Authorization header / cookie.
	req := httptest.NewRequest(http.MethodGet,
		"/family/group/v2/public/namespaces/seal-chessags/users/me/groups", nil)
	rec := httptest.NewRecorder()

	proxy.handle(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status: got %d, want 401", rec.Code)
	}
}

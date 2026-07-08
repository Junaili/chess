package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	maxFamilyRequestBody    = 16 << 10
	maxFamilyResponseBody   = 1 << 20
	familyConfigurationCode = "chess-family"
)

// The AGS Group service handles the CORS preflight but omits
// Access-Control-Allow-Origin on its actual API responses, so a browser can
// never read a Group reply cross-origin (verified against production — same
// class of problem as the CloudFront legal attachments). This proxy keeps the
// player token, so Group still enforces guardian/child roles and membership
// server-side; this service only provides the CORS boundary, exactly like the
// safety-report proxy above it in main.go.
type familyGroupProxy struct {
	baseURL    string
	namespace  string
	httpClient *http.Client
}

func newFamilyGroupProxyFromEnv() *familyGroupProxy {
	return &familyGroupProxy{
		baseURL:    strings.TrimRight(os.Getenv("AB_BASE_URL"), "/"),
		namespace:  os.Getenv("AB_NAMESPACE"),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// Only the exact Group endpoints src/family.js calls are forwarded; anything
// else (admin routes, other services, traversal segments) is rejected here.
// IDs are a single path segment with no dots, so ".." can never match.
const familyIDSegment = `[a-zA-Z0-9_-]{1,64}`

// The group-create endpoint — the only whitelisted route that carries a
// request body, which gets validated so this proxy can't be used to mint
// arbitrary (non-family) groups.
var createFamilyGroupPattern = regexp.MustCompile(`^v2/public/namespaces/([^/]+)/groups$`)

var familyGroupRoutes = []struct {
	method  string
	pattern *regexp.Regexp
}{
	{http.MethodGet, regexp.MustCompile(`^v2/public/namespaces/([^/]+)/roles$`)},
	{http.MethodGet, regexp.MustCompile(`^v2/public/namespaces/([^/]+)/users/me/groups$`)},
	{http.MethodGet, regexp.MustCompile(`^v1/public/namespaces/([^/]+)/users/me/invite/request$`)},
	{http.MethodGet, regexp.MustCompile(`^v1/public/namespaces/([^/]+)/groups/` + familyIDSegment + `$`)},
	{http.MethodPost, createFamilyGroupPattern},
	{http.MethodPost, regexp.MustCompile(`^v2/public/namespaces/([^/]+)/users/` + familyIDSegment + `/groups/` + familyIDSegment + `/invite$`)},
	{http.MethodPost, regexp.MustCompile(`^v2/public/namespaces/([^/]+)/groups/` + familyIDSegment + `/invite/accept$`)},
	{http.MethodPost, regexp.MustCompile(`^v1/public/namespaces/([^/]+)/groups/` + familyIDSegment + `/invite/reject$`)},
	{http.MethodPost, regexp.MustCompile(`^v2/public/namespaces/([^/]+)/users/` + familyIDSegment + `/groups/` + familyIDSegment + `/kick$`)},
	{http.MethodPost, regexp.MustCompile(`^v2/public/namespaces/([^/]+)/groups/` + familyIDSegment + `/leave$`)},
	{http.MethodDelete, regexp.MustCompile(`^v1/public/namespaces/([^/]+)/groups/` + familyIDSegment + `$`)},
}

func isCreateGroupPath(method, rest string) bool {
	return method == http.MethodPost && createFamilyGroupPattern.MatchString(rest)
}

func matchFamilyGroupRoute(method, rest string) (namespace string, ok bool) {
	for _, route := range familyGroupRoutes {
		if route.method != method {
			continue
		}
		if m := route.pattern.FindStringSubmatch(rest); m != nil {
			return m[1], true
		}
	}
	return "", false
}

func (h *familyGroupProxy) handle(w http.ResponseWriter, r *http.Request) {
	const marker = "/family/group/"
	idx := strings.Index(r.URL.Path, marker)
	if idx < 0 {
		writeFamilyError(w, http.StatusNotFound, "unknown family endpoint")
		return
	}
	rest := r.URL.Path[idx+len(marker):]

	namespace, ok := matchFamilyGroupRoute(r.Method, rest)
	if !ok {
		writeFamilyError(w, http.StatusNotFound, "unsupported group endpoint")
		return
	}
	if namespace != h.namespace {
		writeFamilyError(w, http.StatusForbidden, "namespace not allowed")
		return
	}

	var body io.Reader
	if isCreateGroupPath(r.Method, rest) {
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxFamilyRequestBody+1))
		if err != nil {
			writeFamilyError(w, http.StatusBadRequest, "could not read request")
			return
		}
		if len(raw) > maxFamilyRequestBody {
			writeFamilyError(w, http.StatusRequestEntityTooLarge, "request is too large")
			return
		}
		if err := validateCreateFamilyGroupBody(raw); err != nil {
			writeFamilyError(w, http.StatusBadRequest, err.Error())
			return
		}
		body = bytes.NewReader(raw)
	}

	endpoint := h.baseURL + "/group/" + rest
	query := url.Values{}
	for _, key := range []string{"limit", "offset"} {
		if v := r.URL.Query().Get(key); v != "" {
			query.Set(key, v)
		}
	}
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}

	h.forward(w, r, r.Method, endpoint, body)
}

func validateCreateFamilyGroupBody(raw []byte) error {
	var payload struct {
		GroupName         string `json:"groupName"`
		GroupType         string `json:"groupType"`
		ConfigurationCode string `json:"configurationCode"`
		GroupMaxMember    int    `json:"groupMaxMember"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("invalid group request")
	}
	if payload.ConfigurationCode != familyConfigurationCode ||
		payload.GroupType != "PRIVATE" ||
		payload.GroupMaxMember < 1 || payload.GroupMaxMember > 8 ||
		strings.TrimSpace(payload.GroupName) == "" || len(payload.GroupName) > 64 {
		return fmt.Errorf("invalid family group request")
	}
	return nil
}

func (h *familyGroupProxy) forward(
	w http.ResponseWriter,
	incoming *http.Request,
	method string,
	endpoint string,
	body io.Reader,
) {
	req, err := http.NewRequestWithContext(incoming.Context(), method, endpoint, body)
	if err != nil {
		writeFamilyError(w, http.StatusInternalServerError, "could not prepare group request")
		return
	}
	token := accessTokenFromContext(incoming.Context())
	if token == "" {
		parts := strings.Fields(playerAuthorizationHeader(incoming))
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			token = parts[1]
		}
	}
	if token == "" {
		writeFamilyError(w, http.StatusUnauthorized, "missing player token")
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := h.httpClient.Do(req)
	if err != nil {
		writeFamilyError(w, http.StatusBadGateway, "group service unavailable")
		return
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxFamilyResponseBody))
	if err != nil {
		writeFamilyError(w, http.StatusBadGateway, "invalid group response")
		return
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(raw)
}

func writeFamilyError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxAchievementResponseBody = 1 << 20

// The AGS Achievement service answers no CORS preflight at all — OPTIONS on
// every /achievement/v1/public route returns 405 with no Access-Control-*
// headers, and its real responses omit Access-Control-Allow-Origin too
// (verified against production 2026-08-12). So no browser could ever read the
// catalog, the player's unlock list, or unlock an event achievement; the client
// swallowed the failures, which is why the badge panel was quietly empty rather
// than loudly broken. Same shape as the Group gap this service already proxies.
//
// The player's own token is forwarded, so Achievement still enforces who may
// read and unlock what; this service only supplies the CORS boundary. The user
// id comes from the introspected token, never from the request, so this route
// cannot be pointed at another player.
type achievementProxy struct {
	baseURL    string
	namespace  string
	httpClient *http.Client
}

func newAchievementProxyFromEnv() *achievementProxy {
	return &achievementProxy{
		baseURL:    strings.TrimRight(os.Getenv("AB_BASE_URL"), "/"),
		namespace:  os.Getenv("AB_NAMESPACE"),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// Achievement codes are provisioned by us and are a single path segment, so a
// dot can never appear and ".." can never traverse.
var achievementCodePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// Language tags for the catalog: "en", "en-US". Anything else falls back to en
// rather than reaching upstream.
var achievementLanguagePattern = regexp.MustCompile(`^[a-zA-Z]{2}(-[a-zA-Z]{2})?$`)

func (h *achievementProxy) handle(w http.ResponseWriter, r *http.Request) {
	const marker = "/achievement/"
	idx := strings.Index(r.URL.Path, marker)
	if idx < 0 {
		writeAchievementError(w, http.StatusNotFound, "unknown achievement endpoint")
		return
	}
	rest := r.URL.Path[idx+len(marker):]

	userID := subFromContext(r.Context())
	if userID == "" {
		writeAchievementError(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	switch {
	case rest == "catalog" && r.Method == http.MethodGet:
		h.catalog(w, r)
	case rest == "me" && r.Method == http.MethodGet:
		h.userAchievements(w, r, userID)
	case strings.HasPrefix(rest, "me/unlock/") && r.Method == http.MethodPut:
		h.unlock(w, r, userID, strings.TrimPrefix(rest, "me/unlock/"))
	default:
		writeAchievementError(w, http.StatusNotFound, "unsupported achievement endpoint")
	}
}

func (h *achievementProxy) catalog(w http.ResponseWriter, r *http.Request) {
	language := r.URL.Query().Get("language")
	if !achievementLanguagePattern.MatchString(language) {
		language = "en"
	}
	query := achievementPagingQuery(r)
	query.Set("language", language)

	endpoint := fmt.Sprintf(
		"%s/achievement/v1/public/namespaces/%s/achievements?%s",
		h.baseURL,
		url.PathEscape(h.namespace),
		query.Encode(),
	)
	h.forward(w, r, http.MethodGet, endpoint)
}

func (h *achievementProxy) userAchievements(w http.ResponseWriter, r *http.Request, userID string) {
	endpoint := fmt.Sprintf(
		"%s/achievement/v1/public/namespaces/%s/users/%s/achievements?%s",
		h.baseURL,
		url.PathEscape(h.namespace),
		url.PathEscape(userID),
		achievementPagingQuery(r).Encode(),
	)
	h.forward(w, r, http.MethodGet, endpoint)
}

func (h *achievementProxy) unlock(w http.ResponseWriter, r *http.Request, userID, code string) {
	if !achievementCodePattern.MatchString(code) {
		writeAchievementError(w, http.StatusBadRequest, "invalid achievement code")
		return
	}
	endpoint := fmt.Sprintf(
		"%s/achievement/v1/public/namespaces/%s/users/%s/achievements/%s/unlock",
		h.baseURL,
		url.PathEscape(h.namespace),
		url.PathEscape(userID),
		url.PathEscape(code),
	)
	h.forward(w, r, http.MethodPut, endpoint)
}

// limit/offset are clamped here so a caller can't turn this route into a bulk
// reader of the namespace catalog.
func achievementPagingQuery(r *http.Request) url.Values {
	query := url.Values{}
	query.Set("limit", strconv.Itoa(achievementBoundedInt(r.URL.Query().Get("limit"), 100, 1, 100)))
	query.Set("offset", strconv.Itoa(achievementBoundedInt(r.URL.Query().Get("offset"), 0, 0, 10_000)))
	return query
}

func achievementBoundedInt(raw string, fallback, min, max int) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return fallback
	}
	return n
}

func (h *achievementProxy) forward(w http.ResponseWriter, incoming *http.Request, method, endpoint string) {
	req, err := http.NewRequestWithContext(incoming.Context(), method, endpoint, nil)
	if err != nil {
		writeAchievementError(w, http.StatusInternalServerError, "could not prepare achievement request")
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
		writeAchievementError(w, http.StatusUnauthorized, "missing player token")
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := h.httpClient.Do(req)
	if err != nil {
		writeAchievementError(w, http.StatusBadGateway, "achievement service unavailable")
		return
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAchievementResponseBody))
	if err != nil {
		writeAchievementError(w, http.StatusBadGateway, "invalid achievement response")
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

func writeAchievementError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"error":%q}`, message)
}

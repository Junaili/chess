package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	maxSafetyReportBody     = 16 << 10
	maxSafetyResponseBody   = 1 << 20
	playerSafetyReasonGroup = "Player Safety"
)

type safetyProxy struct {
	baseURL    string
	namespace  string
	httpClient *http.Client
}

func newSafetyProxyFromEnv() *safetyProxy {
	return &safetyProxy{
		baseURL:    strings.TrimRight(os.Getenv("AB_BASE_URL"), "/"),
		namespace:  os.Getenv("AB_NAMESPACE"),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func (h *safetyProxy) reasons(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeSafetyError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	endpoint := fmt.Sprintf(
		"%s/reporting/v1/public/namespaces/%s/reasons",
		h.baseURL,
		url.PathEscape(h.namespace),
	)
	query := url.Values{}
	query.Set("group", playerSafetyReasonGroup)
	query.Set("limit", "100")
	query.Set("offset", "0")

	h.forward(w, r, http.MethodGet, endpoint+"?"+query.Encode(), nil)
}

func (h *safetyProxy) reports(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeSafetyError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, maxSafetyReportBody+1))
	if err != nil {
		writeSafetyError(w, http.StatusBadRequest, "could not read report")
		return
	}
	if len(raw) > maxSafetyReportBody {
		writeSafetyError(w, http.StatusRequestEntityTooLarge, "report is too large")
		return
	}

	var report struct {
		Category string `json:"category"`
		UserID   string `json:"userId"`
		Reason   string `json:"reason"`
	}
	if err := json.Unmarshal(raw, &report); err != nil {
		writeSafetyError(w, http.StatusBadRequest, "invalid report")
		return
	}
	if (report.Category != "USER" && report.Category != "CHAT") ||
		strings.TrimSpace(report.UserID) == "" ||
		strings.TrimSpace(report.Reason) == "" {
		writeSafetyError(w, http.StatusBadRequest, "invalid report")
		return
	}

	endpoint := fmt.Sprintf(
		"%s/reporting/v1/public/namespaces/%s/reports",
		h.baseURL,
		url.PathEscape(h.namespace),
	)
	h.forward(w, r, http.MethodPost, endpoint, bytes.NewReader(raw))
}

func (h *safetyProxy) forward(
	w http.ResponseWriter,
	incoming *http.Request,
	method string,
	endpoint string,
	body io.Reader,
) {
	req, err := http.NewRequestWithContext(incoming.Context(), method, endpoint, body)
	if err != nil {
		writeSafetyError(w, http.StatusInternalServerError, "could not prepare reporting request")
		return
	}
	req.Header.Set("Authorization", incoming.Header.Get("Authorization"))
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := h.httpClient.Do(req)
	if err != nil {
		writeSafetyError(w, http.StatusBadGateway, "reporting service unavailable")
		return
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxSafetyResponseBody))
	if err != nil {
		writeSafetyError(w, http.StatusBadGateway, "invalid reporting response")
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

func writeSafetyError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

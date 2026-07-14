package main

// The per-user monetization ledger (dev-plan §6.4). Idempotency source of
// truth for every coin credit/debit and (via txKeys) every Stripe/Apple
// period grant. Stored as a CloudSave admin player record with optimistic
// concurrency control so concurrent /club/status calls (two devices, or a
// webhook racing a status refresh) can never double-credit — see §6.5's
// "double-credit trap" note, which this file exists specifically to close.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	ledgerRecordKey        = "monetization-ledger"
	ledgerMaxEntries       = 400
	ledgerPruneKeepEntries = 300
	maxLedgerRetries       = 5
)

type ledgerEntry struct {
	Amount int    `json:"amount"`
	At     string `json:"at"`
	Kind   string `json:"kind"`
}

type monetizationLedger struct {
	StripeCustomerID string                 `json:"stripeCustomerId,omitempty"`
	Credits          map[string]ledgerEntry `json:"credits"`
	Debits           map[string]ledgerEntry `json:"debits"`
	// Counters backs Open Journal Day narrative quotas (§8.5): keys like
	// "narr:2026-07-12" or "narr-week:2026-W28" mapping to a use count.
	Counters map[string]int `json:"counters,omitempty"`
}

func newLedger() monetizationLedger {
	return monetizationLedger{
		Credits:  map[string]ledgerEntry{},
		Debits:   map[string]ledgerEntry{},
		Counters: map[string]int{},
	}
}

// txKey formats (§6.4/§6.5). All period credits — Stripe or Apple — use the
// SAME platform-neutral key so reconciliation and the webhook can never both
// credit the same billing period.

// txKeyPeriod canonicalizes the timestamp to second-precision RFC3339 before
// keying: the Stripe webhook keys with its own formatting ("…T00:00:00Z")
// while reconciliation re-derives the key from the AGS entitlement's echoed
// endDate ("…T00:00:00.000Z" — AGS adds milliseconds). Without one canonical
// form those are two different ledger keys for the same billing period, and
// the §6.5 double-credit trap reopens.
func txKeyPeriod(sku, endDateISO string) string {
	if t, err := time.Parse(time.RFC3339, endDateISO); err == nil {
		endDateISO = t.UTC().Format(time.RFC3339)
	}
	return "period:" + sku + ":" + endDateISO
}

// periodEndFromTxKey recovers the period-end timestamp encoded in a
// `period:<sku>:<endDateISO>` txKey (SKUs never contain ':').
func periodEndFromTxKey(key string) (time.Time, bool) {
	rest, ok := strings.CutPrefix(key, "period:")
	if !ok {
		return time.Time{}, false
	}
	i := strings.Index(rest, ":")
	if i < 0 {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, rest[i+1:])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}
func txKeyLifetime(sku string) string           { return "life:" + sku }
func txKeyHighFive(matchID, senderID string) string {
	return "hf:" + matchID + ":" + senderID
}
func txKeyAllowance(id string) string       { return "alw:" + id }
func txKeyClawback(original string) string  { return "clawback:" + original }
func txKeyNarrativeDay(day string) string   { return "narr:" + day }
func txKeyNarrativeWeek(week string) string { return "narr-week:" + week }

func pruneLedger(l *monetizationLedger) {
	pruneEntries(l.Credits)
	pruneEntries(l.Debits)
}

func pruneEntries(m map[string]ledgerEntry) {
	if len(m) <= ledgerMaxEntries {
		return
	}
	type kv struct {
		key   string
		entry ledgerEntry
	}
	items := make([]kv, 0, len(m))
	for k, v := range m {
		items = append(items, kv{k, v})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].entry.At > items[j].entry.At })
	for k := range m {
		delete(m, k)
	}
	for i := 0; i < ledgerPruneKeepEntries && i < len(items); i++ {
		m[items[i].key] = items[i].entry
	}
}

var errLedgerConflict = errors.New("ledger record changed since read (412)")

// readLedger fetches the caller's ledger record. A record that doesn't exist
// yet is not an error — it's returned as a fresh empty ledger with an empty
// updatedAt sentinel (passed straight through to the next write attempt).
func (h *monetizationHandler) readLedger(userID string) (monetizationLedger, string, error) {
	raw, updatedAt, err := h.getAdminPlayerRecord(userID, ledgerRecordKey)
	if err != nil {
		return monetizationLedger{}, "", err
	}
	if raw == nil {
		return newLedger(), "", nil
	}
	var ledger monetizationLedger
	if err := json.Unmarshal(raw, &ledger); err != nil {
		return monetizationLedger{}, "", fmt.Errorf("decode ledger: %w", err)
	}
	if ledger.Credits == nil {
		ledger.Credits = map[string]ledgerEntry{}
	}
	if ledger.Debits == nil {
		ledger.Debits = map[string]ledgerEntry{}
	}
	if ledger.Counters == nil {
		ledger.Counters = map[string]int{}
	}
	return ledger, updatedAt, nil
}

// mutateLedger reads the ledger, applies fn (which returns false to signal
// "nothing to change, don't write"), and writes it back under optimistic
// concurrency. On a 412 conflict it re-reads and re-applies fn from scratch —
// fn MUST be idempotent/side-effect-free beyond mutating the ledger pointer
// it's given, since it may run more than once for a single logical call.
//
// The returned `wrote` bool is load-bearing, not informational: it's false
// whenever fn declined to change anything (the txKey it wanted to add was
// already present — someone else, or an earlier attempt of THIS call, got
// there first). Every caller that follows a ledger write with a real-money
// side effect (crediting/debiting the AGS wallet) MUST gate that side effect
// on wrote — otherwise a webhook replay or a retried request re-runs the
// side effect even though the ledger correctly recognized it as a duplicate.
// This was caught by TestHandleInvoicePaidGrantsAndCreditsOnce during
// implementation: an earlier version checked "does the txKey exist in the
// returned ledger", which is true on BOTH a fresh write and a no-op skip,
// and so never actually prevented the double credit it was meant to.
func (h *monetizationHandler) mutateLedger(userID string, fn func(*monetizationLedger) bool) (ledger monetizationLedger, wrote bool, err error) {
	var lastErr error
	for attempt := 0; attempt < maxLedgerRetries; attempt++ {
		ledger, updatedAt, err := h.readLedger(userID)
		if err != nil {
			return monetizationLedger{}, false, err
		}
		if !fn(&ledger) {
			return ledger, false, nil
		}
		pruneLedger(&ledger)
		if err := h.putAdminPlayerRecordConcurrent(userID, ledgerRecordKey, ledger, updatedAt); err != nil {
			if errors.Is(err, errLedgerConflict) {
				lastErr = err
				continue
			}
			return monetizationLedger{}, false, err
		}
		return ledger, true, nil
	}
	if lastErr == nil {
		lastErr = errors.New("ledger write did not converge")
	}
	return monetizationLedger{}, false, fmt.Errorf("ledger update for %s: exceeded %d retries: %w", userID, maxLedgerRetries, lastErr)
}

// ---------------------------------------------------------------------------
// CloudSave admin player record transport (justice-cloudsave-service 3.32.0)
// ---------------------------------------------------------------------------

// cloudSaveRecordEnvelope mirrors the concurrent-record PUT request body
// shape (value/updatedAt/tags) — the GET response was not directly inspected
// during implementation (the AGS API MCP did not return response schemas for
// CloudSave GETs). This is AGS CloudSave's documented convention and should
// be re-confirmed against a real GET response during M4's live acceptance
// check; if the field names differ, fix them here only — every other
// ledger/config call in this file goes through these two functions.
type cloudSaveRecordEnvelope struct {
	Value     json.RawMessage `json:"value"`
	UpdatedAt string          `json:"updatedAt"`
}

// getAdminPlayerRecord returns (nil, "", nil) when the record does not exist
// yet — that's the expected steady state for a brand new user.
func (h *monetizationHandler) getAdminPlayerRecord(userID, key string) (json.RawMessage, string, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return nil, "", err
	}
	endpoint := fmt.Sprintf("%s/cloudsave/v1/admin/namespaces/%s/users/%s/adminrecords/%s",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.PathEscape(key))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, "", nil
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, "", fmt.Errorf("get admin player record %s/%s returned %d", userID, key, resp.StatusCode)
	}
	var envelope cloudSaveRecordEnvelope
	if err := json.NewDecoder(io.LimitReader(resp.Body, 512<<10)).Decode(&envelope); err != nil {
		return nil, "", fmt.Errorf("decode admin player record %s/%s: %w", userID, key, err)
	}
	return envelope.Value, envelope.UpdatedAt, nil
}

// putAdminPlayerRecordConcurrent writes value under optimistic concurrency:
// updatedAt must be exactly what the last read returned ("" for a
// not-yet-existing record). Returns errLedgerConflict on a 412 so callers can
// retry from a fresh read.
func (h *monetizationHandler) putAdminPlayerRecordConcurrent(userID, key string, value any, updatedAt string) error {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{
		"value":     json.RawMessage(raw),
		"updatedAt": updatedAt,
	})
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/cloudsave/v1/admin/namespaces/%s/users/%s/concurrent/adminrecords/%s",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(userID), url.PathEscape(key))
	req, err := http.NewRequest(http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode == http.StatusPreconditionFailed {
		return errLedgerConflict
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("put admin player record %s/%s returned %d", userID, key, resp.StatusCode)
	}
	return nil
}

// getAdminGameRecord reads a namespace-level (not user-scoped) admin record —
// used for the Open Journal Day config, which is edited via the Admin Portal
// and only ever read here.
func (h *monetizationHandler) getAdminGameRecord(key string) (json.RawMessage, error) {
	token, err := h.clientCredentialsToken()
	if err != nil {
		return nil, err
	}
	endpoint := fmt.Sprintf("%s/cloudsave/v1/admin/namespaces/%s/adminrecords/%s",
		h.agsBaseURL, url.PathEscape(h.namespace), url.PathEscape(key))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, fmt.Errorf("get admin game record %s returned %d", key, resp.StatusCode)
	}
	var envelope cloudSaveRecordEnvelope
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode admin game record %s: %w", key, err)
	}
	return envelope.Value, nil
}

// clientCredentialsToken duplicates accountDeletionHandler's helper by
// design — this codebase's convention is one small S2S-token method per
// handler struct rather than a shared admin client (see account_deletion.go).
func (h *monetizationHandler) clientCredentialsToken() (string, error) {
	values := url.Values{"grant_type": {"client_credentials"}}
	req, err := http.NewRequest(http.MethodPost, h.agsBaseURL+"/iam/v3/oauth/token", bytes.NewReader([]byte(values.Encode())))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(h.clientID, h.clientSecret)

	resp, err := h.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return "", fmt.Errorf("client credentials returned %d", resp.StatusCode)
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&payload); err != nil {
		return "", err
	}
	if payload.AccessToken == "" {
		return "", errors.New("client credentials returned no access token")
	}
	return payload.AccessToken, nil
}

// timeNowISO is a tiny helper kept here (rather than inlined everywhere) so
// tests can assert on the exact RFC3339 formatting used for ledger At fields.
func timeNowISO(now time.Time) string {
	return now.UTC().Format(time.RFC3339)
}

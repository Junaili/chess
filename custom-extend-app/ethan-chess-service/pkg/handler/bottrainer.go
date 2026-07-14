package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// The bot's games live in a namespace-level admin game record (server-owned),
// keyed per bot. This avoids needing a dedicated AGS account for the bot and is
// where both self-play and (later) human-vs-bot games are recorded.
func BotHistoryKey(botID string) string {
	return "chess-bot-" + botID + "-history"
}

// botHistoryValue is the JSON value stored in the admin game record.
type botHistoryValue struct {
	Matches   []botbrain.MatchEntry `json:"matches"`
	UpdatedAt string                `json:"updatedAt"`
}

var errAdminRecordConflict = errors.New("cloudsave admin record write conflict")

const adminRecordMutationRetries = 8

// AccelByte recommends keeping JSON CloudSave records at or below 1 MiB. Leave
// headroom for the CloudSave envelope/metadata so history writes stay fast and
// reliable even when games run long.
const botHistoryTargetBytes = 900 << 10

type adminRecordEnvelope struct {
	Value     json.RawMessage `json:"value"`
	UpdatedAt string          `json:"updatedAt"`
}

func agsConfig() (baseURL, clientID, clientSecret, namespace string, err error) {
	baseURL = strings.TrimRight(os.Getenv("AB_BASE_URL"), "/")
	clientID = os.Getenv("AB_CLIENT_ID")
	clientSecret = os.Getenv("AB_CLIENT_SECRET")
	namespace = os.Getenv("AB_NAMESPACE")
	if baseURL == "" || clientID == "" || clientSecret == "" || namespace == "" {
		err = fmt.Errorf("AGS configuration is incomplete (need AB_BASE_URL, AB_CLIENT_ID, AB_CLIENT_SECRET, AB_NAMESPACE)")
	}
	return
}

func adminRecordURL(baseURL, namespace, key string) string {
	return fmt.Sprintf("%s/cloudsave/v1/admin/namespaces/%s/adminrecords/%s",
		baseURL, url.PathEscape(namespace), url.PathEscape(key))
}

func concurrentAdminRecordURL(baseURL, namespace, key string) string {
	return fmt.Sprintf("%s/cloudsave/v1/admin/namespaces/%s/concurrent/adminrecords/%s",
		baseURL, url.PathEscape(namespace), url.PathEscape(key))
}

// fetchAdminGameRecordRaw reads a namespace-level admin record together with
// its CloudSave updatedAt precondition. Every mutable Gus record goes through
// this helper so multi-replica updates can use optimistic concurrency.
func fetchAdminGameRecordRaw(key string) (value json.RawMessage, updatedAt string, found bool, err error) {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return nil, "", false, err
	}
	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return nil, "", false, fmt.Errorf("get token: %w", err)
	}
	req, err := http.NewRequest(http.MethodGet, adminRecordURL(baseURL, namespace, key), nil)
	if err != nil {
		return nil, "", false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return nil, "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, "", false, nil
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, "", false, fmt.Errorf("cloudsave admin record %q returned status %d", key, resp.StatusCode)
	}
	var envelope adminRecordEnvelope
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&envelope); err != nil {
		return nil, "", false, fmt.Errorf("parse admin record %q: %w", key, err)
	}
	return envelope.Value, envelope.UpdatedAt, true, nil
}

// putAdminGameRecordConcurrent writes only if updatedAt still matches the
// preceding read. A 412 is returned as errAdminRecordConflict so callers can
// re-read, re-apply their pure mutation, and retry without losing another
// replica's update.
func putAdminGameRecordConcurrent(key string, value any, updatedAt string) error {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return err
	}
	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return fmt.Errorf("get token: %w", err)
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
	req, err := http.NewRequest(http.MethodPut, concurrentAdminRecordURL(baseURL, namespace, key), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	rawResp, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode == http.StatusPreconditionFailed {
		return errAdminRecordConflict
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("concurrent save admin record %q returned %d: %s", key, resp.StatusCode, string(rawResp))
	}
	return nil
}

// FetchAllBotGames returns every game in the bot's history record (or nil if the
// record does not exist yet).
func FetchAllBotGames(key string) ([]botbrain.MatchEntry, error) {
	raw, _, found, err := fetchAdminGameRecordRaw(key)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	var value botHistoryValue
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("parse admin game record: %w", err)
	}
	// Historical writers were not replica-safe. Collapse any legacy retry
	// duplicates here so profiles, training tallies, and promotion samples all
	// see one completed match exactly once.
	return uniqueBotMatches(value.Matches), nil
}

func uniqueBotMatches(matches []botbrain.MatchEntry) []botbrain.MatchEntry {
	seen := make(map[string]bool, len(matches))
	unique := make([]botbrain.MatchEntry, 0, len(matches))
	for _, match := range matches {
		if match.ID != "" {
			if seen[match.ID] {
				continue
			}
			seen[match.ID] = true
		}
		unique = append(unique, match)
	}
	return unique
}

func compactBotHistory(matches []botbrain.MatchEntry, capEntries int) []botbrain.MatchEntry {
	matches = uniqueBotMatches(matches)
	if capEntries <= 0 {
		capEntries = 500
	}
	if len(matches) > capEntries {
		matches = matches[len(matches)-capEntries:]
	}
	for len(matches) > 1 {
		raw, err := json.Marshal(botHistoryValue{Matches: matches})
		if err != nil || len(raw) <= botHistoryTargetBytes {
			break
		}
		// Drop a proportional oldest slice, avoiding hundreds of near-identical
		// re-marshals when a record is far over the target.
		drop := (len(matches)*(len(raw)-botHistoryTargetBytes))/len(raw) + 1
		if drop >= len(matches) {
			drop = len(matches) - 1
		}
		matches = matches[drop:]
	}
	return append([]botbrain.MatchEntry(nil), matches...)
}

// FetchBotGameHistory returns the bot's games that ended at or after `since`.
func FetchBotGameHistory(key string, since time.Time) ([]botbrain.MatchEntry, error) {
	all, err := FetchAllBotGames(key)
	if err != nil {
		return nil, err
	}
	out := make([]botbrain.MatchEntry, 0, len(all))
	for _, m := range all {
		if !since.IsZero() {
			t := m.EndedAtTime()
			if t.IsZero() || t.Before(since) {
				continue
			}
		}
		out = append(out, m)
	}
	return out, nil
}

// SaveBotGameHistory merges a batch under optimistic concurrency. This is used
// by the offline spar generator; preserving rows that arrived after its read
// prevents a manual self-play upload from erasing live AMS games.
func SaveBotGameHistory(key string, matches []botbrain.MatchEntry) error {
	for attempt := 0; attempt < adminRecordMutationRetries; attempt++ {
		raw, updatedAt, found, err := fetchAdminGameRecordRaw(key)
		if err != nil {
			return err
		}
		value := botHistoryValue{}
		if found {
			if err := json.Unmarshal(raw, &value); err != nil {
				return fmt.Errorf("parse bot history %q: %w", key, err)
			}
		}
		value.Matches = compactBotHistory(append(value.Matches, matches...), 500)
		value.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := putAdminGameRecordConcurrent(key, value, updatedAt); err != nil {
			if errors.Is(err, errAdminRecordConflict) {
				continue
			}
			return err
		}
		return nil
	}
	return fmt.Errorf("merge bot history: exceeded %d concurrent-update retries", adminRecordMutationRetries)
}

// AppendBotGame appends a match exactly once under CloudSave optimistic
// concurrency. It is safe across Extend replicas and retries the full
// read/merge/write transaction on a 412.
func AppendBotGame(key string, entry botbrain.MatchEntry, capEntries int) (duplicate bool, err error) {
	if capEntries <= 0 {
		capEntries = 500
	}
	for attempt := 0; attempt < adminRecordMutationRetries; attempt++ {
		raw, updatedAt, found, err := fetchAdminGameRecordRaw(key)
		if err != nil {
			return false, err
		}
		value := botHistoryValue{}
		if found {
			if err := json.Unmarshal(raw, &value); err != nil {
				return false, fmt.Errorf("parse bot history %q: %w", key, err)
			}
			value.Matches = uniqueBotMatches(value.Matches)
		}
		for _, m := range value.Matches {
			if m.ID == entry.ID {
				return true, nil
			}
		}
		value.Matches = compactBotHistory(append(value.Matches, entry), capEntries)
		value.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := putAdminGameRecordConcurrent(key, value, updatedAt); err != nil {
			if errors.Is(err, errAdminRecordConflict) {
				continue
			}
			return false, err
		}
		return false, nil
	}
	return false, fmt.Errorf("append bot game %s: exceeded %d concurrent-update retries", entry.ID, adminRecordMutationRetries)
}

package handler

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

// FetchAllBotGames returns every game in the bot's history record (or nil if the
// record does not exist yet).
func FetchAllBotGames(key string) ([]botbrain.MatchEntry, error) {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return nil, err
	}
	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return nil, fmt.Errorf("get token: %w", err)
	}

	req, err := http.NewRequest(http.MethodGet, adminRecordURL(baseURL, namespace, key), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, fmt.Errorf("cloudsave admin game record returned status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	var rec struct {
		Value botHistoryValue `json:"value"`
	}
	if err := json.Unmarshal(body, &rec); err != nil {
		return nil, fmt.Errorf("parse admin game record: %w", err)
	}
	return rec.Value.Matches, nil
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

// SaveBotGameHistory replaces the bot's history record with the given games
// (server-owned). Caller is responsible for merge/cap ordering.
func SaveBotGameHistory(key string, matches []botbrain.MatchEntry) error {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return err
	}
	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return fmt.Errorf("get token: %w", err)
	}

	payload := botHistoryValue{Matches: matches, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest(http.MethodPut, adminRecordURL(baseURL, namespace, key), bytes.NewReader(body))
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
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return fmt.Errorf("save admin game record returned %d: %s", resp.StatusCode, string(raw))
	}
	return nil
}

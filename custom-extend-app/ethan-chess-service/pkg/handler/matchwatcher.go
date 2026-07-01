package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// MatchWatcher implements the cold-start "only after a human waits ~20s" gate.
// It polls a match pool for tickets, and when a human's ticket has been queued
// longer than the threshold, it triggers the bot (which then queues and gets
// paired). The bot itself is NOT always in the queue, so two real humans still
// match each other during the wait window.
//
// It reuses the service's client-credentials flow; the service's IAM client must
// have ADMIN:NAMESPACE:{ns}:MATCHMAKING:POOL:TICKETS (Read).
type MatchWatcher struct {
	pool        string
	botUserID   string
	waitSeconds int
	pollSeconds int
	triggerURL  string
	triggered   map[string]time.Time // ticketID -> when we triggered (dedupe)
	loggedRaw   bool
}

// NewMatchWatcherFromEnv builds the watcher when MATCH_WATCHER_ENABLED=true and a
// BOT_TRIGGER_URL is set. Env:
//
//	MATCH_WATCHER_ENABLED=true
//	MATCH_POOL=chess-quickmatch
//	BOT_USER_ID=<the bot's AGS user id>   (so the bot's own ticket is ignored)
//	BOT_WAIT_SECONDS=20
//	MATCH_WATCHER_POLL_SECONDS=3
//	BOT_TRIGGER_URL=http://localhost:8091/trigger
func NewMatchWatcherFromEnv() (*MatchWatcher, bool) {
	if !strings.EqualFold(os.Getenv("MATCH_WATCHER_ENABLED"), "true") {
		return nil, false
	}
	w := &MatchWatcher{
		pool:        mwEnvOr("MATCH_POOL", "chess-quickmatch"),
		botUserID:   os.Getenv("BOT_USER_ID"),
		waitSeconds: mwEnvInt("BOT_WAIT_SECONDS", 20),
		pollSeconds: mwEnvInt("MATCH_WATCHER_POLL_SECONDS", 3),
		triggerURL:  os.Getenv("BOT_TRIGGER_URL"),
		triggered:   map[string]time.Time{},
	}
	if w.triggerURL == "" {
		log.Printf("match-watcher: disabled (BOT_TRIGGER_URL not set)")
		return nil, false
	}
	return w, true
}

func (w *MatchWatcher) Start(ctx context.Context) {
	log.Printf("match-watcher: watching pool=%q wait=%ds poll=%ds trigger=%s botUser=%s",
		w.pool, w.waitSeconds, w.pollSeconds, w.triggerURL, w.botUserID)
	t := time.NewTicker(time.Duration(w.pollSeconds) * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := w.poll(); err != nil {
				log.Printf("match-watcher: poll error: %v", err)
			}
		}
	}
}

// poolTicket parses the fields we need from a pool ticket, tolerant to the exact
// shape (confirmed/adjusted from the first raw response the watcher logs).
type poolTicket struct {
	MatchTicketID   string    `json:"matchTicketID"`
	TicketID        string    `json:"ticketID"`
	ID              string    `json:"id"`
	CreatedAt       time.Time `json:"createdAt"`
	UserID          string    `json:"userID"`
	Namespace       string    `json:"namespace"`
	ProposedTickets []struct {
		UserID string `json:"userID"`
	} `json:"proposedTickets"`
	Parties []struct {
		UserIDs      []string `json:"userIDs"`
		PartyMembers []struct {
			UserID string `json:"userID"`
		} `json:"partyMembers"`
	} `json:"parties"`
}

func (t poolTicket) id() string {
	switch {
	case t.MatchTicketID != "":
		return t.MatchTicketID
	case t.TicketID != "":
		return t.TicketID
	default:
		return t.ID
	}
}

func (t poolTicket) userIDs() []string {
	var ids []string
	if t.UserID != "" {
		ids = append(ids, t.UserID)
	}
	for _, p := range t.ProposedTickets {
		if p.UserID != "" {
			ids = append(ids, p.UserID)
		}
	}
	for _, party := range t.Parties {
		ids = append(ids, party.UserIDs...)
		for _, m := range party.PartyMembers {
			if m.UserID != "" {
				ids = append(ids, m.UserID)
			}
		}
	}
	return ids
}

func (w *MatchWatcher) poll() error {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return err
	}
	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return fmt.Errorf("token: %w", err)
	}

	reqURL := fmt.Sprintf("%s/match2/v1/namespaces/%s/match-pools/%s/tickets", baseURL, namespace, w.pool)
	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("pool tickets returned %d: %s", resp.StatusCode, mwTruncate(string(body), 300))
	}
	if !w.loggedRaw {
		w.loggedRaw = true
		log.Printf("match-watcher: first raw pool response: %s", mwTruncate(string(body), 900))
	}

	var parsed struct {
		Data    []poolTicket `json:"data"`
		Tickets []poolTicket `json:"tickets"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("parse tickets: %w", err)
	}
	tickets := parsed.Data
	if len(tickets) == 0 {
		tickets = parsed.Tickets
	}

	now := time.Now()
	active := map[string]bool{}
	for _, t := range tickets {
		id := t.id()
		if id == "" {
			continue
		}
		active[id] = true
		if w.isBotTicket(t) || t.CreatedAt.IsZero() {
			continue
		}
		if now.Sub(t.CreatedAt) >= time.Duration(w.waitSeconds)*time.Second {
			if _, already := w.triggered[id]; !already {
				log.Printf("match-watcher: human ticket %s waited %.0fs → triggering bot",
					id, now.Sub(t.CreatedAt).Seconds())
				w.trigger()
				w.triggered[id] = now
			}
		}
	}
	for id := range w.triggered {
		if !active[id] {
			delete(w.triggered, id)
		}
	}
	return nil
}

func (w *MatchWatcher) isBotTicket(t poolTicket) bool {
	if w.botUserID == "" {
		return false
	}
	for _, id := range t.userIDs() {
		if id == w.botUserID {
			return true
		}
	}
	return false
}

func (w *MatchWatcher) trigger() {
	go func() {
		req, err := http.NewRequest(http.MethodPost, w.triggerURL, bytes.NewReader([]byte(`{}`)))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := outboundHTTPClient.Do(req)
		if err != nil {
			log.Printf("match-watcher: trigger POST failed: %v", err)
			return
		}
		_ = resp.Body.Close()
	}()
}

func mwEnvOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func mwEnvInt(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func mwTruncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

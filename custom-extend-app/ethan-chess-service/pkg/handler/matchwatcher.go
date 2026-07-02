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
	"sync"
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
	pool             string
	botUserID        string
	waitSeconds      int
	pollSeconds      int
	retriggerSeconds int
	triggerURL       string
	triggered        map[string]time.Time // ticketID -> last time we triggered
	loggedRaw        bool

	// AMS claim mode (piece #4): instead of POSTing a fixed localhost trigger,
	// claim a bot DS from an AMS fleet by claim keys and POST /trigger to the
	// claimed server's public ip:port.
	amsClaimEnabled bool
	amsBase         string   // AMS/fleet-commander base URL (default: agsConfig base)
	amsFleetID      string   // when set, claim by fleet ID (reliable) instead of by keys
	amsClaimKeys    []string // fleet claim keys, in preference order (claim-by-keys fallback)
	amsRegion       string   // region (REQUIRED for claim-by-fleet-ID)
	amsPortName     string   // named port (from the fleet) that exposes /trigger
	amsClaimRetryS  int      // how long to retry claim on 404 (dev fleets launch on demand)
	triggerSecret   string   // optional shared secret sent as x-trigger-secret
	loggedClaimRaw  bool

	// dbg holds recent activity for the /debug/watcher endpoint.
	dbgMu  sync.Mutex
	dbg    map[string]any
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
		pool:             mwEnvOr("MATCH_POOL", "chess-quickmatch"),
		botUserID:        os.Getenv("BOT_USER_ID"),
		waitSeconds:      mwEnvInt("BOT_WAIT_SECONDS", 20),
		pollSeconds:      mwEnvInt("MATCH_WATCHER_POLL_SECONDS", 3),
		retriggerSeconds: mwEnvInt("MATCH_WATCHER_RETRIGGER_SECONDS", 30),
		triggerURL:       os.Getenv("BOT_TRIGGER_URL"),
		triggered:        map[string]time.Time{},

		amsClaimEnabled: strings.EqualFold(os.Getenv("AMS_CLAIM_ENABLED"), "true"),
		amsBase:         strings.TrimRight(os.Getenv("AMS_BASE_URL"), "/"),
		amsFleetID:      os.Getenv("AMS_FLEET_ID"),
		amsClaimKeys:    mwEnvList("AMS_CLAIM_KEYS"),
		amsRegion:       os.Getenv("AMS_REGION"),
		amsPortName:     mwEnvOr("AMS_TRIGGER_PORT_NAME", "trigger"),
		amsClaimRetryS:  mwEnvInt("AMS_CLAIM_RETRY_SECONDS", 20),
		triggerSecret:   os.Getenv("BOT_TRIGGER_SECRET"),
	}
	if w.amsClaimEnabled {
		if len(w.amsClaimKeys) == 0 && w.amsFleetID == "" {
			log.Printf("match-watcher: disabled (AMS_CLAIM_ENABLED but neither AMS_CLAIM_KEYS nor AMS_FLEET_ID set)")
			return nil, false
		}
		if len(w.amsClaimKeys) == 0 && w.amsRegion == "" {
			log.Printf("match-watcher: disabled (claim-by-fleet-ID requires AMS_REGION)")
			return nil, false
		}
	} else if w.triggerURL == "" {
		log.Printf("match-watcher: disabled (set BOT_TRIGGER_URL, or AMS_CLAIM_ENABLED + AMS_CLAIM_KEYS)")
		return nil, false
	}
	return w, true
}

func (w *MatchWatcher) Start(ctx context.Context) {
	dst := w.triggerURL
	if w.amsClaimEnabled {
		if len(w.amsClaimKeys) > 0 {
			dst = fmt.Sprintf("AMS claim keys=%v port=%q region=%q", w.amsClaimKeys, w.amsPortName, w.amsRegion)
		} else {
			dst = fmt.Sprintf("AMS claim fleet=%s port=%q region=%q", w.amsFleetID, w.amsPortName, w.amsRegion)
		}
	}
	log.Printf("match-watcher: watching pool=%q wait=%ds poll=%ds retrigger=%ds trigger=[%s] botUser=%s",
		w.pool, w.waitSeconds, w.pollSeconds, w.retriggerSeconds, dst, w.botUserID)
	t := time.NewTicker(time.Duration(w.pollSeconds) * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := w.poll(); err != nil {
				log.Printf("match-watcher: poll error: %v", err)
				w.dbgSet(map[string]any{"lastPollAt": time.Now().Format(time.RFC3339), "lastPollError": err.Error()})
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
	humanCount, botCount := 0, 0
	var maxHumanWait float64
	for _, t := range tickets {
		id := t.id()
		if id == "" {
			continue
		}
		active[id] = true
		if w.isBotTicket(t) {
			botCount++
			continue
		}
		if t.CreatedAt.IsZero() {
			continue
		}
		humanCount++
		if wait := now.Sub(t.CreatedAt).Seconds(); wait > maxHumanWait {
			maxHumanWait = wait
		}
		if now.Sub(t.CreatedAt) >= time.Duration(w.waitSeconds)*time.Second {
			// Re-trigger a still-waiting human after a cooldown, in case the bot's
			// first ticket lost the race to pair with them (they'd otherwise be
			// stuck). A spurious re-trigger is harmless: the bot's ticket self-
			// cancels at 10s when there's no one to match.
			last, seen := w.triggered[id]
			if !seen || now.Sub(last) >= time.Duration(w.retriggerSeconds)*time.Second {
				log.Printf("match-watcher: human ticket %s waited %.0fs → triggering bot%s",
					id, now.Sub(t.CreatedAt).Seconds(), map[bool]string{true: " (retry)"}[seen])
				w.dbgSet(map[string]any{"lastTriggerAt": now.Format(time.RFC3339), "lastTriggerTicket": id, "lastTriggerWaitS": now.Sub(t.CreatedAt).Seconds()})
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
	w.dbgSet(map[string]any{
		"lastPollAt": now.Format(time.RFC3339), "pollHTTP": resp.StatusCode,
		"ticketCount": len(tickets), "humanTickets": humanCount, "botTickets": botCount,
		"maxHumanWaitS": maxHumanWait, "poolRawSample": mwTruncate(string(body), 500),
	})
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
		url := w.triggerURL
		if w.amsClaimEnabled {
			addr, err := w.claimServer()
			if err != nil {
				log.Printf("match-watcher: AMS claim failed: %v", err)
				w.dbgSet(map[string]any{"lastClaimAt": time.Now().Format(time.RFC3339), "lastClaimError": err.Error()})
				return
			}
			url = "http://" + addr + "/trigger"
			log.Printf("match-watcher: claimed bot DS at %s", addr)
			w.dbgSet(map[string]any{"lastClaimAt": time.Now().Format(time.RFC3339), "lastClaimAddr": addr})
		}
		w.postTrigger(url)
	}()
}

func (w *MatchWatcher) postTrigger(url string) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte(`{}`)))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if w.triggerSecret != "" {
		req.Header.Set("x-trigger-secret", w.triggerSecret)
	}
	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		log.Printf("match-watcher: trigger POST %s failed: %v", url, err)
		w.dbgSet(map[string]any{"lastTriggerPostAt": time.Now().Format(time.RFC3339), "lastTriggerPostError": err.Error(), "lastTriggerPostURL": url})
		return
	}
	defer resp.Body.Close()
	w.dbgSet(map[string]any{"lastTriggerPostAt": time.Now().Format(time.RFC3339), "lastTriggerPostHTTP": resp.StatusCode, "lastTriggerPostURL": url})
}

// dbgSet merges keys into the debug activity map (for /debug/watcher).
func (w *MatchWatcher) dbgSet(kv map[string]any) {
	w.dbgMu.Lock()
	defer w.dbgMu.Unlock()
	if w.dbg == nil {
		w.dbg = map[string]any{}
	}
	for k, v := range kv {
		w.dbg[k] = v
	}
}

// DebugHandler returns an HTTP handler exposing the watcher's config + recent
// activity as JSON, gated by ?key=<secret> (if secret is non-empty).
func (w *MatchWatcher) DebugHandler(secret string) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		if secret != "" && r.URL.Query().Get("key") != secret {
			rw.WriteHeader(http.StatusForbidden)
			return
		}
		w.dbgMu.Lock()
		activity := map[string]any{}
		for k, v := range w.dbg {
			activity[k] = v
		}
		w.dbgMu.Unlock()
		out := map[string]any{
			"now": time.Now().Format(time.RFC3339),
			"config": map[string]any{
				"pool": w.pool, "waitSeconds": w.waitSeconds, "pollSeconds": w.pollSeconds,
				"botUserID": w.botUserID, "amsClaimEnabled": w.amsClaimEnabled,
				"amsFleetID": w.amsFleetID, "amsClaimKeys": w.amsClaimKeys,
				"amsRegion": w.amsRegion, "amsPortName": w.amsPortName, "amsBase": w.amsBase,
				"triggerURL": w.triggerURL, "hasTriggerSecret": w.triggerSecret != "",
			},
			"activity": activity,
		}
		rw.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(rw).Encode(out)
	}
}

// claimServer claims a bot DS from an AMS fleet by claim keys and returns the
// claimed server's public "ip:port" for the named trigger port. Uses the service
// client-credentials token; the client needs NAMESPACE:{ns}:AMS:SERVER:CLAIM
// [UPDATE]. (fleet-commander PUT /ams/v1/namespaces/{ns}/servers/claim)
//
// A development fleet launches a DS on demand and returns 404 until it's ready
// (up to ~8s); the endpoint is meant to be retried. So we poll the claim for up
// to amsClaimRetryS seconds before giving up.
func (w *MatchWatcher) claimServer() (string, error) {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return "", err
	}
	amsBase := w.amsBase
	if amsBase == "" {
		amsBase = baseURL
	}
	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return "", fmt.Errorf("token: %w", err)
	}

	deadline := time.Now().Add(time.Duration(w.amsClaimRetryS) * time.Second)
	for attempt := 1; ; attempt++ {
		addr, notReady, err := w.claimOnce(amsBase, namespace, token)
		if err != nil {
			return "", err
		}
		if !notReady {
			return addr, nil
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("no bot DS available after %ds (404) — fleet did not become ready", w.amsClaimRetryS)
		}
		log.Printf("match-watcher: claim attempt %d got 404 (DS launching) — retrying", attempt)
		time.Sleep(2 * time.Second)
	}
}

// claimOnce makes a single claim call. notReady=true means HTTP 404 (a dev fleet
// is still launching a DS) and the caller should retry.
func (w *MatchWatcher) claimOnce(amsBase, namespace, token string) (addr string, notReady bool, err error) {
	// A unique association id for the claim; the bot plays over PeerJS, so this
	// need not map to an AGS session — it just identifies the claim.
	sessionID := fmt.Sprintf("chessbot-%d", time.Now().UnixNano())

	var reqURL string
	var reqBody map[string]any
	if len(w.amsClaimKeys) > 0 {
		// Claim by claim keys (preferred): fleet IDs change on every image rollout,
		// so the watcher must not depend on them. Servers are indexed under the
		// fleet's claim keys at launch. fleet-commander expects camelCase.
		reqURL = fmt.Sprintf("%s/ams/v1/namespaces/%s/servers/claim", amsBase, namespace)
		reqBody = map[string]any{"claimKeys": w.amsClaimKeys, "sessionId": sessionID}
		if w.amsRegion != "" {
			reqBody["region"] = w.amsRegion
		}
	} else {
		// Legacy override: claim a specific fleet by ID (region REQUIRED).
		reqURL = fmt.Sprintf("%s/ams/v1/namespaces/%s/fleets/%s/claim", amsBase, namespace, w.amsFleetID)
		reqBody = map[string]any{"region": w.amsRegion, "sessionId": sessionID}
	}
	payload, _ := json.Marshal(reqBody)

	req, err := http.NewRequest(http.MethodPut, reqURL, bytes.NewReader(payload))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound {
		return "", true, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("claim returned %d: %s", resp.StatusCode, mwTruncate(string(body), 300))
	}
	if !w.loggedClaimRaw {
		w.loggedClaimRaw = true
		log.Printf("match-watcher: first raw claim response: %s", mwTruncate(string(body), 900))
	}

	ip, port := parseClaim(body, w.amsPortName)
	if ip == "" || port == 0 {
		return "", false, fmt.Errorf("claim response missing ip/port %q: %s", w.amsPortName, mwTruncate(string(body), 300))
	}
	return fmt.Sprintf("%s:%d", ip, port), false, nil
}

// claimResp captures the fields we need from the claim response, tolerant to a
// flat or server-nested shape (confirmed/adjusted from the first raw response).
type claimResp struct {
	IP     string         `json:"ip"`
	Ports  map[string]int `json:"ports"`
	Server *struct {
		IP    string         `json:"ip"`
		Ports map[string]int `json:"ports"`
	} `json:"server"`
}

// parseClaim pulls the public ip and the named trigger port from a claim body.
// If the named port isn't present but exactly one port is, it uses that one.
func parseClaim(body []byte, portName string) (string, int) {
	var c claimResp
	if json.Unmarshal(body, &c) != nil {
		return "", 0
	}
	ip, ports := c.IP, c.Ports
	if ip == "" && c.Server != nil {
		ip, ports = c.Server.IP, c.Server.Ports
	}
	if ip == "" || len(ports) == 0 {
		return ip, 0
	}
	if p, ok := ports[portName]; ok {
		return ip, p
	}
	if len(ports) == 1 {
		for _, p := range ports {
			return ip, p
		}
	}
	return ip, 0
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

// mwEnvList parses a comma-separated env var into a trimmed, non-empty slice.
func mwEnvList(key string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func mwTruncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

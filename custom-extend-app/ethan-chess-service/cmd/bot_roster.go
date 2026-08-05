package main

// The roster of bot personalities this deployment hosts.
//
// Every bot is an equal member. The "default" is only the one an unqualified
// request resolves to — not a privileged bot the others hang off. Adding a
// personality is a config change (BOT_PERSONAS plus a bots/<id>/ directory),
// never a code change.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// botEntry is one hostable personality: where its persona files live and which
// AGS account it plays as.
type botEntry struct {
	id     string
	dir    string
	userID string
}

type botRoster struct {
	defaultID string
	entries   []*botEntry // registration order, default first
	byID      map[string]*botEntry
}

// newBotRosterFromEnv builds the roster from:
//
//	BOT_ID       — the default personality (default "gambit-gus")
//	BOT_PERSONAS — comma-separated ids the AMS bot DS may wake up as
//	BOTS_DIR     — parent of the per-personality directories (default "bots")
//	BOT_DIR      — overrides the DEFAULT bot's directory only
//
// An empty BOT_PERSONAS means the default bot is the whole roster. The default
// is always a member even if BOT_PERSONAS omits it: it is what an unqualified
// request falls back to, so it must resolve.
func newBotRosterFromEnv() *botRoster {
	defaultID := strings.TrimSpace(os.Getenv("BOT_ID"))
	if defaultID == "" {
		defaultID = "gambit-gus"
	}
	botsDir := strings.TrimSpace(os.Getenv("BOTS_DIR"))
	if botsDir == "" {
		botsDir = "bots"
	}
	defaultDir := strings.TrimSpace(os.Getenv("BOT_DIR"))
	if defaultDir == "" {
		defaultDir = filepath.Join(botsDir, defaultID)
	}

	ids := []string{defaultID}
	for _, id := range strings.Split(os.Getenv("BOT_PERSONAS"), ",") {
		if id = strings.TrimSpace(id); id != "" && id != defaultID {
			ids = append(ids, id)
		}
	}

	r := &botRoster{defaultID: defaultID, byID: make(map[string]*botEntry, len(ids))}
	for _, id := range ids {
		if _, dup := r.byID[id]; dup {
			continue
		}
		dir := filepath.Join(botsDir, id)
		if id == defaultID {
			dir = defaultDir
		}
		entry := &botEntry{id: id, dir: dir, userID: botUserIDFor(id, defaultID)}
		r.entries = append(r.entries, entry)
		r.byID[id] = entry
	}
	return r
}

// botUserIDFor resolves the AGS account a personality plays as.
//
//	BOT_ACCOUNTS={"gambit-gus":"<userId>","fortress-fiona":"<userId>"}
//
// BOT_USER_ID remains the default bot's account when BOT_ACCOUNTS omits it, so
// a rollback to the single-account setup is a config-only revert.
//
// Each bot having its own account is what lets two bot games run at once, and
// what keeps a bot's games out of another bot's match history.
func botUserIDFor(botID, defaultID string) string {
	if raw := strings.TrimSpace(os.Getenv("BOT_ACCOUNTS")); raw != "" {
		var accounts map[string]string
		if err := json.Unmarshal([]byte(raw), &accounts); err != nil {
			log.Printf("[bot-roster] BOT_ACCOUNTS is not valid JSON (%v) — falling back to BOT_USER_ID", err)
		} else if id := strings.TrimSpace(accounts[botID]); id != "" {
			return id
		}
	}
	if botID == defaultID {
		return strings.TrimSpace(os.Getenv("BOT_USER_ID"))
	}
	return ""
}

// ids returns the hosted personality ids in registration order.
func (r *botRoster) ids() []string {
	out := make([]string, 0, len(r.entries))
	for _, e := range r.entries {
		out = append(out, e.id)
	}
	return out
}

// resolve maps a requested bot id to its entry. An empty request means "the
// default"; an unknown one is reported as such rather than silently defaulted,
// so a typo surfaces instead of quietly serving the wrong bot.
func (r *botRoster) resolve(requested string) (*botEntry, bool) {
	if requested = strings.TrimSpace(requested); requested == "" {
		requested = r.defaultID
	}
	entry, ok := r.byID[requested]
	return entry, ok
}

// hosts reports whether the AMS bot DS can wake up as this personality.
func (r *botRoster) hosts(id string) bool {
	_, ok := r.byID[strings.TrimSpace(id)]
	return ok
}

// userIDs is the set of AGS accounts the bots play as, for the callers that ask
// "is this user one of ours?" — the match watcher's own-ticket filter and the
// high-five recipient check. Bots without a configured account are omitted.
func (r *botRoster) userIDs() []string {
	out := make([]string, 0, len(r.entries))
	for _, e := range r.entries {
		if e.userID != "" {
			out = append(out, e.userID)
		}
	}
	return out
}

package main

// The roster of bot personalities this deployment hosts.
//
// Every bot is an equal member. The "default" is only the one an unqualified
// request resolves to — not a privileged bot the others hang off. Adding a
// personality is a config change (BOT_PERSONAS plus a bots/<id>/ directory),
// never a code change.

import (
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
		entry := &botEntry{id: id, dir: dir, userID: botUserIDFor(id)}
		r.entries = append(r.entries, entry)
		r.byID[id] = entry
	}
	return r
}

// botUserIDFor resolves the AGS account a personality plays as. Every bot
// currently shares the one BOT_USER_ID account; per-bot accounts land next.
func botUserIDFor(_ string) string {
	return strings.TrimSpace(os.Getenv("BOT_USER_ID"))
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

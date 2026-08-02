package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	defaultBotID   = "gambit-gus"
	defaultBotsDir = "bots"
)

var (
	botIDPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	signalKeyPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)
	matchPoolPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
)

// botPersona is one personality this bot-ds can host: where its brain lives, the
// AGS match pool whose sessions belong to it, and the session-storage key its
// browser client signals through.
type botPersona struct {
	ID        string
	Dir       string
	SignalKey string
	MatchPool string
}

// botRoster is every personality a single DS instance can host. AMS claims a DS
// without knowing which personality the session wants, so the instance hosts all
// of them and picks per claim from the session's match pool. DefaultID names the
// personality used for local serve mode and as the fallback for a claimed
// session whose pool isn't in the roster.
type botRoster struct {
	Personas  []botPersona
	DefaultID string
}

func (r botRoster) byID(id string) (botPersona, bool) {
	for _, persona := range r.Personas {
		if persona.ID == id {
			return persona, true
		}
	}
	return botPersona{}, false
}

// forMatchPool resolves the personality that owns an AGS match pool.
func (r botRoster) forMatchPool(pool string) (botPersona, bool) {
	pool = strings.TrimSpace(pool)
	if pool == "" {
		return botPersona{}, false
	}
	for _, persona := range r.Personas {
		if persona.MatchPool == pool {
			return persona, true
		}
	}
	return botPersona{}, false
}

func (r botRoster) defaultPersona() botPersona {
	persona, _ := r.byID(r.DefaultID)
	return persona
}

// resolveBotRoster builds the hostable personality set. discovered holds the
// personality directory names found under the bots root — every one becomes
// hostable, which is what lets one AMS fleet answer for every bot match pool.
// The flags and environment only choose the default personality; they no longer
// restrict what the instance can serve.
func resolveBotRoster(root string, discovered []string, flagID, flagDir, flagSignalKey string, getenv func(string) string) (botRoster, error) {
	if root = strings.TrimSpace(root); root == "" {
		root = defaultBotsDir
	}
	flagID = strings.TrimSpace(flagID)
	flagDir = strings.TrimSpace(flagDir)

	var id, dir string
	switch {
	case flagID != "" || flagDir != "":
		// Any command-line personality selector forms one coherent override of
		// BOT_ID/BOT_DIR. This lets `--bot-id fortress-fiona` work even when a
		// developer's .env still contains the default Gus directory.
		id, dir = flagID, flagDir
		if id == "" {
			id = filepath.Base(filepath.Clean(dir))
		}
	case firstNonEmpty(getenv("BOT_ID"), getenv("BOT_DIR")) != "":
		id = firstNonEmpty(getenv("BOT_ID"))
		dir = firstNonEmpty(getenv("BOT_DIR"))
		if id == "" {
			id = filepath.Base(filepath.Clean(dir))
		}
	}
	if id == "" {
		id = defaultBotID
	}
	if !botIDPattern.MatchString(id) {
		return botRoster{}, fmt.Errorf("invalid bot id %q: use lowercase letters, numbers, and hyphens", id)
	}

	if dir == "" {
		dir = filepath.Join(root, id)
	}

	signalKey := firstNonEmpty(flagSignalKey, getenv("BOT_SIGNAL_KEY"))
	if signalKey == "" {
		signalKey = defaultSignalKey(id)
	}
	if !signalKeyPattern.MatchString(signalKey) {
		return botRoster{}, fmt.Errorf("invalid bot signal key %q", signalKey)
	}

	// The default personality is hostable even when its directory sits outside
	// the bots root (a developer pointing --bot-dir at a scratch copy).
	personas := []botPersona{{ID: id, Dir: dir, SignalKey: signalKey, MatchPool: defaultMatchPool(id)}}
	for _, name := range discovered {
		name = strings.TrimSpace(name)
		if name == "" || name == id {
			continue
		}
		if !botIDPattern.MatchString(name) {
			return botRoster{}, fmt.Errorf("invalid bot directory name %q under %s", name, root)
		}
		personas = append(personas, botPersona{
			ID:        name,
			Dir:       filepath.Join(root, name),
			SignalKey: defaultSignalKey(name),
			MatchPool: defaultMatchPool(name),
		})
	}

	if err := applyMatchPoolOverrides(personas, getenv("BOT_MATCH_POOLS")); err != nil {
		return botRoster{}, err
	}

	// Deterministic order keeps startup logs stable and makes lookups
	// order-independent; the default is tracked by ID, not by position.
	sort.Slice(personas, func(a, b int) bool { return personas[a].ID < personas[b].ID })

	if err := validateRosterRouting(personas); err != nil {
		return botRoster{}, err
	}
	return botRoster{Personas: personas, DefaultID: id}, nil
}

// applyMatchPoolOverrides reads BOT_MATCH_POOLS ("gambit-gus=chess-quickmatch,
// fortress-fiona=fiona-pool"). AGS pool names live in backend configuration, so
// a pool rename can be followed without rebuilding the artifact.
func applyMatchPoolOverrides(personas []botPersona, spec string) error {
	for _, pair := range strings.Split(spec, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		id, pool, ok := strings.Cut(pair, "=")
		id, pool = strings.TrimSpace(id), strings.TrimSpace(pool)
		if !ok || id == "" || pool == "" {
			return fmt.Errorf("invalid BOT_MATCH_POOLS entry %q: want <bot-id>=<match-pool>", pair)
		}
		if !matchPoolPattern.MatchString(pool) {
			return fmt.Errorf("invalid match pool %q for bot %q", pool, id)
		}
		found := false
		for i := range personas {
			if personas[i].ID == id {
				personas[i].MatchPool, found = pool, true
				break
			}
		}
		if !found {
			return fmt.Errorf("BOT_MATCH_POOLS names unknown bot %q", id)
		}
	}
	return nil
}

// validateRosterRouting rejects a roster that couldn't route a claim
// unambiguously — two personalities sharing a pool, or sharing the storage key
// they answer on, would make the served personality depend on iteration order.
func validateRosterRouting(personas []botPersona) error {
	pools, keys := map[string]string{}, map[string]string{}
	for _, persona := range personas {
		if other, clash := pools[persona.MatchPool]; clash {
			return fmt.Errorf("bots %q and %q both claim match pool %q", other, persona.ID, persona.MatchPool)
		}
		pools[persona.MatchPool] = persona.ID
		if other, clash := keys[persona.SignalKey]; clash {
			return fmt.Errorf("bots %q and %q both use signal key %q", other, persona.ID, persona.SignalKey)
		}
		keys[persona.SignalKey] = persona.ID
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

// defaultMatchPool maps a personality to the AGS pool whose sessions it serves.
// Gus predates the per-bot pools and keeps the original shared quickmatch pool;
// every later personality gets a pool named after itself.
func defaultMatchPool(botID string) string {
	if botID == defaultBotID {
		return "chess-quickmatch"
	}
	return botID
}

func defaultSignalKey(botID string) string {
	// Preserve the keys already used by the existing browser clients.
	switch botID {
	case "gambit-gus":
		return "gusSignal"
	case "fortress-fiona":
		return "fionaSignal"
	}

	parts := strings.Split(botID, "-")
	var key strings.Builder
	for i, part := range parts {
		if part == "" {
			continue
		}
		if i == 0 {
			key.WriteString(part)
			continue
		}
		key.WriteString(strings.ToUpper(part[:1]))
		key.WriteString(part[1:])
	}
	key.WriteString("Signal")
	return key.String()
}

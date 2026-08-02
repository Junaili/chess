package main

import (
	"path/filepath"
	"testing"
)

// bothBots mirrors what the AMS artifact stages: every personality is present on
// disk, so any DS instance can host any of them.
var bothBots = []string{"fortress-fiona", "gambit-gus"}

func noEnv(string) string { return "" }

func envFunc(env map[string]string) func(string) string {
	return func(key string) string { return env[key] }
}

func mustResolve(t *testing.T, discovered []string, flagID, flagDir, flagSignalKey string, getenv func(string) string) botRoster {
	t.Helper()
	roster, err := resolveBotRoster("bots", discovered, flagID, flagDir, flagSignalKey, getenv)
	if err != nil {
		t.Fatalf("resolve roster: %v", err)
	}
	return roster
}

func personaByID(t *testing.T, roster botRoster, id string) botPersona {
	t.Helper()
	persona, ok := roster.byID(id)
	if !ok {
		t.Fatalf("roster has no bot %q (personas %+v)", id, roster.Personas)
	}
	return persona
}

func TestResolveBotRosterHostsEveryDiscoveredPersonality(t *testing.T) {
	roster := mustResolve(t, bothBots, "", "", "", noEnv)

	if roster.DefaultID != "gambit-gus" {
		t.Fatalf("default = %q", roster.DefaultID)
	}
	if len(roster.Personas) != 2 {
		t.Fatalf("personas = %+v", roster.Personas)
	}

	gus := personaByID(t, roster, "gambit-gus")
	if gus.Dir != filepath.Join("bots", "gambit-gus") || gus.SignalKey != "gusSignal" || gus.MatchPool != "chess-quickmatch" {
		t.Fatalf("gus = %#v", gus)
	}
	fiona := personaByID(t, roster, "fortress-fiona")
	if fiona.Dir != filepath.Join("bots", "fortress-fiona") || fiona.SignalKey != "fionaSignal" || fiona.MatchPool != "fortress-fiona" {
		t.Fatalf("fiona = %#v", fiona)
	}
}

// The routing that lets one fleet serve both personalities.
func TestRosterRoutesClaimedSessionByMatchPool(t *testing.T) {
	roster := mustResolve(t, bothBots, "", "", "", noEnv)

	for pool, wantID := range map[string]string{
		"chess-quickmatch": "gambit-gus",
		"fortress-fiona":   "fortress-fiona",
	} {
		persona, ok := roster.forMatchPool(pool)
		if !ok {
			t.Fatalf("pool %q matched no bot", pool)
		}
		if persona.ID != wantID {
			t.Fatalf("pool %q -> %q, want %q", pool, persona.ID, wantID)
		}
	}
}

func TestRosterFallsBackForUnknownOrMissingMatchPool(t *testing.T) {
	roster := mustResolve(t, bothBots, "", "", "", noEnv)

	for _, pool := range []string{"", "   ", "chess-ranked"} {
		if _, ok := roster.forMatchPool(pool); ok {
			t.Fatalf("pool %q unexpectedly matched a bot", pool)
		}
	}
	if got := roster.defaultPersona(); got.ID != "gambit-gus" {
		t.Fatalf("default persona = %#v", got)
	}
}

// Selecting a default must not narrow what the instance can host — the Fiona
// fleet and the Gus fleet run the same artifact.
func TestResolveBotRosterDefaultSelectionKeepsEveryPersonalityHostable(t *testing.T) {
	roster := mustResolve(t, bothBots, "fortress-fiona", "", "", noEnv)

	if roster.DefaultID != "fortress-fiona" {
		t.Fatalf("default = %q", roster.DefaultID)
	}
	if len(roster.Personas) != 2 {
		t.Fatalf("personas = %+v", roster.Personas)
	}
	if persona, ok := roster.forMatchPool("chess-quickmatch"); !ok || persona.ID != "gambit-gus" {
		t.Fatalf("gus unreachable after selecting fiona as default: %#v %v", persona, ok)
	}
}

func TestResolveBotRosterPreservesBotDirCompatibility(t *testing.T) {
	env := envFunc(map[string]string{"BOT_ID": "gambit-gus", "BOT_DIR": "bots/gambit-gus"})
	roster := mustResolve(t, bothBots, "", "bots/fortress-fiona", "", env)

	if roster.DefaultID != "fortress-fiona" {
		t.Fatalf("default = %q", roster.DefaultID)
	}
	if persona := personaByID(t, roster, "fortress-fiona"); persona.SignalKey != "fionaSignal" {
		t.Fatalf("persona = %#v", persona)
	}
}

func TestResolveBotRosterBotIDOverridesEnvironmentDirectory(t *testing.T) {
	env := envFunc(map[string]string{"BOT_ID": "gambit-gus", "BOT_DIR": "bots/gambit-gus"})
	roster := mustResolve(t, bothBots, "fortress-fiona", "", "", env)

	if persona := personaByID(t, roster, "fortress-fiona"); persona.Dir != filepath.Join("bots", "fortress-fiona") {
		t.Fatalf("persona = %#v", persona)
	}
}

func TestResolveBotRosterFromEnvironment(t *testing.T) {
	env := envFunc(map[string]string{"BOT_ID": "fortress-fiona", "BOT_DIR": "bots/fortress-fiona"})
	roster := mustResolve(t, bothBots, "", "", "", env)

	persona := personaByID(t, roster, "fortress-fiona")
	if roster.DefaultID != "fortress-fiona" || persona.Dir != "bots/fortress-fiona" || persona.SignalKey != "fionaSignal" {
		t.Fatalf("roster = %+v", roster)
	}
}

// A developer pointing --bot-dir at a scratch copy still gets that personality
// hosted, even though the directory is outside the bots root.
func TestResolveBotRosterUsesEnvironmentAndCLIOverrides(t *testing.T) {
	env := envFunc(map[string]string{
		"BOT_ID":         "fortress-fiona",
		"BOT_DIR":        "/opt/bots/fiona",
		"BOT_SIGNAL_KEY": "environmentSignal",
	})
	roster := mustResolve(t, bothBots, "gambit-gus", "/opt/bots/gus", "commandSignal", env)

	persona := personaByID(t, roster, "gambit-gus")
	if roster.DefaultID != "gambit-gus" || persona.Dir != "/opt/bots/gus" || persona.SignalKey != "commandSignal" {
		t.Fatalf("persona = %#v", persona)
	}
	// The override applies to the default only; the other personality keeps its
	// own key so its browser client still finds an answer.
	if persona := personaByID(t, roster, "fortress-fiona"); persona.SignalKey != "fionaSignal" {
		t.Fatalf("fiona = %#v", persona)
	}
}

func TestResolveBotRosterAppliesMatchPoolOverrides(t *testing.T) {
	env := envFunc(map[string]string{"BOT_MATCH_POOLS": "fortress-fiona=fiona-quickmatch, gambit-gus=chess-quickmatch"})
	roster := mustResolve(t, bothBots, "", "", "", env)

	persona, ok := roster.forMatchPool("fiona-quickmatch")
	if !ok || persona.ID != "fortress-fiona" {
		t.Fatalf("renamed pool routed to %#v (ok=%v)", persona, ok)
	}
	if _, ok := roster.forMatchPool("fortress-fiona"); ok {
		t.Fatal("the old pool name should no longer route")
	}
}

func TestResolveBotRosterRejectsUnroutableConfigurations(t *testing.T) {
	tests := []struct {
		name       string
		discovered []string
		id         string
		signalKey  string
		env        map[string]string
	}{
		{name: "path traversal id", id: "../fiona"},
		{name: "uppercase id", id: "Fortress-Fiona"},
		{name: "unsafe signal key", id: "fortress-fiona", signalKey: "fiona signal"},
		{name: "unsafe discovered directory", discovered: []string{"../escape"}},
		{
			name:       "two bots claiming one pool",
			discovered: bothBots,
			env:        map[string]string{"BOT_MATCH_POOLS": "fortress-fiona=chess-quickmatch"},
		},
		{
			name:       "two bots sharing a signal key",
			discovered: bothBots,
			signalKey:  "fionaSignal",
		},
		{
			name:       "override names an unhosted bot",
			discovered: bothBots,
			env:        map[string]string{"BOT_MATCH_POOLS": "knight-nora=nora-pool"},
		},
		{
			name:       "malformed override",
			discovered: bothBots,
			env:        map[string]string{"BOT_MATCH_POOLS": "fortress-fiona"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := resolveBotRoster("bots", test.discovered, test.id, "", test.signalKey, envFunc(test.env))
			if err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestDefaultsForNewPersonality(t *testing.T) {
	if got := defaultSignalKey("knight-nora"); got != "knightNoraSignal" {
		t.Fatalf("signal key = %q", got)
	}
	// A new personality's pool is named after it; only Gus keeps the original
	// shared quickmatch pool.
	if got := defaultMatchPool("knight-nora"); got != "knight-nora" {
		t.Fatalf("match pool = %q", got)
	}
	if got := defaultMatchPool("gambit-gus"); got != "chess-quickmatch" {
		t.Fatalf("match pool = %q", got)
	}
}

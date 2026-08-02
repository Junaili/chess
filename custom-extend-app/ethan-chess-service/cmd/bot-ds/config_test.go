package main

import (
	"path/filepath"
	"testing"
)

func TestResolveBotRuntimeConfigDefaultsToGus(t *testing.T) {
	config, err := resolveBotRuntimeConfig("", "", "", func(string) string { return "" })
	if err != nil {
		t.Fatalf("resolve config: %v", err)
	}
	if config.ID != "gambit-gus" {
		t.Fatalf("id = %q", config.ID)
	}
	if config.Dir != filepath.Join("bots", "gambit-gus") {
		t.Fatalf("dir = %q", config.Dir)
	}
	if config.SignalKey != "gusSignal" {
		t.Fatalf("signal key = %q", config.SignalKey)
	}
}

func TestResolveBotRuntimeConfigSelectsFionaByID(t *testing.T) {
	config, err := resolveBotRuntimeConfig("fortress-fiona", "", "", func(string) string { return "" })
	if err != nil {
		t.Fatalf("resolve config: %v", err)
	}
	if config.ID != "fortress-fiona" {
		t.Fatalf("id = %q", config.ID)
	}
	if config.Dir != filepath.Join("bots", "fortress-fiona") {
		t.Fatalf("dir = %q", config.Dir)
	}
	if config.SignalKey != "fionaSignal" {
		t.Fatalf("signal key = %q", config.SignalKey)
	}
}

func TestResolveBotRuntimeConfigPreservesBotDirCompatibility(t *testing.T) {
	env := map[string]string{"BOT_ID": "gambit-gus", "BOT_DIR": "bots/gambit-gus"}
	config, err := resolveBotRuntimeConfig("", "bots/fortress-fiona", "", func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("resolve config: %v", err)
	}
	if config.ID != "fortress-fiona" || config.SignalKey != "fionaSignal" {
		t.Fatalf("config = %#v", config)
	}
}

func TestResolveBotRuntimeConfigBotIDOverridesEnvironmentDirectory(t *testing.T) {
	env := map[string]string{"BOT_ID": "gambit-gus", "BOT_DIR": "bots/gambit-gus"}
	config, err := resolveBotRuntimeConfig("fortress-fiona", "", "", func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("resolve config: %v", err)
	}
	if config.Dir != filepath.Join("bots", "fortress-fiona") {
		t.Fatalf("dir = %q", config.Dir)
	}
}

func TestResolveBotRuntimeConfigFromEnvironment(t *testing.T) {
	env := map[string]string{
		"BOT_ID":  "fortress-fiona",
		"BOT_DIR": "bots/fortress-fiona",
	}
	config, err := resolveBotRuntimeConfig("", "", "", func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("resolve config: %v", err)
	}
	if config.ID != "fortress-fiona" || config.Dir != filepath.Join("bots", "fortress-fiona") || config.SignalKey != "fionaSignal" {
		t.Fatalf("config = %#v", config)
	}
}

func TestResolveBotRuntimeConfigUsesEnvironmentAndCLIOverrides(t *testing.T) {
	env := map[string]string{
		"BOT_ID":         "fortress-fiona",
		"BOT_DIR":        "/opt/bots/fiona",
		"BOT_SIGNAL_KEY": "environmentSignal",
	}
	getenv := func(key string) string { return env[key] }

	config, err := resolveBotRuntimeConfig("gambit-gus", "/opt/bots/gus", "commandSignal", getenv)
	if err != nil {
		t.Fatalf("resolve config: %v", err)
	}
	if config.ID != "gambit-gus" || config.Dir != "/opt/bots/gus" || config.SignalKey != "commandSignal" {
		t.Fatalf("config = %#v", config)
	}
}

func TestResolveBotRuntimeConfigRejectsUnsafeValues(t *testing.T) {
	tests := []struct {
		name      string
		id        string
		signalKey string
	}{
		{name: "path traversal id", id: "../fiona"},
		{name: "uppercase id", id: "Fortress-Fiona"},
		{name: "unsafe signal key", id: "fortress-fiona", signalKey: "fiona signal"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := resolveBotRuntimeConfig(test.id, "", test.signalKey, func(string) string { return "" }); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestDefaultSignalKeyForNewPersonality(t *testing.T) {
	if got := defaultSignalKey("knight-nora"); got != "knightNoraSignal" {
		t.Fatalf("signal key = %q", got)
	}
}

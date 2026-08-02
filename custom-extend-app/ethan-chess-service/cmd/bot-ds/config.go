package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

const defaultBotID = "gambit-gus"

var (
	botIDPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	signalKeyPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)
)

// botRuntimeConfig identifies the single personality hosted by this bot-ds
// process. The binary and AMS artifact can contain many personalities; each DS
// instance selects one at startup.
type botRuntimeConfig struct {
	ID        string
	Dir       string
	SignalKey string
}

func resolveBotRuntimeConfig(flagID, flagDir, flagSignalKey string, getenv func(string) string) (botRuntimeConfig, error) {
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
		return botRuntimeConfig{}, fmt.Errorf("invalid bot id %q: use lowercase letters, numbers, and hyphens", id)
	}
	if dir == "" {
		dir = filepath.Join("bots", id)
	}

	signalKey := firstNonEmpty(flagSignalKey, getenv("BOT_SIGNAL_KEY"))
	if signalKey == "" {
		signalKey = defaultSignalKey(id)
	}
	if !signalKeyPattern.MatchString(signalKey) {
		return botRuntimeConfig{}, fmt.Errorf("invalid bot signal key %q", signalKey)
	}

	return botRuntimeConfig{ID: id, Dir: dir, SignalKey: signalKey}, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
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

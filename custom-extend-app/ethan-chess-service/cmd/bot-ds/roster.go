package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// discoverPersonaDirs lists the personality directories staged under root. A
// directory counts only when it holds a persona.md, so anything else staged
// alongside the bots (self-play dumps, logs) never becomes a personality.
func discoverPersonaDirs(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		if _, err := os.Stat(filepath.Join(root, entry.Name(), "persona.md")); err != nil {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names, nil
}

// loadRoster reads every hostable personality's brain from disk. A personality
// that fails to load is fatal rather than skipped: a DS that came up hosting
// only part of its roster would answer the missing pools with the wrong bot.
func loadRoster(roster botRoster) (map[string]*botbrain.Bot, error) {
	bots := make(map[string]*botbrain.Bot, len(roster.Personas))
	for _, persona := range roster.Personas {
		bot, err := botbrain.LoadBot(persona.Dir)
		if err != nil {
			return nil, fmt.Errorf("load bot %q from %s: %w", persona.ID, persona.Dir, err)
		}
		if bot.ID != persona.ID {
			return nil, fmt.Errorf("load bot %q: %s contains the brain for %q", persona.ID, persona.Dir, bot.ID)
		}
		bots[persona.ID] = bot
	}
	return bots, nil
}

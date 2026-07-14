// Command spar generates self-play games for a bot and records them to AGS, so
// the trainer (cmd/train-bot) has the bot's own games to learn from. This is the
// no-WebRTC "body" of the cold-start loop: run spar to produce games, then run
// train-bot to learn from them.
//
// Usage:
//
//	go run ./cmd/spar --bot-dir bots/gambit-gus --games 10
//	go run ./cmd/spar --bot-dir bots/gambit-gus --games 5 --dry-run   # local only
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/joho/godotenv"
	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/handler"
	"github.com/junaili/ethan-chess-service/pkg/selfplay"
)

const maxHistory = 200

func main() {
	botDir := flag.String("bot-dir", "bots/gambit-gus", "path to the bot's directory")
	games := flag.Int("games", 10, "number of self-play games to generate")
	historyKey := flag.String("history-key", "", "AGS admin game-record key (default chess-bot-<botID>-history)")
	seed := flag.Int64("seed", time.Now().UnixNano(), "RNG seed for reproducible games")
	dryRun := flag.Bool("dry-run", false, "write games to a local JSON file instead of AGS")
	envFile := flag.String("env", ".env", "AGS credentials env file (shared with the service)")
	flag.Parse()

	// spar needs only AGS creds (no LLM). Real environment variables win.
	_ = godotenv.Load(*envFile)

	bot, err := botbrain.LoadBot(*botDir)
	if err != nil {
		fatal("load bot: %v", err)
	}
	key := *historyKey
	if key == "" {
		key = handler.BotHistoryKey(bot.ID)
	}

	fmt.Printf("Generating %d self-play game(s) for %q (seed %d)…\n", *games, bot.ID, *seed)
	newGames := selfplay.PlayGames(bot, *games, *seed)

	var w, l, d int
	for _, g := range newGames {
		switch g.Result {
		case "win":
			w++
		case "loss":
			l++
		case "draw":
			d++
		}
	}
	fmt.Printf("Played %d games — bot W/L/D: %d/%d/%d.\n", len(newGames), w, l, d)

	if *dryRun {
		out := filepath.Join(*botDir, fmt.Sprintf("selfplay-%d.json", time.Now().Unix()))
		blob, _ := json.MarshalIndent(map[string]any{"matches": newGames}, "", "  ")
		if err := os.WriteFile(out, blob, 0o644); err != nil {
			fatal("write local file: %v", err)
		}
		fmt.Printf("[dry-run] wrote %d games to %s (AGS not touched).\n", len(newGames), out)
		return
	}

	// History is oldest-first so trailing-window calibration and byte compaction
	// retain the genuinely newest evidence.
	existing, err := handler.FetchAllBotGames(key)
	if err != nil {
		fatal("fetch existing games: %v", err)
	}
	merged := append(existing, newGames...)
	if len(merged) > maxHistory {
		merged = merged[len(merged)-maxHistory:]
	}
	if err := handler.SaveBotGameHistory(key, merged); err != nil {
		fatal("save games to AGS: %v", err)
	}
	fmt.Printf("Recorded %d new game(s) to AGS record %q (%d total). Run train-bot to learn from them.\n",
		len(newGames), key, len(merged))
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", a...)
	os.Exit(1)
}

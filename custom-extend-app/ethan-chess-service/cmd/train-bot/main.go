// Command train-bot is the daily, locally-run trainer for a self-learning chess
// personality bot. It reads the bot's OWN match history from AGS (last 24h),
// reconstructs each game, and reflects on them with the configured LLM provider
// (Anthropic, OpenAI/ChatGPT, or a local model) to grow the bot's brain — so the
// bot gets a little smarter each day, from its own play only.
//
// Usage:
//
//	go run ./cmd/train-bot --bot-dir bots/gambit-gus --bot-user-id <agsUserID>
//
// Env (.env or environment):
//
//	AGS:  AB_BASE_URL, AB_CLIENT_ID, AB_CLIENT_SECRET, AB_NAMESPACE, BOT_USER_ID
//	LLM:  LLM_PROVIDER=anthropic|openai, LLM_MODEL, LLM_API_KEY
//	      (or ANTHROPIC_API_KEY / OPENAI_API_KEY); for local models set
//	      LLM_PROVIDER=openai and LLM_BASE_URL=http://localhost:11434/v1
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/handler"
	"github.com/junaili/ethan-chess-service/pkg/llm"
	"github.com/junaili/ethan-chess-service/pkg/trainer"
)

func main() {
	botDir := flag.String("bot-dir", "bots/gambit-gus", "path to the bot's directory (persona.md, style.json, brain.json)")
	historyKey := flag.String("history-key", "", "AGS admin game-record key (default chess-bot-<botID>-history)")
	sinceHours := flag.Int("since-hours", 24, "only learn from games that ended within this many hours")
	dryRun := flag.Bool("dry-run", false, "reflect but do not write brain.json / journal")
	printPrompt := flag.Bool("print-prompt", false, "print the reflection prompt sent to the LLM")
	envFile := flag.String("env", ".env", "AGS credentials env file (shared with the service)")
	llmEnvFile := flag.String("llm-env", ".env.local", "LOCAL-ONLY LLM config env file (never deployed)")
	flag.Parse()

	// LLM config is local-only (.env.local), loaded first so it takes precedence;
	// AGS creds come from the shared .env. Real environment variables win over both.
	_ = godotenv.Load(*llmEnvFile, *envFile)

	bot, err := botbrain.LoadBot(*botDir)
	if err != nil {
		fatal("load bot: %v", err)
	}
	fmt.Printf("Bot %q loaded — brain v%d, learned from %d games, %d lessons.\n",
		bot.ID, bot.Brain.Version, bot.Brain.GamesLearnedFrom, len(bot.Brain.Lessons))

	key := *historyKey
	if key == "" {
		key = handler.BotHistoryKey(bot.ID)
	}

	since := time.Now().Add(-time.Duration(*sinceHours) * time.Hour)
	fmt.Printf("Fetching %s's games from AGS record %q since %s …\n", bot.ID, key, since.Format(time.RFC3339))

	matches, err := handler.FetchBotGameHistory(key, since)
	if err != nil {
		fatal("fetch match history: %v", err)
	}

	var fresh []botbrain.MatchEntry
	for _, m := range matches {
		if !bot.Brain.AlreadyProcessed(m.ID) {
			fresh = append(fresh, m)
		}
	}
	fmt.Printf("Found %d games in the last %dh; %d are new.\n", len(matches), *sinceHours, len(fresh))
	if len(fresh) == 0 {
		fmt.Println("Nothing new to learn from in this window.")
		fmt.Println("(The bot must have played & recorded games — see the self-play generator slice.)")
		return
	}

	// Reconstruct (Slice 2).
	pairs := trainer.ReconstructAll(fresh, bot.ID)
	for _, p := range pairs {
		g := p.Game
		fmt.Printf("  • %s vs %s  color=%s plies=%d outcome=%s (%s) stored=%s\n",
			p.Entry.ID, opponentLabel(p.Entry), orDash(g.BotColor), g.PlyCount, g.EngineOutcome, g.EngineMethod, p.Entry.Result)
		fmt.Printf("      %s\n", movesPreview(g.SANs))
	}

	// Reflect + learn (Slice 3), using whichever provider is configured.
	cfg := llm.FromEnv()
	if *printPrompt {
		system, user := trainer.BuildPrompt(bot, pairs)
		fmt.Println("\n=== SYSTEM PROMPT ===\n" + system + "\n\n=== USER PROMPT ===\n" + user)
	}
	if !cfg.Configured() {
		fmt.Println("\nNo LLM provider configured — skipping reflection.")
		fmt.Println("Set LLM_PROVIDER=anthropic|openai + a key, or LLM_BASE_URL for a local model.")
		return
	}

	provider, err := llm.New(cfg)
	if err != nil {
		fatal("llm: %v", err)
	}
	fmt.Printf("\nReflecting with %s (%s) …\n", provider.Name(), provider.Model())

	refl, err := trainer.Reflect(context.Background(), provider, bot, pairs)
	if err != nil {
		fatal("reflect: %v", err)
	}

	outcome := trainer.Apply(bot, pairs, refl, time.Now())
	trainer.ComputePlayTuning(bot.Brain, matches) // same play-tuning step the Extend job runs
	fmt.Printf("Learned: +%d lesson(s), %d opening(s), %d opponent(s) across %d game(s).\n",
		outcome.LessonsAdded, outcome.OpeningsTouched, outcome.OpponentsTouched, outcome.GamesLearned)
	if outcome.Summary != "" {
		fmt.Printf("  “%s”\n", outcome.Summary)
	}

	if *dryRun {
		fmt.Println("[dry-run] brain.json NOT written.")
		return
	}
	if err := bot.SaveBrain(); err != nil {
		fatal("save brain: %v", err)
	}
	if err := bot.AppendJournal(time.Now().UTC().Format("2006-01-02"), outcome.JournalText); err != nil {
		fmt.Fprintf(os.Stderr, "warning: write journal: %v\n", err)
	}
	fmt.Printf("Saved brain.json (now v%d) and journal entry.\n", bot.Brain.Version)
}

func opponentLabel(m botbrain.MatchEntry) string {
	switch {
	case m.OpponentName != "":
		return m.OpponentName
	case m.OpponentUserID != "":
		return m.OpponentUserID
	default:
		return "(unknown)"
	}
}

func orDash(s string) string {
	if s == "" {
		return "?"
	}
	return s
}

func movesPreview(sans []string) string {
	var b strings.Builder
	for i, s := range sans {
		if i >= 16 {
			b.WriteString("…")
			break
		}
		if i%2 == 0 {
			fmt.Fprintf(&b, "%d.%s ", i/2+1, s)
		} else {
			b.WriteString(s + " ")
		}
	}
	return strings.TrimSpace(b.String())
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", a...)
	os.Exit(1)
}

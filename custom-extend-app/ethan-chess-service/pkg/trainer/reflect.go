// Package trainer turns a batch of the bot's own recent games into updates to
// its brain. Facts (opening win/loss tallies, opponent game counts) are computed
// deterministically from the reconstructed games; insight (lessons, opponent
// reads, the journal note) comes from the configured LLM provider. The bot
// learns only from the games passed in.
package trainer

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/chessreplay"
	"github.com/junaili/ethan-chess-service/pkg/llm"
)

const maxLessons = 200

// GamePair couples a stored match with its reconstruction.
type GamePair struct {
	Entry botbrain.MatchEntry
	Game  *chessreplay.Game
}

// ReconstructAll replays every entry; games that fail replay keep what was
// recovered and are flagged Truncated.
func ReconstructAll(entries []botbrain.MatchEntry, botName string) []GamePair {
	pairs := make([]GamePair, 0, len(entries))
	for _, e := range entries {
		g, _ := chessreplay.Reconstruct(e, botName)
		pairs = append(pairs, GamePair{Entry: e, Game: g})
	}
	return pairs
}

// Reflection is the LLM's structured output (insight only).
type Reflection struct {
	JournalSummary string `json:"journal_summary"`
	Lessons        []struct {
		Text string   `json:"text"`
		Tags []string `json:"tags"`
	} `json:"lessons"`
	OpponentNotes []struct {
		OpponentName   string `json:"opponentName"`
		OpponentUserID string `json:"opponentUserId"`
		Note           string `json:"note"`
	} `json:"opponent_notes"`
}

// Outcome summarizes what a training run changed.
type Outcome struct {
	GamesLearned     int
	LessonsAdded     int
	OpeningsTouched  int
	OpponentsTouched int
	Summary          string
	JournalText      string
}

// BuildPrompt assembles the system + user prompts from the persona, style, the
// current brain, and the games to reflect on.
func BuildPrompt(bot *botbrain.Bot, pairs []GamePair) (system, user string) {
	system = fmt.Sprintf(`You are %s, a chess bot that learns ONLY from your own games.
You keep a private training journal. Below is your personality and your style settings.

--- PERSONA ---
%s

--- STYLE (style.json) ---
%s

Be concise, concrete, and honest about your mistakes. Keep your attacking soul,
but learn what actually works. Never invent games or facts beyond what you are shown.`,
		bot.ID, strings.TrimSpace(bot.Persona), strings.TrimSpace(string(bot.Style)))

	var b strings.Builder
	b.WriteString("WHAT YOU'VE LEARNED SO FAR (do not repeat these lessons):\n")
	if len(bot.Brain.Lessons) == 0 {
		b.WriteString("  (nothing yet — you are a blank slate)\n")
	} else {
		for _, l := range bot.Brain.Lessons {
			fmt.Fprintf(&b, "  - %s\n", l.Text)
		}
	}

	b.WriteString("\nYOUR GAMES IN THE LAST 24 HOURS (reflect only on these):\n")
	for i, p := range pairs {
		g := p.Game
		fmt.Fprintf(&b, "\nGame %d vs %s — you played %s, result: %s (%s)\n",
			i+1, opponentName(p.Entry), dash(g.BotColor), botResult(g), g.EngineMethod)
		if g.Truncated {
			b.WriteString("  (note: move data was incomplete; reflect on what is shown)\n")
		}
		fmt.Fprintf(&b, "  %s\n", strings.TrimSpace(g.PGN))
	}

	b.WriteString(`
Respond with ONLY a JSON object (no prose, no code fences) of this shape:
{
  "journal_summary": "2-4 sentences in your voice about what you learned today",
  "lessons": [ { "text": "short, specific, actionable lesson for your future play", "tags": ["opening|tactics|endgame|opponent|psychology"] } ],
  "opponent_notes": [ { "opponentName": "", "opponentUserId": "", "note": "how this specific opponent plays / how to beat them" } ]
}`)
	user = b.String()
	return system, user
}

// Reflect calls the provider and parses its structured reflection.
func Reflect(ctx context.Context, p llm.Provider, bot *botbrain.Bot, pairs []GamePair) (*Reflection, error) {
	system, user := BuildPrompt(bot, pairs)
	raw, err := p.Complete(ctx, llm.Request{System: system, User: user})
	if err != nil {
		return nil, fmt.Errorf("llm complete: %w", err)
	}
	return ParseReflection(raw)
}

// ParseReflection tolerantly extracts the JSON object from a model response.
func ParseReflection(raw string) (*Reflection, error) {
	s := strings.TrimSpace(raw)
	if i := strings.IndexByte(s, '{'); i >= 0 {
		if j := strings.LastIndexByte(s, '}'); j > i {
			s = s[i : j+1]
		}
	}
	var r Reflection
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		return nil, fmt.Errorf("parse reflection JSON: %w", err)
	}
	return &r, nil
}

// Apply merges deterministic tallies + the LLM's insight into the brain and
// returns a summary. It bumps the version, records processed match ids, and
// builds the journal text. It does NOT write files (the caller saves).
func Apply(bot *botbrain.Bot, pairs []GamePair, r *Reflection, now time.Time) Outcome {
	br := bot.Brain
	out := Outcome{GamesLearned: len(pairs)}
	nowISO := now.UTC().Format(time.RFC3339)
	touchedOpenings := map[string]bool{}
	touchedOpponents := map[string]bool{}

	// Deterministic facts: opening + opponent tallies from the games themselves.
	for _, p := range pairs {
		g := p.Game
		if key := openingKey(g); key != "" {
			os := br.OpeningBook[key]
			if os == nil {
				os = &botbrain.OpeningStat{Line: key}
				br.OpeningBook[key] = os
			}
			os.Played++
			switch botResult(g) {
			case "win":
				os.Wins++
			case "loss":
				os.Losses++
			case "draw":
				os.Draws++
			}
			touchedOpenings[key] = true
		}
		if dk := opponentKey(p.Entry); dk != "" {
			d := br.OpponentDossiers[dk]
			if d == nil {
				d = &botbrain.OpponentDossier{
					OpponentUserID: p.Entry.OpponentUserID,
					OpponentName:   p.Entry.OpponentName,
				}
				br.OpponentDossiers[dk] = d
			}
			d.GamesPlayed++
			d.UpdatedAt = nowISO
			touchedOpponents[dk] = true
		}
		br.ProcessedMatchIDs = append(br.ProcessedMatchIDs, p.Entry.ID)
	}

	// Insight from the LLM: lessons + opponent notes.
	if r != nil {
		existing := lessonTextSet(br.Lessons)
		for _, l := range r.Lessons {
			text := strings.TrimSpace(l.Text)
			if text == "" || existing[strings.ToLower(text)] {
				continue
			}
			existing[strings.ToLower(text)] = true
			br.Lessons = append(br.Lessons, botbrain.Lesson{
				ID:        lessonID(text),
				Text:      text,
				Tags:      l.Tags,
				Weight:    1.0,
				LearnedAt: nowISO,
			})
			out.LessonsAdded++
		}
		for _, n := range r.OpponentNotes {
			dk := n.OpponentUserID
			if dk == "" {
				dk = n.OpponentName
			}
			if dk == "" {
				continue
			}
			d := br.OpponentDossiers[dk]
			if d == nil {
				d = &botbrain.OpponentDossier{OpponentUserID: n.OpponentUserID, OpponentName: n.OpponentName}
				br.OpponentDossiers[dk] = d
			}
			if note := strings.TrimSpace(n.Note); note != "" {
				d.Notes = note
				d.UpdatedAt = nowISO
				touchedOpponents[dk] = true
			}
		}
	}

	consolidateLessons(br)

	br.Version++
	br.GamesLearnedFrom += len(pairs)
	br.LastTrained = &nowISO
	out.OpeningsTouched = len(touchedOpenings)
	out.OpponentsTouched = len(touchedOpponents)
	if r != nil {
		out.Summary = strings.TrimSpace(r.JournalSummary)
	}
	out.JournalText = buildJournal(bot, pairs, r, out, now)
	return out
}

// consolidateLessons caps the lesson list, dropping the lowest-weight (then
// oldest) lessons so the brain stays sharp as days accumulate.
func consolidateLessons(br *botbrain.Brain) {
	if len(br.Lessons) <= maxLessons {
		return
	}
	sort.SliceStable(br.Lessons, func(i, j int) bool {
		if br.Lessons[i].Weight != br.Lessons[j].Weight {
			return br.Lessons[i].Weight > br.Lessons[j].Weight
		}
		return br.Lessons[i].LearnedAt > br.Lessons[j].LearnedAt
	})
	br.Lessons = br.Lessons[:maxLessons]
}

func buildJournal(bot *botbrain.Bot, pairs []GamePair, r *Reflection, out Outcome, now time.Time) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n## %s — brain v%d\n\n", now.UTC().Format("2006-01-02 15:04 MST"), bot.Brain.Version+1)
	fmt.Fprintf(&b, "Learned from %d game(s): %d new lesson(s), %d opening(s), %d opponent(s).\n\n",
		out.GamesLearned, out.LessonsAdded, out.OpeningsTouched, out.OpponentsTouched)
	if out.Summary != "" {
		fmt.Fprintf(&b, "> %s\n\n", out.Summary)
	}
	if r != nil && len(r.Lessons) > 0 {
		b.WriteString("New lessons:\n")
		for _, l := range r.Lessons {
			fmt.Fprintf(&b, "- %s\n", strings.TrimSpace(l.Text))
		}
		b.WriteString("\n")
	}
	b.WriteString("Games:\n")
	for _, p := range pairs {
		fmt.Fprintf(&b, "- %s vs %s — %s (%s)\n",
			p.Entry.ID, opponentName(p.Entry), botResult(p.Game), p.Game.EngineMethod)
	}
	return b.String()
}

// ── helpers ──────────────────────────────────────────────────────────────────

func botResult(g *chessreplay.Game) string {
	switch g.EngineOutcome {
	case "1-0":
		if g.BotColor == "white" {
			return "win"
		}
		if g.BotColor == "black" {
			return "loss"
		}
	case "0-1":
		if g.BotColor == "black" {
			return "win"
		}
		if g.BotColor == "white" {
			return "loss"
		}
	case "1/2-1/2":
		return "draw"
	}
	switch strings.ToLower(strings.TrimSpace(g.StoredResult)) {
	case "win", "won":
		return "win"
	case "loss", "lost", "lose":
		return "loss"
	case "draw", "drawn", "stalemate":
		return "draw"
	}
	return "unknown"
}

// openingKey is the first few plies in movetext form, used to group openings.
func openingKey(g *chessreplay.Game) string {
	const maxPlies = 6
	n := len(g.SANs)
	if n == 0 {
		return ""
	}
	if n > maxPlies {
		n = maxPlies
	}
	var b strings.Builder
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			fmt.Fprintf(&b, "%d.%s ", i/2+1, g.SANs[i])
		} else {
			b.WriteString(g.SANs[i] + " ")
		}
	}
	return strings.TrimSpace(b.String())
}

func opponentKey(e botbrain.MatchEntry) string {
	if e.OpponentUserID != "" {
		return e.OpponentUserID
	}
	return e.OpponentName
}

func opponentName(e botbrain.MatchEntry) string {
	switch {
	case e.OpponentName != "":
		return e.OpponentName
	case e.OpponentUserID != "":
		return e.OpponentUserID
	default:
		return "(unknown)"
	}
}

func lessonTextSet(ls []botbrain.Lesson) map[string]bool {
	s := make(map[string]bool, len(ls))
	for _, l := range ls {
		s[strings.ToLower(strings.TrimSpace(l.Text))] = true
	}
	return s
}

func lessonID(text string) string {
	h := sha1.Sum([]byte(text))
	return "L" + fmt.Sprintf("%x", h[:4])
}

func dash(s string) string {
	if s == "" {
		return "?"
	}
	return s
}

package trainer

import (
	"context"
	"testing"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/llm"
)

func scholarsMate() botbrain.MatchEntry {
	return botbrain.MatchEntry{
		ID:           "g1",
		WhiteName:    "Gambit Gus",
		BlackName:    "Victim",
		OpponentName: "Victim",
		Result:       "win",
		Moves: []botbrain.Move{
			{Fr: 6, Fc: 4, ToR: 4, ToC: 4},
			{Fr: 1, Fc: 4, ToR: 3, ToC: 4},
			{Fr: 7, Fc: 5, ToR: 4, ToC: 2},
			{Fr: 0, Fc: 1, ToR: 2, ToC: 2},
			{Fr: 7, Fc: 3, ToR: 3, ToC: 7},
			{Fr: 0, Fc: 6, ToR: 2, ToC: 5},
			{Fr: 3, Fc: 7, ToR: 1, ToC: 5},
		},
	}
}

func newBlankBot() *botbrain.Bot {
	return &botbrain.Bot{
		ID:      "gambit-gus",
		Persona: "Gambit Gus, an attacker.",
		Style:   []byte(`{"aggression":0.85}`),
		Brain: &botbrain.Brain{
			SchemaVersion:    1,
			BotID:            "gambit-gus",
			OpeningBook:      map[string]*botbrain.OpeningStat{},
			OpponentDossiers: map[string]*botbrain.OpponentDossier{},
		},
	}
}

func TestReflectAndApply(t *testing.T) {
	bot := newBlankBot()
	pairs := ReconstructAll([]botbrain.MatchEntry{scholarsMate()}, bot.ID)

	fake := &llm.FakeProvider{Response: `Sure! Here is my reflection:
{
  "journal_summary": "The Qh5/Bc4 attack crushed an unprepared opponent.",
  "lessons": [
    {"text": "The early Qh5 + Bc4 battery wins fast against ...f6 blunders", "tags": ["opening","tactics"]}
  ],
  "opponent_notes": [
    {"opponentName": "Victim", "opponentUserId": "", "note": "Walked into Scholar's mate; punish ...Nf6 hesitation."}
  ]
}`}

	refl, err := Reflect(context.Background(), fake, bot, pairs)
	if err != nil {
		t.Fatalf("reflect: %v", err)
	}
	if len(refl.Lessons) != 1 {
		t.Fatalf("expected 1 lesson from LLM, got %d", len(refl.Lessons))
	}

	out := Apply(bot, pairs, refl, time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC))

	if out.LessonsAdded != 1 {
		t.Errorf("LessonsAdded = %d, want 1", out.LessonsAdded)
	}
	if bot.Brain.Version != 1 {
		t.Errorf("version = %d, want 1", bot.Brain.Version)
	}
	if bot.Brain.GamesLearnedFrom != 1 {
		t.Errorf("games learned = %d, want 1", bot.Brain.GamesLearnedFrom)
	}
	if len(bot.Brain.ProcessedMatchIDs) != 1 || bot.Brain.ProcessedMatchIDs[0] != "g1" {
		t.Errorf("processed ids = %v, want [g1]", bot.Brain.ProcessedMatchIDs)
	}
	if !bot.Brain.AlreadyProcessed("g1") {
		t.Error("g1 should be marked processed")
	}
	// Opening book tallied a win for the bot (white, checkmate).
	if len(bot.Brain.OpeningBook) != 1 {
		t.Fatalf("expected 1 opening, got %d", len(bot.Brain.OpeningBook))
	}
	for _, os := range bot.Brain.OpeningBook {
		if os.Played != 1 || os.Wins != 1 {
			t.Errorf("opening stat = %+v, want played=1 wins=1", os)
		}
	}
	// Opponent dossier captured the LLM note + game count.
	d := bot.Brain.OpponentDossiers["Victim"]
	if d == nil || d.GamesPlayed != 1 || d.Notes == "" {
		t.Errorf("dossier = %+v, want gamesPlayed=1 with notes", d)
	}

	// Idempotency: re-applying the same game adds no new lessons (dedup by text).
	pairs2 := ReconstructAll([]botbrain.MatchEntry{scholarsMate()}, bot.ID)
	out2 := Apply(bot, pairs2, refl, time.Now())
	if out2.LessonsAdded != 0 {
		t.Errorf("re-apply added %d lessons, want 0 (dedup)", out2.LessonsAdded)
	}
}

func TestParseReflectionTolerant(t *testing.T) {
	raw := "```json\n{\"journal_summary\":\"hi\",\"lessons\":[],\"opponent_notes\":[]}\n```"
	r, err := ParseReflection(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if r.JournalSummary != "hi" {
		t.Errorf("summary = %q, want hi", r.JournalSummary)
	}
}

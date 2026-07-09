package main

import (
	"testing"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

func TestParsePersonaMarkdown(t *testing.T) {
	md := `# Gambit Gus

> This file is yours to edit.

## Identity
- **Name:** Gambit Gus
- **Tagline:** "Material is temporary. Initiative is forever."

## Personality
Gus is a swashbuckling attacker who would rather lose brilliantly than win
boringly. He is cheerful, a little cocky.

## Playing style (intent)
- Prefers open, tactical positions.
`
	name, tagline, personality := parsePersonaMarkdown(md)
	if name != "Gambit Gus" {
		t.Errorf("name = %q", name)
	}
	if tagline != "Material is temporary. Initiative is forever." {
		t.Errorf("tagline = %q", tagline)
	}
	if want := "Gus is a swashbuckling attacker who would rather lose brilliantly than win boringly. He is cheerful, a little cocky."; personality != want {
		t.Errorf("personality = %q, want %q", personality, want)
	}
}

func TestParsePersonaMarkdownEmpty(t *testing.T) {
	name, tagline, personality := parsePersonaMarkdown("")
	if name != "" || tagline != "" || personality != "" {
		t.Errorf("expected empty results, got %q %q %q", name, tagline, personality)
	}
}

func entry(id, result, endedAt string, durMs int64, opponent string) botbrain.MatchEntry {
	return botbrain.MatchEntry{
		ID: id, Mode: "online", Result: result, EndedAt: endedAt,
		DurationMs: durMs, OpponentUserID: opponent,
	}
}

func TestComputeGusStats(t *testing.T) {
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	recent := now.Add(-24 * time.Hour).Format(time.RFC3339)
	old := now.Add(-30 * 24 * time.Hour).Format(time.RFC3339)
	matches := []botbrain.MatchEntry{
		entry("g1", "loss", old, 60_000, "u1"),
		entry("g2", "abandoned", old, 0, "u1"),
		entry("g3", "win", recent, 120_000, "u2"),
		entry("g4", "win", recent, 180_000, "u1"),
	}
	s := computeGusStats(matches, now)
	if s.Games != 3 || s.Wins != 2 || s.Losses != 1 || s.Draws != 0 || s.Abandoned != 1 {
		t.Errorf("record = %+v", s)
	}
	if s.GamesLast7Days != 2 {
		t.Errorf("gamesLast7Days = %d, want 2", s.GamesLast7Days)
	}
	if s.StreakType != "win" || s.StreakCount != 2 {
		t.Errorf("streak = %s x%d, want win x2", s.StreakType, s.StreakCount)
	}
	if s.AvgDurationMs != 120_000 {
		t.Errorf("avgDurationMs = %d, want 120000", s.AvgDurationMs)
	}
	if want := 2.0 / 3.0; s.WinRate < want-0.001 || s.WinRate > want+0.001 {
		t.Errorf("winRate = %f", s.WinRate)
	}
	if s.LastPlayedAt == "" {
		t.Error("lastPlayedAt is empty")
	}
}

func TestComputeGusStatsEmpty(t *testing.T) {
	s := computeGusStats(nil, time.Now())
	if s.Games != 0 || s.WinRate != 0 || s.StreakType != "" {
		t.Errorf("empty stats = %+v", s)
	}
}

func TestComputeGusStatsStreakIgnoresAbandoned(t *testing.T) {
	now := time.Now()
	matches := []botbrain.MatchEntry{
		entry("g1", "loss", "", 0, "u1"),
		entry("g2", "win", "", 0, "u1"),
		entry("g3", "abandoned", "", 0, "u1"),
	}
	s := computeGusStats(matches, now)
	if s.StreakType != "win" || s.StreakCount != 1 {
		t.Errorf("streak = %s x%d, want win x1", s.StreakType, s.StreakCount)
	}
}

func TestComputeGusAboutYou(t *testing.T) {
	matches := []botbrain.MatchEntry{
		entry("g1", "win", "", 0, "me"),   // Gus won → my loss
		entry("g2", "loss", "", 0, "me"),  // Gus lost → my win
		entry("g3", "draw", "", 0, "me"),
		entry("g4", "win", "", 0, "someone-else"),
		entry("g5", "abandoned", "", 0, "me"),
	}
	brain := &botbrain.Brain{OpponentDossiers: map[string]*botbrain.OpponentDossier{
		"me": {OpponentUserID: "me", GamesPlayed: 3, Notes: "Punishes my greek gift.", UpdatedAt: "2026-07-01"},
	}}
	a := computeGusAboutYou(matches, brain, "me")
	if a == nil {
		t.Fatal("aboutYou is nil")
	}
	if a.GamesVsYou != 3 || a.YourWins != 1 || a.YourLosses != 1 || a.YourDraws != 1 {
		t.Errorf("aboutYou = %+v", a)
	}
	if a.Notes != "Punishes my greek gift." {
		t.Errorf("notes = %q", a.Notes)
	}
}

func TestComputeGusAboutYouUnknownPlayer(t *testing.T) {
	if a := computeGusAboutYou(nil, &botbrain.Brain{}, "stranger"); a != nil {
		t.Errorf("expected nil for unknown player, got %+v", a)
	}
	if a := computeGusAboutYou(nil, nil, ""); a != nil {
		t.Errorf("expected nil for empty user, got %+v", a)
	}
}

func TestSummarizeGusBrain(t *testing.T) {
	trained := "2026-07-07T09:00:00Z"
	brain := &botbrain.Brain{
		Version:          4,
		LastTrained:      &trained,
		GamesLearnedFrom: 17,
		Lessons: []botbrain.Lesson{
			{Text: "low", Weight: 0.1, LearnedAt: "2026-07-01"},
			{Text: "high", Weight: 0.9, LearnedAt: "2026-07-06"},
			{Text: "   ", Weight: 0.95},
		},
		OpeningBook: map[string]*botbrain.OpeningStat{
			"a": {Line: "1.e4 e5 2.f4", Played: 5, Wins: 3, Losses: 2},
			"b": {Line: "1.e4 e5 2.Nf3", Played: 9, Wins: 4, Draws: 1, Losses: 4},
		},
		OpponentDossiers: map[string]*botbrain.OpponentDossier{"u1": {}, "u2": {}},
		PlayTuning: &botbrain.PlayTuning{
			Difficulty: "medium", ThinkMsMean: 1400, ThinkMsJitter: 500, WinRate: 0.55,
			Book: []botbrain.BookLine{{}, {}},
		},
	}
	s := summarizeGusBrain(brain)
	if s.Version != 4 || s.LastTrained != trained || s.GamesLearnedFrom != 17 {
		t.Errorf("header = %+v", s)
	}
	if s.Difficulty != "medium" || s.BookLines != 2 || s.OpponentsKnown != 2 {
		t.Errorf("tuning = %+v", s)
	}
	if len(s.Lessons) != 2 || s.Lessons[0].Text != "high" {
		t.Errorf("lessons = %+v (blank lesson must be dropped, high weight first)", s.Lessons)
	}
	if len(s.Openings) != 2 || s.Openings[0].Line != "1.e4 e5 2.Nf3" {
		t.Errorf("openings = %+v (most-played first)", s.Openings)
	}
}

func TestSummarizeGusBrainNil(t *testing.T) {
	if s := summarizeGusBrain(nil); s != nil {
		t.Errorf("expected nil summary, got %+v", s)
	}
}

func TestRecentAndJournalOrdering(t *testing.T) {
	matches := []botbrain.MatchEntry{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	recent := recentGusMatches(matches, 2)
	if len(recent) != 2 || recent[0].ID != "c" || recent[1].ID != "b" {
		t.Errorf("recent = %+v", recent)
	}
}

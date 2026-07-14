package trainer

import (
	"fmt"
	"testing"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

func TestNormalizeBrainMigratesStableIdentityAndRemovesSyntheticNotes(t *testing.T) {
	brain := &botbrain.Brain{
		OpponentDossiers: map[string]*botbrain.OpponentDossier{
			"Display Name": {OpponentName: "Display Name", GamesPlayed: 3, Notes: "legacy note", UpdatedAt: "2026-07-01T00:00:00Z"},
			"wrong-key":    {OpponentUserID: "stable-id", OpponentName: "Display Name", GamesPlayed: 4, Notes: "newer note", UpdatedAt: "2026-07-02T00:00:00Z"},
		},
		Lessons: []botbrain.Lesson{
			{Text: "A useful real lesson", FromGame: "real-game", Weight: 1},
			{Text: "A fabricated test lesson", FromGame: "synthetic-train-test-1", Weight: 50},
			{Text: "Display Name blundered on e4", FromGame: "identity-game", Weight: 10},
		},
		TrainingJournal: []botbrain.JournalEntry{
			{ID: "synthetic-test", Text: "test"},
			{ID: "real", Text: "verified note"},
		},
	}
	history := []botbrain.MatchEntry{{ID: "identity-game", OpponentName: "Display Name", OpponentUserID: "stable-id"}}
	NormalizeBrain(brain, history)

	dossier := brain.OpponentDossiers["stable-id"]
	if dossier == nil || dossier.GamesPlayed != 4 || dossier.Notes != "newer note" {
		t.Fatalf("stable dossier migration failed: %#v", brain.OpponentDossiers)
	}
	if len(brain.OpponentDossiers) != 1 {
		t.Fatalf("legacy identity keys remain: %#v", brain.OpponentDossiers)
	}
	if len(brain.Lessons) != 1 || brain.Lessons[0].FromGame != "real-game" {
		t.Fatalf("synthetic lesson remains: %#v", brain.Lessons)
	}
	if len(brain.TrainingJournal) != 1 || brain.TrainingJournal[0].ID != "real" {
		t.Fatalf("synthetic journal remains: %#v", brain.TrainingJournal)
	}
}

func TestNormalizeBrainBoundsLongLivedMemories(t *testing.T) {
	brain := &botbrain.Brain{
		OpeningBook:      map[string]*botbrain.OpeningStat{},
		OpponentDossiers: map[string]*botbrain.OpponentDossier{},
	}
	for i := 0; i < 550; i++ {
		key := fmt.Sprintf("memory-%03d", i)
		brain.OpeningBook[key] = &botbrain.OpeningStat{Line: key, Played: i}
		brain.OpponentDossiers[key] = &botbrain.OpponentDossier{OpponentUserID: key, GamesPlayed: i, UpdatedAt: fmt.Sprintf("2026-01-%02dT00:00:00Z", i%28+1)}
		brain.TrainingJournal = append(brain.TrainingJournal, botbrain.JournalEntry{ID: key})
	}
	NormalizeBrain(brain, nil)
	if len(brain.OpeningBook) != maxOpeningMemories || len(brain.OpponentDossiers) != maxOpponentMemories || len(brain.TrainingJournal) != maxJournalEntries {
		t.Fatalf("long-lived brain was not bounded: openings=%d dossiers=%d journal=%d",
			len(brain.OpeningBook), len(brain.OpponentDossiers), len(brain.TrainingJournal))
	}
	if brain.OpeningBook["memory-549"] == nil || brain.OpeningBook["memory-000"] != nil {
		t.Fatal("opening pruning did not preserve strongest evidence")
	}
}

func TestNormalizeBrainDoesNotGuessAmbiguousDisplayName(t *testing.T) {
	brain := &botbrain.Brain{OpponentDossiers: map[string]*botbrain.OpponentDossier{
		"Sam": {OpponentName: "Sam", Notes: "ambiguous"},
	}}
	history := []botbrain.MatchEntry{
		{OpponentName: "Sam", OpponentUserID: "one"},
		{OpponentName: "Sam", OpponentUserID: "two"},
	}
	NormalizeBrain(brain, history)
	if brain.OpponentDossiers["one"] != nil || brain.OpponentDossiers["two"] != nil || brain.OpponentDossiers["Sam"] == nil {
		t.Fatalf("ambiguous name was assigned to an identity: %#v", brain.OpponentDossiers)
	}
}

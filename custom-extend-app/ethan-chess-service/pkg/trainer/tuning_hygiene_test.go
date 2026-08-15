package trainer

import (
	"testing"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// The no-new-games path calls NormalizePlayTuning directly, so hygiene has to
// work without any history at all.
func TestNormalizePlayTuningStandsAlone(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{
		Difficulty: "hard", SearchBudgetMs: 220,
	}}
	NormalizePlayTuning(brain)

	if got := brain.PlayTuning.SearchBudgetMs; got != defaultSearchMs {
		t.Fatalf("stale budget survived: got %d, want %d", got, defaultSearchMs)
	}
	if got := brain.PlayTuning.MaxShufflePlies; got != maxShufflePlies {
		t.Fatalf("shuffle plies: got %d, want %d", got, maxShufflePlies)
	}
	if got := brain.PlayTuning.Difficulty; got != "hard" {
		t.Fatalf("hygiene must not touch difficulty: got %q", got)
	}
}

func TestNormalizePlayTuningSeedsAMissingTuning(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{}
	NormalizePlayTuning(brain)

	if brain.PlayTuning == nil {
		t.Fatal("tuning was not created")
	}
	if brain.PlayTuning.SearchBudgetMs != defaultSearchMs {
		t.Fatalf("budget: got %d", brain.PlayTuning.SearchBudgetMs)
	}
}

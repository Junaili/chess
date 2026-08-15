package trainer

import (
	"testing"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// A budget carried over from the 500ms era must be re-based, or the bot keeps a
// think time too short to finish the depth its difficulty advertises.
func TestComputePlayTuningRebasesStaleSearchBudget(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name  string
		start int
		want  int
	}{
		{"stale 220 from the old ceiling", 220, defaultSearchMs},
		{"unset", 0, defaultSearchMs},
		{"absurd value", 99999, defaultSearchMs},
		{"already sensible", 2400, 2400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{
				Difficulty: "hard", SearchBudgetMs: tc.start,
			}}
			ComputePlayTuning(brain, nil)
			if got := brain.PlayTuning.SearchBudgetMs; got != tc.want {
				t.Fatalf("SearchBudgetMs: got %d, want %d", got, tc.want)
			}
		})
	}
}

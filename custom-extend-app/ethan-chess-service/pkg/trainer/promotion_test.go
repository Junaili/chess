package trainer

import (
	"fmt"
	"testing"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

func regretHistory(n int, regret float64, bookRegret int) ([]botbrain.MatchEntry, map[string]GameAnalysis) {
	history := make([]botbrain.MatchEntry, 0, n)
	analyses := map[string]GameAnalysis{}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("m%d", i)
		history = append(history, botbrain.MatchEntry{ID: id, Result: "loss"})
		analyses[id] = GameAnalysis{
			MatchID: id, AverageRegret: regret, BotMoveCount: 20, BookRegretCP: bookRegret,
		}
	}
	return history, analyses
}

func TestCleanPlayEarnsARung(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{StrengthLevel: 7}}
	history, analyses := regretHistory(12, 50, 0) // well under the level-7 ceiling of 80
	out := EvaluatePromotion(brain, history, analyses, time.Now())

	if !out.Promoted {
		t.Fatalf("expected promotion, got %q", out.Reason)
	}
	if brain.PlayTuning.StrengthLevel != 8 {
		t.Fatalf("level: got %d, want 8", brain.PlayTuning.StrengthLevel)
	}
}

// Losing every game must not block promotion: results measure the opponent,
// quality measures the bot. This is the whole reason the rule uses regret.
func TestLosingEveryGameStillPromotesOnQuality(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{StrengthLevel: 5}}
	history, analyses := regretHistory(12, 40, 0)
	for i := range history {
		history[i].Result = "loss"
	}
	if out := EvaluatePromotion(brain, history, analyses, time.Now()); !out.Promoted {
		t.Fatalf("a cleanly-playing bot that keeps losing should still promote: %q", out.Reason)
	}
}

// One mating blunder produces a five-figure regret. A mean would be wrecked by
// it; the median must not be.
func TestOneCatastrophicGameDoesNotBlockPromotion(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{StrengthLevel: 7}}
	history, analyses := regretHistory(12, 50, 0)
	analyses["m0"] = GameAnalysis{MatchID: "m0", AverageRegret: 39936, BotMoveCount: 20}

	if out := EvaluatePromotion(brain, history, analyses, time.Now()); !out.Promoted {
		t.Fatalf("a single disaster blocked promotion: %q (median %.0f)", out.Reason, out.MedianRegret)
	}
}

func TestUnsoundOpeningBlocksPromotion(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{StrengthLevel: 7}}
	history, analyses := regretHistory(12, 50, unsoundBookRegretCP+1)

	out := EvaluatePromotion(brain, history, analyses, time.Now())
	if out.Promoted {
		t.Fatal("winning on an unsound opening should not buy a rung")
	}
	if brain.PlayTuning.StrengthLevel != 7 {
		t.Fatalf("level moved anyway: %d", brain.PlayTuning.StrengthLevel)
	}
}

func TestThinEvidenceHoldsTheLevel(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{StrengthLevel: 7}}
	history, analyses := regretHistory(promotionMinSample-1, 10, 0)

	out := EvaluatePromotion(brain, history, analyses, time.Now())
	if out.Promoted || out.Demoted {
		t.Fatalf("moved on %d games: %q", out.Sample, out.Reason)
	}
}

func TestDemotionNeedsTwoBadRunsAndRespectsTheFloor(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{StrengthLevel: 7, LevelFloor: 6}}
	history, analyses := regretHistory(12, 500, 0) // far past 2x the ceiling

	if out := EvaluatePromotion(brain, history, analyses, time.Now()); out.Demoted {
		t.Fatal("demoted on the first bad run")
	}
	if out := EvaluatePromotion(brain, history, analyses, time.Now()); !out.Demoted {
		t.Fatalf("second bad run should demote: %q", out.Reason)
	}
	if brain.PlayTuning.StrengthLevel != 6 {
		t.Fatalf("level: got %d, want 6", brain.PlayTuning.StrengthLevel)
	}
	// At the floor now: no amount of bad play may take a banked rung away.
	EvaluatePromotion(brain, history, analyses, time.Now())
	EvaluatePromotion(brain, history, analyses, time.Now())
	if brain.PlayTuning.StrengthLevel != 6 {
		t.Fatalf("dropped below the floor: got %d, want 6", brain.PlayTuning.StrengthLevel)
	}
}

// A rung held for a week is banked, so later slumps cannot undo it.
func TestHoldingARungLongEnoughBanksIt(t *testing.T) {
	t.Parallel()

	old := time.Now().Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339)
	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{
		StrengthLevel: 8, LevelFloor: 5, LevelSince: old,
	}}
	history, analyses := regretHistory(12, 1000, 0)
	EvaluatePromotion(brain, history, analyses, time.Now())

	if brain.PlayTuning.LevelFloor != 8 {
		t.Fatalf("floor did not rise to the held level: got %d, want 8", brain.PlayTuning.LevelFloor)
	}
}

func TestPromotionStopsAtTheTopOfTheLadder(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{StrengthLevel: maxStrengthLevel}}
	history, analyses := regretHistory(12, 1, 0)
	EvaluatePromotion(brain, history, analyses, time.Now())
	if brain.PlayTuning.StrengthLevel != maxStrengthLevel {
		t.Fatalf("climbed past the ladder: %d", brain.PlayTuning.StrengthLevel)
	}
}

package trainer

import (
	"testing"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// Seeding must land a brain on the rung it is already playing at. If "hard"
// seeded anywhere but the 4-ply rung, this refactor would silently restrength
// both live bots.
func TestStrengthLevelSeedsFromTheLegacyName(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		difficulty string
		want       int
	}{
		{"easy", 1},
		{"medium", 4},
		{"hard", 7},
		{"", 4},
		{"NONSENSE", 4},
	} {
		brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{Difficulty: tc.difficulty}}
		NormalizePlayTuning(brain)
		if got := brain.PlayTuning.StrengthLevel; got != tc.want {
			t.Errorf("difficulty %q: got level %d, want %d", tc.difficulty, got, tc.want)
		}
	}
}

func TestStrengthLevelKeepsAValidStoredRung(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{Difficulty: "medium", StrengthLevel: 9}}
	NormalizePlayTuning(brain)
	if got := brain.PlayTuning.StrengthLevel; got != 9 {
		t.Fatalf("stored rung was overwritten: got %d, want 9", got)
	}
}

func TestOutOfRangeStrengthLevelIsReseeded(t *testing.T) {
	t.Parallel()

	for _, bad := range []int{0, -3, 99} {
		brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{Difficulty: "hard", StrengthLevel: bad}}
		NormalizePlayTuning(brain)
		if got := brain.PlayTuning.StrengthLevel; got != 7 {
			t.Errorf("level %d: got %d, want 7", bad, got)
		}
	}
}

// While the fairness dial still owns strength, the rung has to follow the name
// it picks — otherwise the dial goes inert the moment the bot reads the rung.
func TestTuningKeepsTheRungInStepWithTheDial(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{Difficulty: "hard", StrengthLevel: 7}}
	history := make([]botbrain.MatchEntry, 0, 10)
	for i := 0; i < 10; i++ {
		history = append(history, botbrain.MatchEntry{ID: string(rune('a' + i)), Result: "win"})
	}
	ComputePlayTuning(brain, history)

	if brain.PlayTuning.Difficulty != "medium" {
		t.Fatalf("a winning bot should have been dialled down: got %q", brain.PlayTuning.Difficulty)
	}
	if got := brain.PlayTuning.StrengthLevel; got != 4 {
		t.Fatalf("rung did not follow the dial: got %d, want 4", got)
	}
}

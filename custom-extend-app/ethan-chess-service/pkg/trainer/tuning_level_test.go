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

// The whole point of the split: a bot that keeps winning must give away rungs
// to that player WITHOUT losing the strength it earned. Under the old single
// dial this same history demoted the bot itself.
func TestWinningRaisesTheHandicapNotTheStrength(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{Difficulty: "hard", StrengthLevel: 7}}
	history := make([]botbrain.MatchEntry, 0, 10)
	for i := 0; i < 10; i++ {
		history = append(history, botbrain.MatchEntry{
			ID: string(rune('a' + i)), Result: "win", OpponentUserID: "player-1",
		})
	}
	ComputePlayTuning(brain, history)

	if got := brain.PlayTuning.StrengthLevel; got != 7 {
		t.Fatalf("strength was given away: got %d, want 7", got)
	}
	if got := brain.PlayTuning.GlobalHandicap; got != 1 {
		t.Fatalf("global handicap: got %d, want 1", got)
	}
	if got := brain.OpponentDossiers["player-1"].Handicap; got != 1 {
		t.Fatalf("per-opponent handicap: got %d, want 1", got)
	}
	if got := EffectiveLevel(brain.PlayTuning.StrengthLevel, 1); got != 6 {
		t.Fatalf("effective level: got %d, want 6", got)
	}
}

// A bot being beaten should take its handicap back before anything else
// happens, and never past zero.
func TestLosingReturnsTheHandicapAndStopsAtZero(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{
		Difficulty: "hard", StrengthLevel: 7, GlobalHandicap: 1,
	}}
	history := make([]botbrain.MatchEntry, 0, 10)
	for i := 0; i < 10; i++ {
		history = append(history, botbrain.MatchEntry{ID: string(rune('a' + i)), Result: "loss"})
	}
	ComputePlayTuning(brain, history)
	if got := brain.PlayTuning.GlobalHandicap; got != 0 {
		t.Fatalf("handicap not returned: got %d, want 0", got)
	}
	ComputePlayTuning(brain, history)
	if got := brain.PlayTuning.GlobalHandicap; got != 0 {
		t.Fatalf("handicap went negative: got %d", got)
	}
}

// One player's results must not set another player's difficulty — the flaw the
// single global dial had.
func TestHandicapsAreIndependentPerOpponent(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{PlayTuning: &botbrain.PlayTuning{StrengthLevel: 7}}
	var history []botbrain.MatchEntry
	for i := 0; i < 8; i++ { // the bot dominates this player
		history = append(history, botbrain.MatchEntry{
			ID: "w" + string(rune('a'+i)), Result: "win", OpponentUserID: "child",
		})
	}
	for i := 0; i < 8; i++ { // and is beaten by this one
		history = append(history, botbrain.MatchEntry{
			ID: "l" + string(rune('a'+i)), Result: "loss", OpponentUserID: "adult",
		})
	}
	ComputePlayTuning(brain, history)

	child := brain.OpponentDossiers["child"].Handicap
	adult := brain.OpponentDossiers["adult"].Handicap
	if child <= adult {
		t.Fatalf("the dominated player should get the bigger handicap: child=%d adult=%d", child, adult)
	}
	if adult != 0 {
		t.Fatalf("a player who beats the bot should face full strength: got %d", adult)
	}
}

// A player the bot barely knows falls back to the global dial rather than
// getting a handicap invented from two games.
func TestUnknownOpponentUsesTheGlobalHandicap(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{
		PlayTuning:       &botbrain.PlayTuning{StrengthLevel: 7, GlobalHandicap: 2},
		OpponentDossiers: map[string]*botbrain.OpponentDossier{
			"rare": {OpponentUserID: "rare", GamesPlayed: 2, Handicap: 5},
		},
	}
	if got := HandicapFor(brain, "rare"); got != 2 {
		t.Fatalf("thin history should fall back to global: got %d, want 2", got)
	}
	if got := HandicapFor(brain, "never-met"); got != 2 {
		t.Fatalf("stranger should get the global handicap: got %d, want 2", got)
	}
}

func TestEffectiveLevelStaysOnTheLadder(t *testing.T) {
	t.Parallel()

	if got := EffectiveLevel(3, 9); got != 1 {
		t.Fatalf("floor: got %d, want 1", got)
	}
	if got := EffectiveLevel(10, 0); got != 10 {
		t.Fatalf("ceiling: got %d, want 10", got)
	}
	if got := EffectiveLevel(7, 2); got != 5 {
		t.Fatalf("normal: got %d, want 5", got)
	}
}

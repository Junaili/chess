package trainer

import (
	"testing"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// The served rung depends on who is about to play, so two players with
// different histories must resolve differently from the same brain. (The
// endpoint keys its cache by bot AND opponent for this reason; keying by bot
// alone would hand one player's handicap to the next player through the door.)
func TestSameBrainResolvesDifferentlyPerOpponent(t *testing.T) {
	t.Parallel()

	brain := &botbrain.Brain{
		PlayTuning: &botbrain.PlayTuning{StrengthLevel: 8, GlobalHandicap: 1},
		OpponentDossiers: map[string]*botbrain.OpponentDossier{
			"child": {OpponentUserID: "child", GamesPlayed: 30, Handicap: 4},
			"adult": {OpponentUserID: "adult", GamesPlayed: 30, Handicap: 0},
		},
	}

	child := EffectiveLevel(brain.PlayTuning.StrengthLevel, HandicapFor(brain, "child"))
	adult := EffectiveLevel(brain.PlayTuning.StrengthLevel, HandicapFor(brain, "adult"))
	stranger := EffectiveLevel(brain.PlayTuning.StrengthLevel, HandicapFor(brain, ""))

	if child != 4 {
		t.Errorf("child effective level: got %d, want 4", child)
	}
	if adult != 8 {
		t.Errorf("adult effective level: got %d, want 8", adult)
	}
	if stranger != 7 {
		t.Errorf("stranger should use the global handicap: got %d, want 7", stranger)
	}
	if child == adult {
		t.Fatal("two very different opponents resolved to the same level")
	}
}

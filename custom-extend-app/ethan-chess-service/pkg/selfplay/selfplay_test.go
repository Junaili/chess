package selfplay

import (
	"testing"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/chessreplay"
)

func testBot() *botbrain.Bot {
	return &botbrain.Bot{
		ID:    "gambit-gus",
		Style: []byte(`{"aggression":0.85,"king_attack_focus":0.8,"risk_tolerance":0.8}`),
		Brain: &botbrain.Brain{BotID: "gambit-gus"},
	}
}

func TestPlayGamesProducesValidGames(t *testing.T) {
	bot := testBot()
	games := PlayGames(bot, 4, 42)

	if len(games) != 4 {
		t.Fatalf("got %d games, want 4", len(games))
	}

	validResults := map[string]bool{"win": true, "loss": true, "draw": true}
	for i, e := range games {
		if e.Mode != "self-play" {
			t.Errorf("game %d mode = %q, want self-play", i, e.Mode)
		}
		if len(e.Moves) == 0 {
			t.Errorf("game %d has no moves", i)
		}
		if !validResults[e.Result] {
			t.Errorf("game %d result = %q, want win/loss/draw", i, e.Result)
		}
		// The bot must be exactly one of the named players.
		if e.WhiteName != bot.ID && e.BlackName != bot.ID {
			t.Errorf("game %d: bot %q is neither white (%q) nor black (%q)", i, bot.ID, e.WhiteName, e.BlackName)
		}

		// Round-trip: every generated move must replay legally.
		g, err := chessreplay.Reconstruct(e, bot.ID)
		if err != nil {
			t.Errorf("game %d replay error: %v", i, err)
		}
		if g.Truncated {
			t.Errorf("game %d produced an illegal move (truncated on replay)", i)
		}
		if g.PlyCount != len(e.Moves) {
			t.Errorf("game %d: replay plies %d != stored moves %d", i, g.PlyCount, len(e.Moves))
		}
		if g.BotColor == "" {
			t.Errorf("game %d: replay could not infer bot color", i)
		}
	}
}

func TestPlayGamesDeterministicBySeed(t *testing.T) {
	a := PlayGames(testBot(), 2, 7)
	b := PlayGames(testBot(), 2, 7)
	if len(a[0].Moves) != len(b[0].Moves) {
		t.Fatalf("same seed produced different games: %d vs %d moves", len(a[0].Moves), len(b[0].Moves))
	}
}

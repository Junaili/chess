package selfplay

import (
	"math"
	"math/rand"
	"testing"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/chessreplay"
	"github.com/notnil/chess"
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

func TestPickMoveMatchesChildPositionScoring(t *testing.T) {
	styles := []styleParams{
		neutralStyle(),
		parseStyle(testBot().Style),
		{aggression: 0.1, kingAttack: 0.9, temperature: 0},
	}
	for styleIndex, style := range styles {
		game := chess.NewGame()
		optimizedRNG := rand.New(rand.NewSource(int64(100 + styleIndex)))
		legacyRNG := rand.New(rand.NewSource(int64(100 + styleIndex)))
		for ply := 0; ply < 150 && game.Outcome() == chess.NoOutcome; ply++ {
			pos := game.Position()
			got := pickMove(pos, style, optimizedRNG)
			want := legacyPickMove(pos, style, legacyRNG)
			if got == nil || want == nil {
				if got != want {
					t.Fatalf("style %d ply %d: optimized move %v, legacy move %v", styleIndex, ply, got, want)
				}
				break
			}
			if got.String() != want.String() {
				t.Fatalf("style %d ply %d: optimized move %s, legacy move %s", styleIndex, ply, got, want)
			}
			if err := game.Move(got); err != nil {
				t.Fatalf("style %d ply %d: move %s: %v", styleIndex, ply, got, err)
			}
		}
	}
}

// legacyPickMove keeps the former child-position scoring in tests so the
// allocation-free delta implementation remains behaviorally equivalent.
func legacyPickMove(pos *chess.Position, st styleParams, rng *rand.Rand) *chess.Move {
	moves := pos.ValidMoves()
	if len(moves) == 0 {
		return nil
	}
	mover := pos.Turn()
	best := math.Inf(-1)
	var chosen *chess.Move
	for _, move := range moves {
		score := float64(materialScore(pos.Update(move), mover))
		if move.HasTag(chess.Capture) {
			score += st.aggression * 30
		}
		if move.HasTag(chess.Check) {
			score += st.aggression*40 + st.kingAttack*30
		}
		score += rng.NormFloat64() * st.temperature
		if score > best {
			best = score
			chosen = move
		}
	}
	return chosen
}

var benchmarkMove *chess.Move

func BenchmarkMovePicker(b *testing.B) {
	pos := chess.NewGame().Position()
	style := parseStyle(testBot().Style)
	b.Run("optimized", func(b *testing.B) {
		rng := rand.New(rand.NewSource(42))
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			benchmarkMove = pickMove(pos, style, rng)
		}
	})
	b.Run("legacy-child-positions", func(b *testing.B) {
		rng := rand.New(rand.NewSource(42))
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			benchmarkMove = legacyPickMove(pos, style, rng)
		}
	})
}

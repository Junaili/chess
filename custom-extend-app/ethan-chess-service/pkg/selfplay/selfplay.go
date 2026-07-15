// Package selfplay generates the bot's own games so the trainer has something to
// learn from — the "body" for the cold-start loop, with no WebRTC and no human
// needed. The bot plays a sparring partner using a lightweight, style-biased
// move picker; each completed game is emitted in the same chess-match-history
// shape the app records, ready to store in AGS and feed back to the trainer.
package selfplay

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"time"

	"github.com/notnil/chess"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

const maxPlies = 300

var pieceCentipawns = [...]int{
	chess.NoPieceType: 0,
	chess.King:        0,
	chess.Queen:       900,
	chess.Rook:        500,
	chess.Bishop:      330,
	chess.Knight:      320,
	chess.Pawn:        100,
}

var materialPiecePairs = [...]struct {
	white, black chess.Piece
	value        int
}{
	{chess.WhiteQueen, chess.BlackQueen, 900},
	{chess.WhiteRook, chess.BlackRook, 500},
	{chess.WhiteBishop, chess.BlackBishop, 330},
	{chess.WhiteKnight, chess.BlackKnight, 320},
	{chess.WhitePawn, chess.BlackPawn, 100},
}

// styleParams are the move-picker knobs derived from a bot's style.json.
type styleParams struct {
	aggression  float64 // bonus for captures
	kingAttack  float64 // bonus for checks
	temperature float64 // centipawn noise for variety
}

func parseStyle(raw []byte) styleParams {
	var s struct {
		Aggression      float64 `json:"aggression"`
		KingAttackFocus float64 `json:"king_attack_focus"`
		RiskTolerance   float64 `json:"risk_tolerance"`
	}
	_ = json.Unmarshal(raw, &s)
	sp := styleParams{
		aggression:  s.Aggression,
		kingAttack:  s.KingAttackFocus,
		temperature: 25 + s.RiskTolerance*60,
	}
	if sp.aggression == 0 {
		sp.aggression = 0.5
	}
	if sp.kingAttack == 0 {
		sp.kingAttack = 0.3
	}
	return sp
}

func neutralStyle() styleParams {
	return styleParams{aggression: 0.45, kingAttack: 0.25, temperature: 45}
}

// Picker is a reusable move picker with style.json parsed once. Live sessions
// should keep one Picker instead of decoding the same JSON on every turn.
type Picker struct {
	style styleParams
}

// NewPicker creates a reusable move picker for the supplied style.json.
func NewPicker(styleJSON []byte) Picker {
	return Picker{style: parseStyle(styleJSON)}
}

// ChooseMove returns a move for pos, or nil when there are no legal moves.
func (p Picker) ChooseMove(pos *chess.Position, rng *rand.Rand) *chess.Move {
	return pickMove(pos, p.style, rng)
}

// materialScore is centipawn material balance from persp's point of view.
func materialScore(pos *chess.Position, persp chess.Color) int {
	board := pos.Board()
	whiteScore := 0
	for _, pair := range materialPiecePairs {
		whiteScore += pair.value * (board.PieceCount(pair.white) - board.PieceCount(pair.black))
	}
	if persp == chess.Black {
		return -whiteScore
	}
	return whiteScore
}

// moveMaterialDelta returns the centipawn change from the mover's perspective.
// All legal moves share the current material score, so comparing this delta is
// equivalent to allocating and evaluating a child Position for every move.
func moveMaterialDelta(board *chess.Board, move *chess.Move) int {
	delta := 0
	if move.HasTag(chess.EnPassant) {
		delta += pieceCentipawns[chess.Pawn]
	} else if move.HasTag(chess.Capture) {
		delta += pieceCentipawns[board.Piece(move.S2()).Type()]
	}
	if promo := move.Promo(); promo != chess.NoPieceType {
		delta += pieceCentipawns[promo] - pieceCentipawns[chess.Pawn]
	}
	return delta
}

// pickMove does a greedy 1-ply material search biased by style (captures, checks)
// plus a little noise so games vary.
func pickMove(pos *chess.Position, st styleParams, rng *rand.Rand) *chess.Move {
	moves := pos.ValidMoves()
	if len(moves) == 0 {
		return nil
	}
	mover := pos.Turn()
	baseMaterial := materialScore(pos, mover)
	board := pos.Board()
	best := math.Inf(-1)
	var chosen *chess.Move
	for _, mv := range moves {
		score := float64(baseMaterial + moveMaterialDelta(board, mv))
		if mv.HasTag(chess.Capture) {
			score += st.aggression * 30
		}
		if mv.HasTag(chess.Check) {
			score += st.aggression*40 + st.kingAttack*30
		}
		score += rng.NormFloat64() * st.temperature
		if score > best {
			best = score
			chosen = mv
		}
	}
	return chosen
}

// ChooseMove returns the bot's move for the current position using the given
// style.json knobs, or nil if the game is over. This is the move-selection entry
// point a live opponent (e.g. the AMS dedicated server) calls each turn.
func ChooseMove(g *chess.Game, styleJSON []byte, rng *rand.Rand) *chess.Move {
	return NewPicker(styleJSON).ChooseMove(g.Position(), rng)
}

func playGame(botSt, sparSt styleParams, botColor chess.Color, rng *rand.Rand) *chess.Game {
	game := chess.NewGame()
	for ply := 0; ply < maxPlies; ply++ {
		if game.Outcome() != chess.NoOutcome {
			break
		}
		pos := game.Position()
		st := sparSt
		if pos.Turn() == botColor {
			st = botSt
		}
		mv := pickMove(pos, st, rng)
		if mv == nil {
			break
		}
		if err := game.Move(mv); err != nil {
			break
		}
	}
	return game
}

// PlayGames plays n self-play games and returns them as match-history entries
// from the bot's perspective. Colors alternate; the bot uses its style.json, the
// sparring partner a neutral style so games are not mirror-symmetric.
func PlayGames(bot *botbrain.Bot, n int, seed int64) []botbrain.MatchEntry {
	rng := rand.New(rand.NewSource(seed))
	botSt := parseStyle(bot.Style)
	sparSt := neutralStyle()

	entries := make([]botbrain.MatchEntry, 0, n)
	now := time.Now()
	for i := 0; i < n; i++ {
		botColor := chess.White
		if i%2 == 1 {
			botColor = chess.Black
		}
		game := playGame(botSt, sparSt, botColor, rng)
		ended := now.Add(time.Duration(i) * time.Second)
		entries = append(entries, toMatchEntry(bot.ID, game, botColor, ended, rng))
	}
	return entries
}

func toMatchEntry(botID string, game *chess.Game, botColor chess.Color, ended time.Time, rng *rand.Rand) botbrain.MatchEntry {
	const sparName = "Sparring Partner"
	white, black := sparName, botID
	if botColor == chess.White {
		white, black = botID, sparName
	}
	return botbrain.MatchEntry{
		ID:           fmt.Sprintf("selfplay-%d-%04d", ended.UnixNano(), rng.Intn(10000)),
		Mode:         "self-play",
		OpponentName: sparName,
		Result:       botResult(game, botColor),
		StartedAt:    ended.Add(-2 * time.Minute).UTC().Format(time.RFC3339),
		EndedAt:      ended.UTC().Format(time.RFC3339),
		DurationMs:   120000,
		WhiteName:    white,
		BlackName:    black,
		Moves:        coordMoves(game.Moves()),
	}
}

func botResult(game *chess.Game, botColor chess.Color) string {
	switch game.Outcome() {
	case chess.WhiteWon:
		if botColor == chess.White {
			return "win"
		}
		return "loss"
	case chess.BlackWon:
		if botColor == chess.Black {
			return "win"
		}
		return "loss"
	case chess.Draw:
		return "draw"
	default:
		// Move cap reached — adjudicate by material.
		m := materialScore(game.Position(), botColor)
		switch {
		case m > 100:
			return "win"
		case m < -100:
			return "loss"
		default:
			return "draw"
		}
	}
}

func coordMoves(moves []*chess.Move) []botbrain.Move {
	out := make([]botbrain.Move, 0, len(moves))
	for _, mv := range moves {
		fr, fc := toCoord(mv.S1())
		tr, tc := toCoord(mv.S2())
		out = append(out, botbrain.Move{Fr: fr, Fc: fc, ToR: tr, ToC: tc, PromType: promoName(mv.Promo())})
	}
	return out
}

// toCoord maps a notnil square to the app's (row, col): row 0 = rank 8.
func toCoord(sq chess.Square) (row, col int) {
	return 7 - int(sq.Rank()), int(sq.File())
}

func promoName(pt chess.PieceType) string {
	switch pt {
	case chess.Rook:
		return "rook"
	case chess.Bishop:
		return "bishop"
	case chess.Knight:
		return "knight"
	default:
		return "queen"
	}
}

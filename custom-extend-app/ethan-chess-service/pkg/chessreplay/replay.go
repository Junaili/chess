// Package chessreplay reconstructs a completed game from the coordinate moves
// stored in the app's chess-match-history into a form an LLM can reason about:
// SAN move list, PGN, final FEN, and the engine-determined outcome. It uses the
// notnil/chess library for correct legality, notation, and end-state detection.
package chessreplay

import (
	"fmt"
	"strings"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/notnil/chess"
)

// Game is a reconstructed game ready for reflection.
type Game struct {
	MatchID       string
	BotColor      string // "white" | "black" | "" (unknown)
	SANs          []string
	PGN           string
	FinalFEN      string
	PlyCount      int
	EngineOutcome string // "1-0" | "0-1" | "1/2-1/2" | "*"
	EngineMethod  string // "Checkmate" | "Stalemate" | "InsufficientMaterial" | ...
	StoredResult  string // result as recorded by the client (may include resign/timeout)
	Truncated     bool   // true if an illegal/corrupt move stopped replay early
}

// square converts the app's board coordinates (row 0 = rank 8, col 0 = file a)
// to a notnil/chess square.
func square(r, c int) chess.Square {
	return chess.NewSquare(chess.File(c), chess.Rank(7-r))
}

var promoByName = map[string]chess.PieceType{
	"queen":  chess.Queen,
	"rook":   chess.Rook,
	"bishop": chess.Bishop,
	"knight": chess.Knight,
}

// Reconstruct replays the stored coordinate moves. botName is matched against the
// recorded white/black names to infer which color the bot played (best effort).
func Reconstruct(m botbrain.MatchEntry, botName string) (*Game, error) {
	g := chess.NewGame()
	enc := chess.AlgebraicNotation{}

	out := &Game{
		MatchID:      m.ID,
		BotColor:     inferColor(m, botName),
		StoredResult: m.Result,
	}

	for i, mv := range m.Moves {
		from := square(mv.Fr, mv.Fc)
		to := square(mv.ToR, mv.ToC)
		promo := promoByName[strings.ToLower(mv.PromType)]

		pos := g.Position()
		chosen := matchMove(pos.ValidMoves(), from, to, promo)
		if chosen == nil {
			// Corrupt/illegal stored move — keep what we have, flag truncation.
			out.Truncated = true
			return finalize(out, g, i), fmt.Errorf("move %d (%v->%v) not legal in position", i+1, from, to)
		}
		out.SANs = append(out.SANs, enc.Encode(pos, chosen))
		if err := g.Move(chosen); err != nil {
			out.Truncated = true
			return finalize(out, g, i), fmt.Errorf("apply move %d: %w", i+1, err)
		}
	}

	return finalize(out, g, len(m.Moves)), nil
}

// matchMove finds the legal move from `from` to `to` (with matching promotion).
func matchMove(valid []*chess.Move, from, to chess.Square, promo chess.PieceType) *chess.Move {
	for _, mv := range valid {
		if mv.S1() != from || mv.S2() != to {
			continue
		}
		// Only constrain promotion when this move actually promotes.
		if mv.Promo() != chess.NoPieceType && promo != chess.NoPieceType && mv.Promo() != promo {
			continue
		}
		return mv
	}
	return nil
}

func finalize(out *Game, g *chess.Game, ply int) *Game {
	out.PlyCount = ply
	out.PGN = strings.TrimSpace(g.String())
	out.FinalFEN = g.FEN()
	out.EngineOutcome = string(g.Outcome())
	out.EngineMethod = g.Method().String()
	return out
}

func inferColor(m botbrain.MatchEntry, botName string) string {
	switch strings.ToLower(strings.TrimSpace(m.BotColor)) {
	case "white":
		return "white"
	case "black":
		return "black"
	}
	if botName == "" {
		return ""
	}
	switch {
	case strings.EqualFold(strings.TrimSpace(botName), strings.TrimSpace(m.WhiteName)):
		return "white"
	case strings.EqualFold(strings.TrimSpace(botName), strings.TrimSpace(m.BlackName)):
		return "black"
	default:
		return ""
	}
}

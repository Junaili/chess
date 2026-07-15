package trainer

// This file provides a small deterministic verifier for Gus's daily notes and
// opening-book promotion. It is deliberately bounded rather than pretending to
// be Stockfish: two-ply material/tactical checks are enough to reject obvious
// blunders, ground the journal in a real position, and keep a scheduled run
// predictable on a small Extend instance.

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/notnil/chess"
)

const (
	// AnalyzerVersion invalidates persisted quality summaries whenever the
	// scoring algorithm changes. Old games are then rebuilt once, not daily.
	AnalyzerVersion     = 1
	analysisDepth       = 2
	analysisMaxNodes    = 3500
	journalRegretMinCP  = 40
	unsoundBookRegretCP = 180
)

var analysisPieceValue = [...]int{
	chess.NoPieceType: 0,
	chess.King:        0,
	chess.Queen:       900,
	chess.Rook:        500,
	chess.Bishop:      330,
	chess.Knight:      320,
	chess.Pawn:        100,
}

var analysisMaterialPairs = [...]struct {
	white, black chess.Piece
	value        int
}{
	{chess.WhiteQueen, chess.BlackQueen, 900},
	{chess.WhiteRook, chess.BlackRook, 500},
	{chess.WhiteBishop, chess.BlackBishop, 330},
	{chess.WhiteKnight, chess.BlackKnight, 320},
	{chess.WhitePawn, chess.BlackPawn, 100},
}

var analysisScratchPool = sync.Pool{
	New: func() any { return new(analysisScratch) },
}

// CriticalMoment is a verified comparison from immediately before one of the
// bot's moves. Scores are centipawns from Gus's perspective.
type CriticalMoment struct {
	MatchID    string `json:"match_id"`
	Ply        int    `json:"ply"`
	MoveNumber int    `json:"move_number"`
	Color      string `json:"color"`
	FEN        string `json:"fen"`
	PlayedSAN  string `json:"played_san"`
	BetterSAN  string `json:"better_san"`
	PlayedCP   int    `json:"played_cp"`
	BetterCP   int    `json:"better_cp"`
	RegretCP   int    `json:"regret_cp"`
}

// GameAnalysis is deterministic evidence used both in the prompt and by the
// candidate/champion opening-book gate.
type GameAnalysis struct {
	MatchID       string
	Moment        *CriticalMoment
	BookRegretCP  int
	AverageRegret float64
	BotMoveCount  int
}

func (a GameAnalysis) Quality() botbrain.MatchQuality {
	return botbrain.MatchQuality{
		AnalyzerVersion: AnalyzerVersion,
		BookRegretCP:    a.BookRegretCP,
		AverageRegret:   a.AverageRegret,
		BotMoveCount:    a.BotMoveCount,
	}
}

func AnalysisFromQuality(matchID string, quality botbrain.MatchQuality) (GameAnalysis, bool) {
	if quality.AnalyzerVersion != AnalyzerVersion || quality.BookRegretCP < 0 || quality.AverageRegret < 0 || quality.BotMoveCount < 0 {
		return GameAnalysis{}, false
	}
	return GameAnalysis{
		MatchID: matchID, BookRegretCP: quality.BookRegretCP,
		AverageRegret: quality.AverageRegret, BotMoveCount: quality.BotMoveCount,
	}, true
}

func AnalyzeAll(pairs []GamePair) map[string]GameAnalysis {
	out := make(map[string]GameAnalysis, len(pairs))
	for _, pair := range pairs {
		out[pair.Entry.ID] = AnalyzeGame(pair)
	}
	return out
}

// PrepareHistoryAnalyses reuses durable summaries and computes only fresh or
// version-stale entries. Critical moments intentionally remain ephemeral: only
// today's newly reviewed games need them for the public journal/model prompt.
func PrepareHistoryAnalyses(brain *botbrain.Brain, pairs []GamePair, fresh map[string]GameAnalysis) (map[string]GameAnalysis, int) {
	if brain.MatchQuality == nil {
		brain.MatchQuality = map[string]botbrain.MatchQuality{}
	}
	analyses := make(map[string]GameAnalysis, len(pairs))
	retained := make(map[string]bool, len(pairs))
	analyzed := 0
	for _, pair := range pairs {
		id := pair.Entry.ID
		retained[id] = true
		analysis, ok := fresh[id]
		if !ok {
			analysis, ok = AnalysisFromQuality(id, brain.MatchQuality[id])
		}
		if !ok {
			analysis = AnalyzeGame(pair)
			analyzed++
		} else if _, wasFresh := fresh[id]; wasFresh {
			analyzed++
		}
		analyses[id] = analysis
		brain.MatchQuality[id] = analysis.Quality()
	}
	for id := range brain.MatchQuality {
		if !retained[id] {
			delete(brain.MatchQuality, id)
		}
	}
	return analyses, analyzed
}

// SelectReflectionPairs bounds model input while retaining the most useful
// evidence: large verified regrets first, then losses/draws, then recency.
func SelectReflectionPairs(pairs []GamePair, analyses map[string]GameAnalysis, limit int) []GamePair {
	selected := append([]GamePair(nil), pairs...)
	sort.SliceStable(selected, func(i, k int) bool {
		left, right := analyses[selected[i].Entry.ID].Moment, analyses[selected[k].Entry.ID].Moment
		if (left != nil) != (right != nil) {
			return left != nil
		}
		if left != nil && right != nil && left.RegretCP != right.RegretCP {
			return left.RegretCP > right.RegretCP
		}
		leftRank, rightRank := reflectionOutcomeRank(selected[i].Entry.Result), reflectionOutcomeRank(selected[k].Entry.Result)
		if leftRank != rightRank {
			return leftRank > rightRank
		}
		leftTime, rightTime := selected[i].Entry.EndedAtTime(), selected[k].Entry.EndedAtTime()
		if !leftTime.Equal(rightTime) {
			return leftTime.After(rightTime)
		}
		return selected[i].Entry.ID < selected[k].Entry.ID
	})
	if limit > 0 && len(selected) > limit {
		selected = selected[:limit]
	}
	return selected
}

func reflectionOutcomeRank(result string) int {
	switch strings.ToLower(strings.TrimSpace(result)) {
	case "loss":
		return 3
	case "draw":
		return 2
	case "win":
		return 1
	default:
		return 0
	}
}

func AnalyzeGame(pair GamePair) GameAnalysis {
	result := GameAnalysis{MatchID: pair.Entry.ID}
	color := pair.Game.BotColor
	if color == "" {
		color = strings.ToLower(pair.Entry.BotColor)
	}
	botColor, ok := parseColor(color)
	if !ok {
		return result
	}

	game := chess.NewGame()
	enc := chess.AlgebraicNotation{}
	scratch := analysisScratchPool.Get().(*analysisScratch)
	*scratch = analysisScratch{}
	defer func() {
		// Drop cached move slices before pooling so a quiet trainer does not retain
		// the last search tree between scheduled runs.
		*scratch = analysisScratch{}
		analysisScratchPool.Put(scratch)
	}()
	var worst *CriticalMoment
	var regretTotal int
	for ply, stored := range pair.Entry.Moves {
		pos := game.Position()
		played := findStoredMove(pos, stored)
		if played == nil {
			break
		}
		if pos.Turn() == botColor {
			best, bestScore := bestMoveScore(pos, botColor, analysisDepth,
				&analysisBudget{remaining: analysisMaxNodes}, scratch)
			// Use an independent budget so the played move and candidate move are
			// compared at the same bounded depth even in unusually wide positions.
			playedPosition := scratch.update(pos, played, 0)
			playedScore := boundedMinimax(playedPosition, botColor, analysisDepth-1,
				&analysisBudget{remaining: analysisMaxNodes}, math.MinInt/4, math.MaxInt/4, scratch, 1)
			regret := bestScore - playedScore
			if regret < 0 { // node caps can make partial bounds slightly noisy
				regret = 0
			}
			result.BotMoveCount++
			regretTotal += regret
			if ply < 12 && regret > result.BookRegretCP {
				result.BookRegretCP = regret
			}
			if best != nil && (worst == nil || regret > worst.RegretCP) {
				worst = &CriticalMoment{
					MatchID: pair.Entry.ID, Ply: ply + 1, MoveNumber: ply/2 + 1,
					Color: color, FEN: pos.String(), PlayedSAN: enc.Encode(pos, played),
					BetterSAN: enc.Encode(pos, best), PlayedCP: playedScore,
					BetterCP: bestScore, RegretCP: regret,
				}
			}
		}
		if err := game.Move(played); err != nil {
			break
		}
	}
	if result.BotMoveCount > 0 {
		result.AverageRegret = float64(regretTotal) / float64(result.BotMoveCount)
	}
	if worst != nil && worst.RegretCP >= journalRegretMinCP && worst.PlayedSAN != worst.BetterSAN {
		result.Moment = worst
	}
	return result
}

func parseColor(v string) (chess.Color, bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "white":
		return chess.White, true
	case "black":
		return chess.Black, true
	default:
		return chess.NoColor, false
	}
}

func findStoredMove(pos *chess.Position, stored botbrain.Move) *chess.Move {
	from := chess.NewSquare(chess.File(stored.Fc), chess.Rank(7-stored.Fr))
	to := chess.NewSquare(chess.File(stored.ToC), chess.Rank(7-stored.ToR))
	wantedPromo := promoType(stored.PromType)
	for _, move := range pos.ValidMoves() {
		if move.S1() != from || move.S2() != to {
			continue
		}
		if move.Promo() != chess.NoPieceType && wantedPromo != chess.NoPieceType && move.Promo() != wantedPromo {
			continue
		}
		return move
	}
	return nil
}

func promoType(name string) chess.PieceType {
	switch strings.ToLower(name) {
	case "rook":
		return chess.Rook
	case "bishop":
		return chess.Bishop
	case "knight":
		return chess.Knight
	case "queen":
		return chess.Queen
	default:
		return chess.NoPieceType
	}
}

type analysisBudget struct{ remaining int }

// analysisScratch owns one child position per search ply. The bounded minimax
// visits one branch at a time, so a slot can be reused as soon as that branch
// returns instead of allocating a Position and Board for every node.
type analysisScratch struct {
	positions [analysisDepth + 1]chess.Position
	boards    [analysisDepth + 1]chess.Board
}

func (s *analysisScratch) update(pos *chess.Position, move *chess.Move, ply int) *chess.Position {
	pos.UpdateInto(&s.positions[ply], &s.boards[ply], move)
	return &s.positions[ply]
}

func bestMoveScore(pos *chess.Position, perspective chess.Color, depth int, budget *analysisBudget, scratch *analysisScratch) (*chess.Move, int) {
	moves := pos.ValidMoves()
	if len(moves) == 0 {
		return nil, evaluatePosition(pos, perspective)
	}
	maximize := pos.Turn() == perspective
	bestScore := math.MaxInt / 4
	if maximize {
		bestScore = math.MinInt / 4
	}
	var best *chess.Move
	for _, move := range orderedMoves(pos, moves) {
		child := scratch.update(pos, move, 0)
		score := boundedMinimax(child, perspective, depth-1, budget,
			math.MinInt/4, math.MaxInt/4, scratch, 1)
		if best == nil || (maximize && score > bestScore) || (!maximize && score < bestScore) {
			best, bestScore = move, score
		}
		if budget.remaining <= 0 {
			break
		}
	}
	return best, bestScore
}

func boundedMinimax(pos *chess.Position, perspective chess.Color, depth int, budget *analysisBudget, alpha, beta int, scratch *analysisScratch, ply int) int {
	if budget.remaining <= 0 {
		return evaluatePosition(pos, perspective)
	}
	budget.remaining--
	if depth <= 0 {
		return evaluatePosition(pos, perspective)
	}
	if status := pos.Status(); status != chess.NoMethod {
		return evaluatePositionWithStatus(pos, perspective, status)
	}
	moves := pos.ValidMoves()
	if len(moves) == 0 {
		return evaluatePosition(pos, perspective)
	}
	if pos.Turn() == perspective {
		best := math.MinInt / 4
		for _, move := range orderedMoves(pos, moves) {
			child := scratch.update(pos, move, ply)
			v := boundedMinimax(child, perspective, depth-1, budget, alpha, beta, scratch, ply+1)
			if v > best {
				best = v
			}
			if best > alpha {
				alpha = best
			}
			if beta <= alpha || budget.remaining <= 0 {
				break
			}
		}
		return best
	}
	best := math.MaxInt / 4
	for _, move := range orderedMoves(pos, moves) {
		child := scratch.update(pos, move, ply)
		v := boundedMinimax(child, perspective, depth-1, budget, alpha, beta, scratch, ply+1)
		if v < best {
			best = v
		}
		if best < beta {
			beta = best
		}
		if beta <= alpha || budget.remaining <= 0 {
			break
		}
	}
	return best
}

func evaluatePosition(pos *chess.Position, perspective chess.Color) int {
	return evaluatePositionWithStatus(pos, perspective, pos.Status())
}

func evaluatePositionWithStatus(pos *chess.Position, perspective chess.Color, status chess.Method) int {
	if status == chess.Checkmate {
		if pos.Turn() == perspective {
			return -100000
		}
		return 100000
	}
	if status != chess.NoMethod {
		return 0
	}
	board := pos.Board()
	whiteScore := 0
	for _, pair := range analysisMaterialPairs {
		whiteScore += pair.value * (board.PieceCount(pair.white) - board.PieceCount(pair.black))
	}
	if perspective == chess.Black {
		return -whiteScore
	}
	return whiteScore
}

func orderedMoves(pos *chess.Position, moves []*chess.Move) []*chess.Move {
	// Position.ValidMoves already returns a defensive slice copy, so sorting it
	// in place avoids another allocation. Cache each priority because insertion
	// sort otherwise recalculates board lookups for every comparison.
	var priorities [256]int // the legal-move maximum in chess is 218
	if len(moves) > len(priorities) {
		// Defensive fallback for malformed/non-chess callers.
		for i := 1; i < len(moves); i++ {
			for j := i; j > 0 && movePriority(pos, moves[j]) > movePriority(pos, moves[j-1]); j-- {
				moves[j], moves[j-1] = moves[j-1], moves[j]
			}
		}
		return moves
	}
	priority := priorities[:len(moves)]
	for i, move := range moves {
		priority[i] = movePriority(pos, move)
	}
	for i := 1; i < len(moves); i++ {
		for j := i; j > 0 && priority[j] > priority[j-1]; j-- {
			moves[j], moves[j-1] = moves[j-1], moves[j]
			priority[j], priority[j-1] = priority[j-1], priority[j]
		}
	}
	return moves
}

func movePriority(pos *chess.Position, move *chess.Move) int {
	priority := 0
	if move.HasTag(chess.Capture) {
		if captured := pos.Board().Piece(move.S2()); captured != chess.NoPiece {
			priority += analysisPieceValue[captured.Type()] + 1000
		}
	}
	if move.HasTag(chess.Check) {
		priority += 500
	}
	if move.Promo() != chess.NoPieceType {
		priority += analysisPieceValue[move.Promo()]
	}
	return priority
}

func momentSentence(moment *CriticalMoment) string {
	if moment == nil {
		return "No clear tactical regression crossed the bounded review threshold."
	}
	return fmt.Sprintf("On move %d as %s, %s scored %.1f pawns below %s in the bounded tactical check.",
		moment.MoveNumber, moment.Color, moment.PlayedSAN, float64(moment.RegretCP)/100, moment.BetterSAN)
}

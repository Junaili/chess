package trainer

import (
	"encoding/json"
	"sort"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

const (
	bookMaxPlies    = 8   // opening-line depth stored in the play book
	bookMaxLines    = 12  // strongest lines kept
	tuningMinGames  = 5   // don't calibrate difficulty on tiny samples
	winRateHigh     = 0.65
	winRateLow      = 0.35
	defaultThinkMs  = 1400
	minThinkMs      = 700
	maxThinkMs      = 2600
	maxShufflePlies = 120
)

var difficultyLadder = []string{"easy", "medium", "hard"}

// ComputePlayTuning derives the play-affecting knobs deterministically from the
// bot's recent games (bot-perspective results). It mutates brain.PlayTuning:
//
//   - difficulty: nudged one step per training run toward a ~50% win rate
//   - think time: mean/jitter approximating the observed pace of its games
//   - book: opening lines (coordinate form) from games that scored well
func ComputePlayTuning(brain *botbrain.Brain, recent []botbrain.MatchEntry) {
	t := brain.PlayTuning
	if t == nil {
		t = &botbrain.PlayTuning{Difficulty: "medium", ThinkMsMean: defaultThinkMs, ThinkMsJitter: defaultThinkMs / 2}
		brain.PlayTuning = t
	}
	if t.MaxShufflePlies == 0 {
		t.MaxShufflePlies = maxShufflePlies
	}

	// Trailing score: win=1, draw=0.5 over decisive+drawn games.
	var played, score float64
	for _, m := range recent {
		switch m.Result {
		case "win":
			played, score = played+1, score+1
		case "draw":
			played, score = played+1, score+0.5
		case "loss":
			played++
		}
	}
	if played > 0 {
		t.WinRate = score / played
	}

	// Difficulty auto-calibration: too strong → step down, too weak → step up.
	if played >= tuningMinGames {
		idx := indexOf(difficultyLadder, t.Difficulty)
		if idx < 0 {
			idx = 1 // medium
		}
		switch {
		case t.WinRate > winRateHigh && idx > 0:
			idx--
		case t.WinRate < winRateLow && idx < len(difficultyLadder)-1:
			idx++
		}
		t.Difficulty = difficultyLadder[idx]
	}

	// Think time: approximate the observed pace (duration / plies), clamped to a
	// human-feeling band.
	var msSum, plySum int64
	for _, m := range recent {
		if m.DurationMs > 0 && len(m.Moves) >= 6 {
			msSum += m.DurationMs
			plySum += int64(len(m.Moves))
		}
	}
	if plySum > 0 {
		mean := int(msSum / plySum)
		if mean < minThinkMs {
			mean = minThinkMs
		}
		if mean > maxThinkMs {
			mean = maxThinkMs
		}
		t.ThinkMsMean = mean
		t.ThinkMsJitter = mean * 6 / 10
	}

	// Opening book: merge this window's good lines into the existing book.
	type agg struct {
		moves  []botbrain.Move
		weight float64
	}
	lines := map[string]*agg{}
	for _, b := range t.Book { // start from what we already know
		lines[bookKey(b.Moves)] = &agg{moves: b.Moves, weight: b.Weight}
	}
	for _, m := range recent {
		var w float64
		switch m.Result {
		case "win":
			w = 1
		case "draw":
			w = 0.5
		default:
			continue
		}
		n := len(m.Moves)
		if n > bookMaxPlies {
			n = bookMaxPlies
		}
		if n < 4 {
			continue // too short to be a "line"
		}
		prefix := m.Moves[:n]
		k := bookKey(prefix)
		if a, ok := lines[k]; ok {
			a.weight += w
		} else {
			lines[k] = &agg{moves: prefix, weight: w}
		}
	}
	all := make([]*agg, 0, len(lines))
	for _, a := range lines {
		all = append(all, a)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].weight > all[j].weight })
	if len(all) > bookMaxLines {
		all = all[:bookMaxLines]
	}
	t.Book = t.Book[:0]
	for _, a := range all {
		t.Book = append(t.Book, botbrain.BookLine{Moves: a.moves, Weight: a.weight})
	}
}

func bookKey(moves []botbrain.Move) string {
	b, _ := json.Marshal(moves)
	return string(b)
}

func indexOf(ss []string, s string) int {
	for i, v := range ss {
		if v == s {
			return i
		}
	}
	return -1
}

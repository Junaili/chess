package trainer

import (
	"strings"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// Strength and fairness are different questions and were previously answered by
// one dial, which is why the bots could never improve: the only lever that
// moved was difficulty, and it moved DOWN whenever the bot did well.
//
//	StrengthLevel — how well this bot can play. Earned, and only upward.
//	Handicap      — how many rungs it gives away to a particular player.
//	effective     = StrengthLevel - handicap, clamped to the ladder.
//
// A handicap is per-opponent so that a strong adult and a seven-year-old can
// share a bot without either deciding the other's difficulty. Players with too
// little history fall back to the global handicap, which behaves like the old
// single dial.
const (
	handicapMinGames = 5    // don't judge a player on a couple of games
	handicapWindow   = 20   // recent games considered, per opponent
	handicapWinHigh  = 0.65 // bot winning this much: give away another rung
	handicapWinLow   = 0.35 // bot losing this much: take a rung back
	maxHandicap      = 6    // never hand away so much that the bot stops playing chess
)

// EffectiveLevel is the rung actually played after the handicap is applied.
func EffectiveLevel(strength, handicap int) int {
	level := strength - handicap
	if level < minStrengthLevel {
		return minStrengthLevel
	}
	if level > maxStrengthLevel {
		return maxStrengthLevel
	}
	return level
}

// scoreOf returns the bot's score and whether the game was decisive.
func scoreOf(result string) (float64, bool) {
	switch normalizedResult(result) {
	case "win":
		return 1, true
	case "draw":
		return 0.5, true
	case "loss":
		return 0, true
	}
	return 0, false
}

// adjustHandicap nudges one rung at a time toward an even game. Single steps
// keep the change legible to a player: a bot that suddenly drops three rungs
// reads as broken, not as considerate.
func adjustHandicap(current int, botScore float64, played int) int {
	if played < handicapMinGames {
		return current
	}
	rate := botScore / float64(played)
	switch {
	case rate > handicapWinHigh:
		current++
	case rate < handicapWinLow:
		current--
	}
	if current < 0 {
		return 0
	}
	if current > maxHandicap {
		return maxHandicap
	}
	return current
}

// UpdateHandicaps recomputes the global handicap and every recurring
// opponent's, from the bot's own history. Returns the number of opponents whose
// handicap moved, for the training journal.
func UpdateHandicaps(brain *botbrain.Brain, history []botbrain.MatchEntry) int {
	if brain.PlayTuning == nil {
		return 0
	}

	// Global: the trailing window across everyone, used for strangers.
	recent := history
	if len(recent) > handicapWindow {
		recent = recent[len(recent)-handicapWindow:]
	}
	var globalScore float64
	var globalPlayed int
	for _, m := range recent {
		if s, ok := scoreOf(m.Result); ok {
			globalScore += s
			globalPlayed++
		}
	}
	brain.PlayTuning.GlobalHandicap = adjustHandicap(brain.PlayTuning.GlobalHandicap, globalScore, globalPlayed)

	// Per opponent: only the games that player actually played.
	type tally struct {
		score  float64
		played int
	}
	byOpponent := map[string]*tally{}
	for _, m := range history {
		id := strings.TrimSpace(m.OpponentUserID)
		if id == "" {
			continue
		}
		s, ok := scoreOf(m.Result)
		if !ok {
			continue
		}
		t := byOpponent[id]
		if t == nil {
			t = &tally{}
			byOpponent[id] = t
		}
		t.score += s
		t.played++
	}

	if brain.OpponentDossiers == nil {
		brain.OpponentDossiers = map[string]*botbrain.OpponentDossier{}
	}
	moved := 0
	for id, t := range byOpponent {
		dossier := brain.OpponentDossiers[id]
		if dossier == nil {
			// A player the bot has met but never written a dossier for still gets
			// a fair game; the dossier's prose is filled in elsewhere.
			dossier = &botbrain.OpponentDossier{OpponentUserID: id}
			brain.OpponentDossiers[id] = dossier
		}
		before := dossier.Handicap
		dossier.Handicap = adjustHandicap(before, t.score, t.played)
		if dossier.Handicap != before {
			moved++
		}
	}
	return moved
}

// HandicapFor returns the rungs to give away against this player, falling back
// to the global handicap for someone the bot has not played enough.
func HandicapFor(brain *botbrain.Brain, opponentUserID string) int {
	if brain == nil || brain.PlayTuning == nil {
		return 0
	}
	id := strings.TrimSpace(opponentUserID)
	if id != "" && brain.OpponentDossiers != nil {
		if d := brain.OpponentDossiers[id]; d != nil && d.GamesPlayed >= handicapMinGames {
			return d.Handicap
		}
	}
	return brain.PlayTuning.GlobalHandicap
}

// legacyDifficultyForLevel names a rung for DS builds that predate levels, so
// an old bot still gets a sensible opponent instead of a frozen one.
func legacyDifficultyForLevel(level int) string {
	switch {
	case level <= 2:
		return "easy"
	case level <= 5:
		return "medium"
	default:
		return "hard"
	}
}

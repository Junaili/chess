package trainer

import (
	"sort"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// Promotion is the mechanism that makes "trains daily and improves" true of the
// bot's chess rather than only its opening prep. It moves StrengthLevel, and it
// moves it on MOVE QUALITY, not on results: win rate measures the opponent as
// much as the bot, so a bot that meets a stronger player would otherwise be
// punished for it.
//
// Quality is the median centipawn loss per bot move, never the mean. Measured
// on the live brains, Gus's regret runs median 85 / mean 4399 / max 39936: one
// mating blunder produces a five-figure value, so a mean-based bar would be
// unreachable forever after a single bad game.
const (
	promotionMinSample = 10 // analysed games needed before any move at all
	promotionWindow    = 20 // most recent games considered
	demotionRuns       = 2  // consecutive bad runs before giving a rung back
	levelHoldDuration  = 7 * 24 * time.Hour
)

// regretCeilingCP is the median regret a bot must play at or below to earn the
// next rung. It tightens as it climbs: a deeper search should blunder less, so
// the same quality does not buy every rung.
func regretCeilingCP(level int) float64 {
	switch {
	case level <= 3:
		return 200
	case level <= 6:
		return 120
	case level <= 8:
		return 80
	default:
		return 60
	}
}

// PromotionOutcome explains a level move, so the journal can say why the bot
// got stronger instead of only that it did.
type PromotionOutcome struct {
	Promoted     bool
	Demoted      bool
	FromLevel    int
	ToLevel      int
	MedianRegret float64
	Sample       int
	Reason       string
}

func medianOf(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

// EvaluatePromotion decides whether the bot earned a rung, gave one back, or
// held. It never lowers the level because of results, and never below a rung
// the bot has held long enough to have proven.
func EvaluatePromotion(brain *botbrain.Brain, history []botbrain.MatchEntry, analyses map[string]GameAnalysis, now time.Time) PromotionOutcome {
	t := brain.PlayTuning
	if t == nil {
		return PromotionOutcome{Reason: "no play tuning"}
	}
	out := PromotionOutcome{FromLevel: t.StrengthLevel, ToLevel: t.StrengthLevel}

	if t.LevelSince == "" {
		t.LevelSince = now.UTC().Format(time.RFC3339)
	}
	// A rung held for a week is banked: a bad spell can cost recent gains but
	// cannot undo the bot's established strength.
	if since, err := time.Parse(time.RFC3339, t.LevelSince); err == nil {
		if now.Sub(since) >= levelHoldDuration && t.StrengthLevel > t.LevelFloor {
			t.LevelFloor = t.StrengthLevel
		}
	}

	recent := history
	if len(recent) > promotionWindow {
		recent = recent[len(recent)-promotionWindow:]
	}
	regrets := make([]float64, 0, len(recent))
	unsoundBook := false
	for _, match := range recent {
		a, ok := analyses[match.ID]
		if !ok || a.BotMoveCount == 0 {
			continue
		}
		regrets = append(regrets, a.AverageRegret)
		if a.BookRegretCP > unsoundBookRegretCP {
			unsoundBook = true
		}
	}
	out.Sample = len(regrets)
	if out.Sample < promotionMinSample {
		out.Reason = "not enough analysed games yet"
		return out
	}

	median := medianOf(regrets)
	t.MedianRegretCP = median
	out.MedianRegret = median
	ceiling := regretCeilingCP(t.StrengthLevel)

	switch {
	case median <= ceiling && !unsoundBook && t.StrengthLevel < maxStrengthLevel:
		t.StrengthLevel++
		t.LevelSince = now.UTC().Format(time.RFC3339)
		t.PoorQualityRuns = 0
		out.Promoted = true
		out.ToLevel = t.StrengthLevel
		out.Reason = "played cleanly enough to earn the next rung"

	case median <= ceiling && unsoundBook:
		// Winning on a trap is not the same as playing well; an opening the
		// analysis calls unsound must not buy a promotion.
		t.PoorQualityRuns = 0
		out.Reason = "quality met the bar but an unsound opening was served"

	case median > ceiling*2:
		t.PoorQualityRuns++
		if t.PoorQualityRuns >= demotionRuns && t.StrengthLevel > t.LevelFloor && t.StrengthLevel > minStrengthLevel {
			t.StrengthLevel--
			t.LevelSince = now.UTC().Format(time.RFC3339)
			t.PoorQualityRuns = 0
			out.Demoted = true
			out.ToLevel = t.StrengthLevel
			out.Reason = "move quality fell well short over consecutive runs"
		} else {
			out.Reason = "move quality is poor; holding for now"
		}

	default:
		t.PoorQualityRuns = 0
		out.Reason = "held: quality is fine but short of the next rung"
	}
	return out
}

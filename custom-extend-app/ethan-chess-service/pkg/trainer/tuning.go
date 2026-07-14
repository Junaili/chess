package trainer

import (
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

const (
	bookMaxPlies       = 8  // opening-line depth stored in the play book
	bookMaxLines       = 12 // strongest verified lines kept
	tuningMinGames     = 5  // don't calibrate difficulty on tiny samples
	tuningWindowGames  = 20 // fairness/pace uses a bounded recent tail
	winRateHigh        = 0.65
	winRateLow         = 0.35
	defaultThinkMs     = 1400
	minThinkMs         = 700
	maxThinkMs         = 2600
	defaultSearchMs    = 220
	maxShufflePlies    = 120
	bookPromotionDelta = 0.01
)

var difficultyLadder = []string{"easy", "medium", "hard"}

// TuningContext supplies deterministic evidence and the authored style. It is
// variadic at the call site to preserve compatibility with offline utilities.
type TuningContext struct {
	Analyses map[string]GameAnalysis
	Style    json.RawMessage
	Now      time.Time
}

// TuningOutcome explains whether a candidate opening book was promoted. A
// daily run can still update pace/fairness without falsely claiming that Gus's
// chess strength improved.
type TuningOutcome struct {
	Promoted       bool
	CandidateScore float64
	ChampionScore  float64
	CandidateLines int
	SampleSize     int
	Reason         string
}

// ComputePlayTuning derives safe play-affecting knobs. The opening book is
// rebuilt from completed history (never incrementally double-counted), checked
// for obvious tactical regret, and promoted only when its evidence score beats
// the current champion or adds material evidence without lowering quality.
func ComputePlayTuning(brain *botbrain.Brain, history []botbrain.MatchEntry, optional ...TuningContext) TuningOutcome {
	ctx := TuningContext{Now: time.Now()}
	if len(optional) > 0 {
		ctx = optional[0]
		if ctx.Now.IsZero() {
			ctx.Now = time.Now()
		}
	}
	t := brain.PlayTuning
	if t == nil {
		t = &botbrain.PlayTuning{
			Difficulty: "medium", ThinkMsMean: defaultThinkMs,
			ThinkMsJitter: defaultThinkMs / 2, SearchBudgetMs: defaultSearchMs,
		}
		brain.PlayTuning = t
	}
	if t.MaxShufflePlies == 0 {
		t.MaxShufflePlies = maxShufflePlies
	}
	if t.SearchBudgetMs <= 0 || t.SearchBudgetMs > 500 {
		t.SearchBudgetMs = defaultSearchMs
	}

	recent := history
	if len(recent) > tuningWindowGames {
		recent = recent[len(recent)-tuningWindowGames:]
	}
	var played, score float64
	for _, match := range recent {
		switch normalizedResult(match.Result) {
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

	// Difficulty is a fairness dial, not the learning promotion metric. Hard is
	// now safe because the Node search has an independent wall-clock deadline.
	if played >= tuningMinGames {
		idx := indexOf(difficultyLadder, t.Difficulty)
		if idx < 0 {
			idx = 1
		}
		switch {
		case t.WinRate > winRateHigh && idx > 0:
			idx--
		case t.WinRate < winRateLow && idx < len(difficultyLadder)-1:
			idx++
		}
		t.Difficulty = difficultyLadder[idx]
	}

	var msSum, plySum int64
	for _, match := range recent {
		if match.DurationMs > 0 && len(match.Moves) >= 6 {
			msSum += match.DurationMs
			plySum += int64(len(match.Moves))
		}
	}
	if plySum > 0 {
		mean := int(msSum / plySum)
		mean = maxInt(minThinkMs, minInt(maxThinkMs, mean))
		t.ThinkMsMean = mean
		t.ThinkMsJitter = mean * 6 / 10
	}
	t.Style = learnedSearchStyle(ctx.Style, recent, ctx.Analyses)

	candidate, candidateScore, sample := buildCandidateBook(history, ctx.Analyses)
	out := TuningOutcome{
		CandidateScore: candidateScore, ChampionScore: t.BookScore,
		CandidateLines: len(candidate), SampleSize: sample,
	}
	if len(candidate) == 0 {
		out.Reason = "no sound completed opening samples"
		return out
	}

	moreEvidence := sample >= t.BookSampleSize+5 && candidateScore >= t.BookScore-0.005
	better := t.BookSampleSize == 0 || candidateScore >= t.BookScore+bookPromotionDelta
	if !better && !moreEvidence {
		out.Reason = "candidate did not beat the current evidence score"
		return out
	}
	t.Book = candidate
	t.BookScore = candidateScore
	t.BookSampleSize = sample
	t.Revision++
	t.PromotedAt = ctx.Now.UTC().Format(time.RFC3339)
	out.Promoted = true
	out.ChampionScore = candidateScore
	if better {
		out.Reason = "candidate improved the opening evidence score"
	} else {
		out.Reason = "candidate added evidence without lowering the evidence score"
	}
	return out
}

type bookAggregate struct {
	moves  []botbrain.Move
	weight float64
	regret int
	result float64
}

func buildCandidateBook(history []botbrain.MatchEntry, analyses map[string]GameAnalysis) ([]botbrain.BookLine, float64, int) {
	lines := map[string]*bookAggregate{}
	var completed, totalScore float64
	var qualityTotal float64
	for _, match := range history {
		var outcome float64
		switch normalizedResult(match.Result) {
		case "win":
			outcome = 1
		case "draw":
			outcome = 0.5
		case "loss":
			outcome = 0
		default:
			continue
		}
		completed++
		totalScore += outcome
		analysis := analyses[match.ID]
		quality := math.Max(0, 1-analysis.AverageRegret/400)
		if analysis.BotMoveCount == 0 {
			quality = 0.5 // legacy record with unknown bot color: don't over-credit it
		}
		qualityTotal += quality
		if outcome == 0 || analysis.BookRegretCP > unsoundBookRegretCP {
			continue
		}
		n := minInt(len(match.Moves), bookMaxPlies)
		if n < 4 {
			continue
		}
		prefix := append([]botbrain.Move(nil), match.Moves[:n]...)
		key := bookKey(prefix)
		weight := outcome * (0.5 + 0.5*quality)
		if aggregate := lines[key]; aggregate != nil {
			aggregate.weight += weight
			aggregate.result += outcome
			if analysis.BookRegretCP > aggregate.regret {
				aggregate.regret = analysis.BookRegretCP
			}
		} else {
			lines[key] = &bookAggregate{moves: prefix, weight: weight, regret: analysis.BookRegretCP, result: outcome}
		}
	}
	if completed == 0 {
		return nil, 0, 0
	}
	all := make([]*bookAggregate, 0, len(lines))
	for _, line := range lines {
		all = append(all, line)
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].weight != all[j].weight {
			return all[i].weight > all[j].weight
		}
		return bookKey(all[i].moves) < bookKey(all[j].moves)
	})
	if len(all) > bookMaxLines {
		all = all[:bookMaxLines]
	}
	book := make([]botbrain.BookLine, 0, len(all))
	for _, line := range all {
		book = append(book, botbrain.BookLine{Moves: line.moves, Weight: line.weight})
	}
	resultRate := (totalScore + 1) / (completed + 2) // Laplace-smoothed
	meanQuality := qualityTotal / completed
	candidateScore := resultRate * (0.7 + 0.3*meanQuality)
	return book, candidateScore, int(completed)
}

func learnedSearchStyle(raw json.RawMessage, recent []botbrain.MatchEntry, analyses map[string]GameAnalysis) botbrain.SearchStyle {
	style := botbrain.SearchStyle{Aggression: 0.65, KingAttackFocus: 0.6, MaterialGreed: 0.45, RiskTolerance: 0.55}
	var authored struct {
		Aggression      float64 `json:"aggression"`
		KingAttackFocus float64 `json:"king_attack_focus"`
		MaterialGreed   float64 `json:"material_greed"`
		RiskTolerance   float64 `json:"risk_tolerance"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &authored) == nil {
		style.Aggression = unitOr(authored.Aggression, style.Aggression)
		style.KingAttackFocus = unitOr(authored.KingAttackFocus, style.KingAttackFocus)
		style.MaterialGreed = unitOr(authored.MaterialGreed, style.MaterialGreed)
		style.RiskTolerance = unitOr(authored.RiskTolerance, style.RiskTolerance)
	}
	var losses, completed int
	var regret float64
	for _, match := range recent {
		switch normalizedResult(match.Result) {
		case "loss":
			losses++
			completed++
		case "win", "draw":
			completed++
		}
		regret += analyses[match.ID].AverageRegret
	}
	if completed >= tuningMinGames && (float64(losses)/float64(completed) > 0.6 || regret/float64(completed) > 120) {
		// Learn restraint after repeated tactical punishment, but never erase the
		// attacking identity the authored style requested.
		style.RiskTolerance = math.Max(0.45, style.RiskTolerance-0.08)
		style.MaterialGreed = math.Min(0.65, style.MaterialGreed+0.08)
	}
	return style
}

func unitOr(value, fallback float64) float64 {
	if value <= 0 || value > 1 {
		return fallback
	}
	return value
}

func normalizedResult(result string) string {
	return strings.ToLower(strings.TrimSpace(result))
}

func bookKey(moves []botbrain.Move) string {
	b, _ := json.Marshal(moves)
	return string(b)
}

func indexOf(values []string, value string) int {
	for i, candidate := range values {
		if candidate == value {
			return i
		}
	}
	return -1
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

package trainer

import (
	"strings"
	"testing"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

func foolsMate() botbrain.MatchEntry {
	return botbrain.MatchEntry{
		ID: "fools-mate", WhiteName: "Gambit Gus", BlackName: "Opponent",
		OpponentUserID: "opponent-id", OpponentName: "Opponent", Result: "loss", BotColor: "white",
		Moves: []botbrain.Move{
			{Fr: 6, Fc: 5, ToR: 5, ToC: 5}, // f3
			{Fr: 1, Fc: 4, ToR: 3, ToC: 4}, // ...e5
			{Fr: 6, Fc: 6, ToR: 4, ToC: 6}, // g4??
			{Fr: 0, Fc: 3, ToR: 4, ToC: 7}, // ...Qh4#
		},
	}
}

func TestAnalyzeGameFindsVerifiedCriticalMoment(t *testing.T) {
	pair := ReconstructAll([]botbrain.MatchEntry{foolsMate()}, "Gambit Gus")[0]
	analysis := AnalyzeGame(pair)
	if analysis.Moment == nil {
		t.Fatal("expected a critical moment")
	}
	if analysis.Moment.RegretCP < journalRegretMinCP {
		t.Fatalf("regret = %d", analysis.Moment.RegretCP)
	}
	if analysis.Moment.FEN == "" || analysis.Moment.PlayedSAN == "" || analysis.Moment.BetterSAN == "" {
		t.Fatalf("incomplete evidence: %#v", analysis.Moment)
	}
}

func TestPrepareHistoryAnalysesCachesAndPrunesDurableQuality(t *testing.T) {
	pairs := ReconstructAll([]botbrain.MatchEntry{foolsMate()}, "Gambit Gus")
	brain := &botbrain.Brain{MatchQuality: map[string]botbrain.MatchQuality{
		"no-longer-retained": {AnalyzerVersion: AnalyzerVersion},
	}}
	fresh := AnalyzeAll(pairs)
	first, analyzed := PrepareHistoryAnalyses(brain, pairs, fresh)
	if analyzed != 1 || first["fools-mate"].BotMoveCount == 0 {
		t.Fatalf("fresh analysis was not computed: analyzed=%d result=%#v", analyzed, first)
	}
	if _, ok := brain.MatchQuality["no-longer-retained"]; ok {
		t.Fatal("stale quality summary was not pruned")
	}
	second, analyzed := PrepareHistoryAnalyses(brain, pairs, nil)
	if analyzed != 0 || second["fools-mate"].BotMoveCount != first["fools-mate"].BotMoveCount {
		t.Fatalf("cached analysis was not reused: analyzed=%d result=%#v", analyzed, second)
	}
	if second["fools-mate"].Moment != nil {
		t.Fatal("ephemeral critical moment should not be fabricated from compact cache")
	}
}

func TestBookCandidateDoesNotDoubleCountAndUsesPromotionGate(t *testing.T) {
	win := scholarsMate()
	win.OpponentUserID = "victim-id"
	pairs := ReconstructAll([]botbrain.MatchEntry{win}, "Gambit Gus")
	analyses := AnalyzeAll(pairs)
	brain := &botbrain.Brain{}
	ctx := TuningContext{Analyses: analyses, Style: []byte(`{"aggression":0.85}`), Now: time.Now()}
	first := ComputePlayTuning(brain, []botbrain.MatchEntry{win}, ctx)
	if !first.Promoted || len(brain.PlayTuning.Book) != 1 {
		t.Fatalf("first candidate not promoted: %#v, tuning=%#v", first, brain.PlayTuning)
	}
	weight := brain.PlayTuning.Book[0].Weight
	revision := brain.PlayTuning.Revision
	second := ComputePlayTuning(brain, []botbrain.MatchEntry{win}, ctx)
	if second.Promoted {
		t.Fatalf("identical evidence should not create a new promotion: %#v", second)
	}
	if brain.PlayTuning.Book[0].Weight != weight || brain.PlayTuning.Revision != revision {
		t.Fatalf("book double-counted: weight %.3f -> %.3f, revision %d -> %d",
			weight, brain.PlayTuning.Book[0].Weight, revision, brain.PlayTuning.Revision)
	}
}

func TestJournalIsGroundedAndDoesNotExposeMatchIdentity(t *testing.T) {
	bot := newBlankBot()
	match := foolsMate()
	pairs := ReconstructAll([]botbrain.MatchEntry{match}, bot.Name)
	analysis := AnalyzeAll(pairs)
	out := Apply(bot, pairs, nil, time.Date(2026, 7, 14, 20, 0, 0, 0, time.UTC), ApplyContext{
		Analyses: analysis,
		Tuning:   TuningOutcome{Reason: "candidate did not beat champion", CandidateScore: .4, ChampionScore: .5},
	})
	if !strings.Contains(out.JournalText, "Verified position:") || !strings.Contains(out.JournalText, "Position (FEN):") {
		t.Fatalf("journal lacks deterministic evidence:\n%s", out.JournalText)
	}
	if !strings.Contains(out.JournalText, "Analyzer-verified lessons:") {
		t.Fatalf("deterministic lesson was not source-labeled:\n%s", out.JournalText)
	}
	if strings.Contains(out.JournalText, match.ID) || strings.Contains(out.JournalText, match.OpponentName) {
		t.Fatalf("journal leaked match identity:\n%s", out.JournalText)
	}
	if strings.Contains(out.JournalText, "brain v2") {
		t.Fatalf("journal version is off by one:\n%s", out.JournalText)
	}
}

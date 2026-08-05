package handler

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	ts "github.com/junaili/ethan-chess-service/pkg/pb/generic/task_scheduler/v1"
)

func schedulerRequest(runID string) *ts.ScheduledTaskRequest {
	return &ts.ScheduledTaskRequest{RunId: runID, TaskName: "gus-daily-training", Namespace: "test"}
}

// A shared run id would let the first bot's reservation swallow the second
// bot's run as a duplicate, silently costing it its training day.
func TestTrainRosterNamespacesRunIDsPerBot(t *testing.T) {
	roster := NewTrainRoster("gambit-gus")
	gus := roster.Add("gambit-gus", "unused")
	fiona := roster.Add("fortress-fiona", "unused")

	// Reserve under the namespaced id each bot will actually use. If RunAll
	// namespaced them wrongly, these reservations wouldn't collide and the
	// results below would not both report a conflict.
	gus.reserveRun("daily:gambit-gus")
	fiona.reserveRun("daily:fortress-fiona")

	for _, res := range roster.RunAll(context.Background(), "daily") {
		if !res.Conflict {
			t.Errorf("%s: expected conflict against its own namespaced run, got %+v", res.BotID, res)
		}
	}
}

// One bot's failure must not cost the rest of the roster its training day.
func TestTrainRosterRunsEveryBotDespiteOneConflict(t *testing.T) {
	roster := NewTrainRoster("gambit-gus")
	roster.Add("gambit-gus", "unused")
	fiona := roster.Add("fortress-fiona", "unused")
	fiona.reserveRun("someone-elses-run")

	results := roster.RunAll(context.Background(), "daily")
	if len(results) != 2 {
		t.Fatalf("expected both bots attempted, got %d results", len(results))
	}
	if results[0].BotID != "gambit-gus" || results[0].Conflict {
		t.Errorf("gus should have been attempted independently: %+v", results[0])
	}
	if !results[1].Conflict {
		t.Errorf("fiona should have reported a conflict: %+v", results[1])
	}
}

// A bot already being trained by someone else is not a failure — it must not
// force a whole-roster retry that re-runs the bots that already succeeded.
func TestScheduledTaskPartialConflictStillSucceeds(t *testing.T) {
	t.Setenv("AB_NAMESPACE", "test")
	t.Setenv("BOT_TRAIN_TASK_NAME", "gus-daily-training")

	store := newFakeCloudSave()
	store.seed(BotBrainKey("gambit-gus"), botbrain.Brain{
		SchemaVersion: 1, BotID: "gambit-gus", OpeningBook: map[string]*botbrain.OpeningStat{},
		OpponentDossiers: map[string]*botbrain.OpponentDossier{},
	})
	store.seed(BotHistoryKey("gambit-gus"), botHistoryValue{
		Matches: []botbrain.MatchEntry{completedFoolsMate("a-completed-match")},
	})
	useFakeAGS(t, store)
	for _, key := range []string{"LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
		t.Setenv(key, "")
	}

	roster := NewTrainRoster("gambit-gus")
	roster.Add("gambit-gus", filepath.Join("..", "..", "bots", "gambit-gus"))
	fiona := roster.Add("fortress-fiona", filepath.Join("..", "..", "bots", "fortress-fiona"))
	fiona.reserveRun("in-flight")

	response, err := NewScheduledTaskHandler(roster).RunScheduledTask(context.Background(), schedulerRequest("daily"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !response.Success || response.HttpStatusCode != 200 {
		t.Fatalf("partial conflict should not force a roster retry: %#v", response)
	}
	if !strings.Contains(response.Message, "1/2") {
		t.Errorf("message should report how many bots trained, got %q", response.Message)
	}
}

// When nothing ran, a retry is genuinely warranted.
func TestScheduledTaskAllConflictsRequestsRetry(t *testing.T) {
	t.Setenv("AB_NAMESPACE", "test")
	t.Setenv("BOT_TRAIN_TASK_NAME", "gus-daily-training")
	roster := NewTrainRoster("gambit-gus")
	roster.Add("gambit-gus", "unused").reserveRun("in-flight-a")
	roster.Add("fortress-fiona", "unused").reserveRun("in-flight-b")

	response, _ := NewScheduledTaskHandler(roster).RunScheduledTask(context.Background(), schedulerRequest("daily"))
	if response.Success || response.HttpStatusCode != 409 {
		t.Fatalf("all-conflict run should request a retry: %#v", response)
	}
}

func TestTrainRosterResolveDefaultsAndRejectsUnknown(t *testing.T) {
	roster := NewTrainRoster("gambit-gus")
	roster.Add("gambit-gus", "unused")
	roster.Add("fortress-fiona", "unused")

	if job, ok := roster.resolve(""); !ok || job.botID != "gambit-gus" {
		t.Errorf("empty should resolve to the default, got %v ok=%v", job, ok)
	}
	if job, ok := roster.resolve("fortress-fiona"); !ok || job.botID != "fortress-fiona" {
		t.Errorf("named bot did not resolve, got %v ok=%v", job, ok)
	}
	if _, ok := roster.resolve("nemesis-nigel"); ok {
		t.Error("unknown bot should not resolve")
	}
}

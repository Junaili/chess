package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	ts "github.com/junaili/ethan-chess-service/pkg/pb/generic/task_scheduler/v1"
	"github.com/junaili/ethan-chess-service/pkg/trainer"
)

type fakeAdminRecord struct {
	value     json.RawMessage
	updatedAt string
}

type fakeCloudSave struct {
	mu            sync.Mutex
	records       map[string]fakeAdminRecord
	version       int
	conflictKey   string
	conflicted    bool
	conflictValue any
	concurrentPUT int
}

func newFakeCloudSave() *fakeCloudSave {
	return &fakeCloudSave{records: map[string]fakeAdminRecord{}, version: 1}
}

func (f *fakeCloudSave) seed(key string, value any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.storeLocked(key, value)
}

func (f *fakeCloudSave) storeLocked(key string, value any) {
	raw, _ := json.Marshal(value)
	f.version++
	f.records[key] = fakeAdminRecord{
		value: raw, updatedAt: fmt.Sprintf("2026-07-14T00:00:%02dZ", f.version%60),
	}
}

func (f *fakeCloudSave) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Path == "/iam/v3/oauth/token" {
		return fakeHTTPResponse(http.StatusOK, `{"access_token":"test-token"}`), nil
	}
	marker := "/adminrecords/"
	index := strings.LastIndex(req.URL.Path, marker)
	if index < 0 {
		return fakeHTTPResponse(http.StatusNotFound, `{}`), nil
	}
	key := req.URL.Path[index+len(marker):]
	f.mu.Lock()
	defer f.mu.Unlock()

	if req.Method == http.MethodGet {
		record, ok := f.records[key]
		if !ok {
			return fakeHTTPResponse(http.StatusNotFound, `{}`), nil
		}
		body, _ := json.Marshal(map[string]any{"value": record.value, "updatedAt": record.updatedAt})
		return fakeHTTPResponse(http.StatusOK, string(body)), nil
	}

	if req.Method == http.MethodPut && strings.Contains(req.URL.Path, "/concurrent/adminrecords/") {
		f.concurrentPUT++
		var envelope struct {
			Value     json.RawMessage `json:"value"`
			UpdatedAt string          `json:"updatedAt"`
		}
		if err := json.NewDecoder(req.Body).Decode(&envelope); err != nil {
			return nil, err
		}
		if key == f.conflictKey && !f.conflicted {
			f.conflicted = true
			f.storeLocked(key, f.conflictValue)
			return fakeHTTPResponse(http.StatusPreconditionFailed, `{}`), nil
		}
		record, ok := f.records[key]
		if !ok {
			if envelope.UpdatedAt != "" {
				return fakeHTTPResponse(http.StatusPreconditionFailed, `{}`), nil
			}
			f.storeLocked(key, json.RawMessage(envelope.Value))
			return fakeHTTPResponse(http.StatusCreated, ``), nil
		}
		if record.updatedAt != envelope.UpdatedAt {
			return fakeHTTPResponse(http.StatusPreconditionFailed, `{}`), nil
		}
		f.storeLocked(key, json.RawMessage(envelope.Value))
		return fakeHTTPResponse(http.StatusNoContent, ``), nil
	}

	if req.Method == http.MethodPut {
		raw, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		f.storeLocked(key, json.RawMessage(raw))
		return fakeHTTPResponse(http.StatusOK, `{}`), nil
	}
	return fakeHTTPResponse(http.StatusMethodNotAllowed, `{}`), nil
}

func fakeHTTPResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(bytes.NewBufferString(body)),
	}
}

func useFakeAGS(t *testing.T, store *fakeCloudSave) {
	t.Helper()
	t.Setenv("AB_BASE_URL", "https://ags.test")
	t.Setenv("AB_CLIENT_ID", "client")
	t.Setenv("AB_CLIENT_SECRET", "secret")
	t.Setenv("AB_NAMESPACE", "test")
	previous := outboundHTTPClient
	outboundHTTPClient = &http.Client{Transport: store}
	t.Cleanup(func() { outboundHTTPClient = previous })
}

func completedFoolsMate(id string) botbrain.MatchEntry {
	return botbrain.MatchEntry{
		ID: id, Result: "loss", BotColor: "white", OpponentUserID: "opponent-id",
		OpponentName: "Opponent", WhiteName: "Gambit Gus", BlackName: "Opponent",
		StartedAt: "2025-01-01T00:00:00Z", EndedAt: "2025-01-01T00:01:00Z", DurationMs: 60000,
		Moves: []botbrain.Move{
			{Fr: 6, Fc: 5, ToR: 5, ToC: 5}, {Fr: 1, Fc: 4, ToR: 3, ToC: 4},
			{Fr: 6, Fc: 6, ToR: 4, ToC: 6}, {Fr: 0, Fc: 3, ToR: 4, ToC: 7},
		},
	}
}

func TestAppendBotGameRetriesConflictWithoutLosingEitherWriter(t *testing.T) {
	store := newFakeCloudSave()
	existing := completedFoolsMate("existing")
	racer := completedFoolsMate("racer")
	incoming := completedFoolsMate("incoming")
	key := BotHistoryKey("gambit-gus")
	store.seed(key, botHistoryValue{Matches: []botbrain.MatchEntry{existing, existing}})
	store.conflictKey = key
	store.conflictValue = botHistoryValue{Matches: []botbrain.MatchEntry{existing, existing, racer}}
	useFakeAGS(t, store)

	duplicate, err := AppendBotGame(key, incoming, 500)
	if err != nil || duplicate {
		t.Fatalf("append: duplicate=%v err=%v", duplicate, err)
	}
	games, err := FetchAllBotGames(key)
	if err != nil {
		t.Fatal(err)
	}
	if len(games) != 3 || games[0].ID != "existing" || games[1].ID != "racer" || games[2].ID != "incoming" {
		t.Fatalf("concurrent merge lost a game: %#v", games)
	}
	store.mu.Lock()
	var durable botHistoryValue
	_ = json.Unmarshal(store.records[key].value, &durable)
	store.mu.Unlock()
	if len(durable.Matches) != 3 {
		t.Fatalf("legacy duplicates were not repaired in durable history: %#v", durable.Matches)
	}
	puts := store.concurrentPUT
	duplicate, err = AppendBotGame(key, incoming, 500)
	if err != nil || !duplicate || store.concurrentPUT != puts {
		t.Fatalf("idempotent retry: duplicate=%v err=%v puts=%d->%d", duplicate, err, puts, store.concurrentPUT)
	}
}

func TestAppendBotGameCreatesFirstRecordThroughCAS(t *testing.T) {
	store := newFakeCloudSave()
	useFakeAGS(t, store)
	key := BotHistoryKey("gambit-gus")
	duplicate, err := AppendBotGame(key, completedFoolsMate("first"), 500)
	if err != nil || duplicate {
		t.Fatalf("first append: duplicate=%v err=%v", duplicate, err)
	}
	games, err := FetchAllBotGames(key)
	if err != nil || len(games) != 1 || games[0].ID != "first" {
		t.Fatalf("first CAS create was not durable: games=%#v err=%v", games, err)
	}
	if store.concurrentPUT != 1 {
		t.Fatalf("first record bypassed concurrency endpoint: puts=%d", store.concurrentPUT)
	}
}

func TestSaveBotGameHistoryMergesConcurrentLiveGame(t *testing.T) {
	store := newFakeCloudSave()
	key := BotHistoryKey("gambit-gus")
	existing := completedFoolsMate("existing")
	racer := completedFoolsMate("live-racer")
	selfPlay := completedFoolsMate("self-play")
	store.seed(key, botHistoryValue{Matches: []botbrain.MatchEntry{existing}})
	store.conflictKey = key
	store.conflictValue = botHistoryValue{Matches: []botbrain.MatchEntry{existing, racer}}
	useFakeAGS(t, store)
	if err := SaveBotGameHistory(key, []botbrain.MatchEntry{existing, selfPlay}); err != nil {
		t.Fatal(err)
	}
	games, err := FetchAllBotGames(key)
	if err != nil || len(games) != 3 || games[0].ID != "existing" || games[1].ID != "live-racer" || games[2].ID != "self-play" {
		t.Fatalf("offline merge erased/reordered a live game: games=%#v err=%v", games, err)
	}
}

func TestCommitBrainCreatesFirstRecordThroughCAS(t *testing.T) {
	store := newFakeCloudSave()
	useFakeAGS(t, store)
	job := NewTrainJob("gambit-gus", "unused")
	brain := &botbrain.Brain{SchemaVersion: 1, BotID: "gambit-gus"}
	if err := job.commitBrain(brain, ""); err != nil {
		t.Fatal(err)
	}
	stored, found, err := FetchBotBrain("gambit-gus")
	if err != nil || !found || stored.BotID != "gambit-gus" {
		t.Fatalf("first brain CAS create failed: brain=%#v found=%v err=%v", stored, found, err)
	}
	if store.concurrentPUT != 1 {
		t.Fatalf("first brain write bypassed concurrency endpoint: puts=%d", store.concurrentPUT)
	}
}

func TestTrainingBackfillsOldGameAndCommitsJournalAtomically(t *testing.T) {
	store := newFakeCloudSave()
	brain := botbrain.Brain{
		SchemaVersion: 1, BotID: "gambit-gus", OpeningBook: map[string]*botbrain.OpeningStat{},
		OpponentDossiers: map[string]*botbrain.OpponentDossier{},
	}
	match := completedFoolsMate("old-completed-match")
	store.seed(BotBrainKey("gambit-gus"), brain)
	store.seed(BotHistoryKey("gambit-gus"), botHistoryValue{Matches: []botbrain.MatchEntry{match}})
	useFakeAGS(t, store)
	for _, key := range []string{"LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
		t.Setenv(key, "")
	}

	job := NewTrainJob("gambit-gus", filepath.Join("..", "..", "bots", "gambit-gus"))
	status, err := job.RunTrainingFor(context.Background(), "daily-run-1")
	if err != nil {
		t.Fatal(err)
	}
	if status["result"] != "trained" || status["gamesLearned"] != 1 || status["analysisGames"] != 1 {
		t.Fatalf("unexpected status: %#v", status)
	}
	stored, found, err := FetchBotBrain("gambit-gus")
	if err != nil || !found {
		t.Fatalf("fetch stored brain: found=%v err=%v", found, err)
	}
	if !stored.AlreadyProcessed(match.ID) || stored.GamesLearnedFrom != 1 || stored.LastChecked == nil {
		t.Fatalf("old game was not durably learned: %#v", stored)
	}
	if stored.LastTrainingRunID != "daily-run-1" || len(stored.TrainingJournal) != 1 {
		t.Fatalf("brain/journal not atomic: run=%q journal=%#v", stored.LastTrainingRunID, stored.TrainingJournal)
	}
	if quality, ok := stored.MatchQuality[match.ID]; !ok || quality.AnalyzerVersion != trainer.AnalyzerVersion {
		t.Fatalf("bounded analysis was not durably cached: %#v", stored.MatchQuality)
	}
	journal := stored.TrainingJournal[0].Text
	if !strings.Contains(journal, "1 completed game(s)") || !strings.Contains(journal, "Verified position:") {
		t.Fatalf("journal lacks grounded training facts:\n%s", journal)
	}
	if strings.Contains(journal, match.ID) || strings.Contains(journal, match.OpponentName) {
		t.Fatalf("journal exposed match identity:\n%s", journal)
	}

	second, err := job.RunTrainingFor(context.Background(), "daily-run-1")
	if err != nil || second["result"] != "already_completed" {
		t.Fatalf("scheduler retry was not idempotent: %#v err=%v", second, err)
	}
	after, _, _ := FetchBotBrain("gambit-gus")
	if after.Version != stored.Version || len(after.TrainingJournal) != 1 {
		t.Fatalf("idempotent retry changed durable state: before v%d after v%d", stored.Version, after.Version)
	}
}

func TestScheduledTaskValidationAndConflictSemantics(t *testing.T) {
	t.Setenv("AB_NAMESPACE", "test")
	t.Setenv("BOT_TRAIN_TASK_NAME", "gus-daily-training")
	job := NewTrainJob("gambit-gus", "unused")
	handler := NewScheduledTaskHandler(job)

	response, err := handler.RunScheduledTask(context.Background(), &ts.ScheduledTaskRequest{})
	if err != nil || response.Success || response.HttpStatusCode != 400 {
		t.Fatalf("missing run id accepted: %#v err=%v", response, err)
	}
	response, _ = handler.RunScheduledTask(context.Background(), &ts.ScheduledTaskRequest{
		RunId: "run", TaskName: "wrong", Namespace: "test",
	})
	if response.Success || response.HttpStatusCode != 400 {
		t.Fatalf("wrong task accepted: %#v", response)
	}

	job.running = true
	job.activeRunID = "manual-run"
	response, _ = handler.RunScheduledTask(context.Background(), &ts.ScheduledTaskRequest{
		RunId: "daily-run", TaskName: "gus-daily-training", Namespace: "test",
	})
	if response.Success || response.HttpStatusCode != 409 {
		t.Fatalf("different active run should request scheduler retry: %#v", response)
	}
	response, _ = handler.RunScheduledTask(context.Background(), &ts.ScheduledTaskRequest{
		RunId: "manual-run", TaskName: "gus-daily-training", Namespace: "test",
	})
	if response.Success || response.HttpStatusCode != 409 {
		t.Fatalf("same run retry must wait for durable completion: %#v", response)
	}
}

func TestValidateCompletedBotGameRejectsAbandonedOrMalformedRecords(t *testing.T) {
	valid := completedFoolsMate("valid")
	if err := validateCompletedBotGame(valid); err != nil {
		t.Fatalf("valid record rejected: %v", err)
	}
	badResult := valid
	badResult.Result = "abandoned"
	if err := validateCompletedBotGame(badResult); err == nil {
		t.Fatal("abandoned game accepted")
	}
	badSquare := valid
	badSquare.Moves = append([]botbrain.Move(nil), valid.Moves...)
	badSquare.Moves[0].Fr = 9
	if err := validateCompletedBotGame(badSquare); err == nil {
		t.Fatal("out-of-range move accepted")
	}
	badTime := valid
	badTime.EndedAt = time.Now().Format(time.RFC822)
	if err := validateCompletedBotGame(badTime); err == nil {
		t.Fatal("non-RFC3339 end time accepted")
	}
}

func TestCompactBotHistoryStaysBelowCloudSaveTarget(t *testing.T) {
	large := completedFoolsMate("seed")
	large.OpponentName = strings.Repeat("x", 4000)
	var matches []botbrain.MatchEntry
	for i := 0; i < 500; i++ {
		entry := large
		entry.ID = fmt.Sprintf("game-%03d", i)
		matches = append(matches, entry)
	}
	compacted := compactBotHistory(matches, 500)
	raw, err := json.Marshal(botHistoryValue{Matches: compacted})
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > botHistoryTargetBytes || len(compacted) >= len(matches) {
		t.Fatalf("history was not byte-bounded: bytes=%d matches=%d", len(raw), len(compacted))
	}
	if compacted[len(compacted)-1].ID != "game-499" {
		t.Fatal("compaction did not retain the newest match")
	}
}

func TestSelectReflectionPairsBoundsAndPrioritizesEvidence(t *testing.T) {
	var pairs []trainer.GamePair
	analyses := map[string]trainer.GameAnalysis{}
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("game-%02d", i)
		result := "win"
		if i == 3 {
			result = "loss"
		}
		pairs = append(pairs, trainer.GamePair{Entry: botbrain.MatchEntry{ID: id, Result: result}})
	}
	analyses["game-17"] = trainer.GameAnalysis{Moment: &trainer.CriticalMoment{RegretCP: 900}}
	selected := trainer.SelectReflectionPairs(pairs, analyses, 5)
	if len(selected) != 5 || selected[0].Entry.ID != "game-17" || selected[1].Entry.ID != "game-03" {
		t.Fatalf("reflection selection did not prioritize evidence/losses: %#v", selected)
	}
}

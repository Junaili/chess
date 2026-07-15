package handler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/llm"
	"github.com/junaili/ethan-chess-service/pkg/trainer"
)

// TrainJob runs one self-learning pass for the bot. It is INVOKED by the AGS
// Extend Task Scheduler (configured in the Admin Portal on this app) hitting
// POST {basePath}/bot/train daily — the job itself owns no timer.
//
// Storage: the brain and journal live in CloudSave admin records (the container
// filesystem is ephemeral); persona.md/style.json stay baked into the image and
// are read from BOT_DIR. The disk brain.json only seeds the very first run.
type TrainJob struct {
	botID              string
	botDir             string
	performanceCapture func(string)

	mu          sync.Mutex
	running     bool
	activeRunID string
	last        map[string]any // status for /debug/trainer
}

func NewTrainJob(botID, botDir string) *TrainJob {
	return &TrainJob{botID: botID, botDir: botDir, last: map[string]any{}}
}

// SetPerformanceCapture installs a nonblocking runtime telemetry hook. It must
// be configured during service startup, before training can be invoked.
func (j *TrainJob) SetPerformanceCapture(capture func(string)) {
	j.performanceCapture = capture
}

func (j *TrainJob) capturePerformance(reason string) {
	if j.performanceCapture != nil {
		j.performanceCapture(reason)
	}
}

func BotBrainKey(botID string) string   { return "chess-bot-" + botID + "-brain" }
func BotJournalKey(botID string) string { return "chess-bot-" + botID + "-journal" }

// JournalEntry remains exported from handler for the player-profile package;
// the durable type now lives in botbrain because brain+journal commit atomically.
type JournalEntry = botbrain.JournalEntry
type journalValue struct {
	Entries   []JournalEntry `json:"entries"`
	UpdatedAt string         `json:"updatedAt"`
}

const journalCap = 60

// ── generic admin-record helpers (mirror bottrainer.go's, any value type) ────

func fetchAdminValue(key string, out any) (bool, error) {
	return fetchAdminValueContext(context.Background(), key, out)
}

func fetchAdminValueContext(ctx context.Context, key string, out any) (bool, error) {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return false, err
	}
	token, err := getClientCredentialsTokenContext(ctx, baseURL, clientID, clientSecret)
	if err != nil {
		return false, fmt.Errorf("get token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, adminRecordURL(baseURL, namespace, key), nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("admin record %q returned %d", key, resp.StatusCode)
	}
	var rec struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&rec); err != nil {
		return false, fmt.Errorf("parse admin record %q: %w", key, err)
	}
	if err := json.Unmarshal(rec.Value, out); err != nil {
		return false, fmt.Errorf("parse admin record %q value: %w", key, err)
	}
	return true, nil
}

// FetchBotBrain loads the bot's learned brain from its CloudSave admin record.
// found=false (with nil error) means the bot has never trained yet.
func FetchBotBrain(botID string) (*botbrain.Brain, bool, error) {
	var brain botbrain.Brain
	found, err := fetchAdminValue(BotBrainKey(botID), &brain)
	if err != nil || !found {
		return nil, false, err
	}
	return &brain, true, nil
}

// FetchBotJournal loads the bot's training-journal entries (oldest first, as
// stored). A missing record returns an empty slice.
func FetchBotJournal(botID string) ([]JournalEntry, error) {
	if brain, found, err := FetchBotBrain(botID); err != nil {
		return nil, err
	} else if found && len(brain.TrainingJournal) > 0 {
		return brain.TrainingJournal, nil
	}
	var jv journalValue
	if _, err := fetchAdminValue(BotJournalKey(botID), &jv); err != nil {
		return nil, err
	}
	return jv.Entries, nil
}

// Status reports whether a training run is in flight plus a copy of the last
// run's summary (for the player-facing Gus profile endpoint).
func (j *TrainJob) Status() (running bool, last map[string]any) {
	j.mu.Lock()
	defer j.mu.Unlock()
	last = make(map[string]any, len(j.last))
	for k, v := range j.last {
		last[k] = v
	}
	return j.running, last
}

// ── the training run ──────────────────────────────────────────────────────────

// RunTraining is the manual-call compatibility wrapper. Scheduled callers pass
// their stable run ID through RunTrainingFor so a platform retry is idempotent.
func (j *TrainJob) RunTraining(ctx context.Context) (map[string]any, error) {
	return j.RunTrainingFor(ctx, "manual-"+time.Now().UTC().Format("20060102T150405.000000000Z"))
}

type reflectionMemo struct {
	batchID string
	value   *trainer.Reflection
	llmName string
	errText string
}

// RunTrainingFor retries optimistic CloudSave conflicts from a clean read. It
// never relies on a 24-hour wall-clock window: every retained, unprocessed
// completed game is backfilled, even after a missed scheduler day.
func (j *TrainJob) RunTrainingFor(ctx context.Context, runID string) (map[string]any, error) {
	j.capturePerformance("training_start")
	defer j.capturePerformance("training_finish")
	started := time.Now().UTC()
	if strings.TrimSpace(runID) == "" {
		runID = "unspecified-" + started.Format("20060102T150405.000000000Z")
	}
	memo := reflectionMemo{}
	var lastErr error
	for attempt := 1; attempt <= 4; attempt++ {
		status, conflict, err := j.runTrainingAttempt(ctx, runID, started, attempt, &memo)
		if !conflict {
			return status, err
		}
		lastErr = errAdminRecordConflict
		log.Printf("train: CloudSave conflict for run %s (attempt %d), retrying from fresh state", runID, attempt)
	}
	return map[string]any{
		"startedAt": started.Format(time.RFC3339), "runID": runID,
	}, fmt.Errorf("training run %s did not converge: %w", runID, lastErr)
}

func (j *TrainJob) runTrainingAttempt(ctx context.Context, runID string, started time.Time, attempt int, memo *reflectionMemo) (map[string]any, bool, error) {
	status := map[string]any{
		"startedAt": started.Format(time.RFC3339), "runID": runID, "attempt": attempt,
	}
	bot, err := botbrain.LoadBot(j.botDir)
	if err != nil {
		return status, false, fmt.Errorf("load bot dir: %w", err)
	}
	rawBrain, brainUpdatedAt, found, err := fetchAdminGameRecordRaw(BotBrainKey(j.botID))
	if err != nil {
		return status, false, fmt.Errorf("load brain: %w", err)
	}
	if !found {
		log.Printf("train: no CloudSave brain yet — creating seed from baked brain.json (v%d)", bot.Brain.Version)
		if err := createAdminGameRecord(BotBrainKey(j.botID), bot.Brain); err != nil && !errors.Is(err, errAdminRecordConflict) {
			return status, false, fmt.Errorf("create brain: %w", err)
		}
		rawBrain, brainUpdatedAt, found, err = fetchAdminGameRecordRaw(BotBrainKey(j.botID))
		if err != nil {
			return status, false, fmt.Errorf("reload created brain: %w", err)
		}
		if !found {
			return status, false, fmt.Errorf("reload created brain: CloudSave record is still missing")
		}
	}
	if found {
		var cloudBrain botbrain.Brain
		if err := json.Unmarshal(rawBrain, &cloudBrain); err != nil {
			return status, false, fmt.Errorf("parse brain: %w", err)
		}
		bot.Brain = &cloudBrain
	}
	if bot.Brain.LastTrainingRunID == runID {
		status["result"] = "already_completed"
		status["brainVersion"] = bot.Brain.Version
		return status, false, nil
	}

	allMatches, err := FetchAllBotGames(BotHistoryKey(j.botID))
	if err != nil {
		return status, false, fmt.Errorf("fetch games: %w", err)
	}
	status["gamesInHistory"] = len(allMatches)
	if len(bot.Brain.TrainingJournal) == 0 {
		var legacy journalValue
		if legacyFound, legacyErr := fetchAdminValue(BotJournalKey(j.botID), &legacy); legacyErr == nil && legacyFound {
			bot.Brain.TrainingJournal = append(bot.Brain.TrainingJournal, legacy.Entries...)
			status["legacyJournalMigrated"] = len(legacy.Entries)
		}
	}
	trainer.NormalizeBrain(bot.Brain, allMatches)

	var freshEntries, ignored []botbrain.MatchEntry
	for _, match := range allMatches {
		if bot.Brain.AlreadyProcessed(match.ID) {
			continue
		}
		if !trainableHistoricalMatch(match) {
			ignored = append(ignored, match)
			continue
		}
		freshEntries = append(freshEntries, match)
	}
	freshPairs, invalidFresh := reconstructValid(freshEntries, bot.Name)
	ignored = append(ignored, invalidFresh...)
	for _, match := range ignored {
		bot.Brain.MarkProcessed(match.ID)
	}
	status["newGames"] = len(freshPairs)
	status["ignoredGames"] = len(ignored)

	now := time.Now().UTC()
	checked := now.Format(time.RFC3339)
	bot.Brain.LastChecked = &checked
	bot.Brain.LastTrainingRunID = runID
	if len(freshPairs) == 0 {
		status["result"] = "no_new_games"
		if err := ctx.Err(); err != nil {
			return status, false, fmt.Errorf("training context ended before check commit: %w", err)
		}
		if err := j.commitBrain(bot.Brain, brainUpdatedAt); err != nil {
			if errors.Is(err, errAdminRecordConflict) {
				return status, true, err
			}
			return status, false, fmt.Errorf("save training check: %w", err)
		}
		status["brainVersion"] = bot.Brain.Version
		return status, false, nil
	}

	// Candidate/champion tuning is evaluated against every valid retained game,
	// while learning tallies see only the fresh subset. Do this heavier analysis
	// only when there is actually new evidence to apply.
	eligibleEntries := make([]botbrain.MatchEntry, 0, len(allMatches))
	for _, match := range allMatches {
		if trainableHistoricalMatch(match) {
			eligibleEntries = append(eligibleEntries, match)
		}
	}
	historyPairs, _ := reconstructValid(eligibleEntries, bot.Name)
	validHistory := make([]botbrain.MatchEntry, 0, len(historyPairs))
	for _, pair := range historyPairs {
		validHistory = append(validHistory, pair.Entry)
	}
	freshAnalyses := trainer.AnalyzeAll(freshPairs)
	historyAnalyses, analyzedGames := trainer.PrepareHistoryAnalyses(bot.Brain, historyPairs, freshAnalyses)
	status["analysisGames"] = analyzedGames
	reflectionPairs := trainer.SelectReflectionPairs(freshPairs, freshAnalyses, 12)
	status["reflectionGames"] = len(reflectionPairs)

	batchID := trainingBatchID(freshPairs)
	var refl *trainer.Reflection
	if memo.batchID == batchID {
		refl, status["llm"], status["llmError"] = memo.value, memo.llmName, memo.errText
	} else {
		cfg := llm.FromEnv()
		if cfg.Configured() {
			provider, providerErr := llm.New(cfg)
			if providerErr == nil {
				rctx, cancel := context.WithTimeout(ctx, 90*time.Second)
				refl, err = trainer.Reflect(rctx, provider, bot, reflectionPairs, freshAnalyses)
				cancel()
				if err != nil {
					log.Printf("train: LLM reflection failed (continuing deterministic): %v", err)
					status["llmError"] = err.Error()
					refl = nil
				} else {
					status["llm"] = provider.Name() + "/" + provider.Model()
				}
			} else {
				status["llmError"] = providerErr.Error()
			}
		} else {
			status["llm"] = "not configured"
		}
		memo.batchID, memo.value = batchID, refl
		memo.llmName, _ = status["llm"].(string)
		memo.errText, _ = status["llmError"].(string)
	}
	if err := ctx.Err(); err != nil {
		return status, false, fmt.Errorf("training context ended before commit: %w", err)
	}

	tuning := trainer.ComputePlayTuning(bot.Brain, validHistory, trainer.TuningContext{
		Analyses: historyAnalyses, Style: bot.Style, Now: now,
	})
	outcome := trainer.Apply(bot, freshPairs, refl, now, trainer.ApplyContext{Analyses: freshAnalyses, Tuning: tuning})
	entry := JournalEntry{
		ID: "training-" + batchID, Date: now.Format("2006-01-02"),
		CreatedAt: now.Format(time.RFC3339), MatchCount: len(freshPairs), Text: outcome.JournalText,
	}
	upsertTrainingJournal(bot.Brain, entry)
	if err := j.commitBrain(bot.Brain, brainUpdatedAt); err != nil {
		if errors.Is(err, errAdminRecordConflict) {
			return status, true, err
		}
		return status, false, fmt.Errorf("save brain+journal: %w", err)
	}

	status["result"] = "trained"
	status["brainVersion"] = bot.Brain.Version
	status["lessonsAdded"] = outcome.LessonsAdded
	status["openingsTouched"] = outcome.OpeningsTouched
	status["gamesLearned"] = outcome.GamesLearned
	status["bookPromoted"] = tuning.Promoted
	status["bookCandidateScore"] = tuning.CandidateScore
	if bot.Brain.PlayTuning != nil {
		status["difficulty"] = bot.Brain.PlayTuning.Difficulty
		status["winRate"] = bot.Brain.PlayTuning.WinRate
		status["bookLines"] = len(bot.Brain.PlayTuning.Book)
		status["bookRevision"] = bot.Brain.PlayTuning.Revision
	}
	log.Printf("train: brain v%d — +%d lessons, %d openings, %d games (book promoted=%v, difficulty=%v)",
		bot.Brain.Version, outcome.LessonsAdded, outcome.OpeningsTouched, outcome.GamesLearned, tuning.Promoted, status["difficulty"])
	return status, false, nil
}

func (j *TrainJob) commitBrain(brain *botbrain.Brain, updatedAt string) error {
	return putAdminGameRecordConcurrent(BotBrainKey(j.botID), brain, updatedAt)
}

func trainableHistoricalMatch(match botbrain.MatchEntry) bool {
	return trainer.IsTrainableMatch(match)
}

func reconstructValid(entries []botbrain.MatchEntry, botName string) (valid []trainer.GamePair, invalid []botbrain.MatchEntry) {
	for _, pair := range trainer.ReconstructAll(entries, botName) {
		if pair.Game == nil || pair.Game.Truncated || pair.Game.BotColor == "" {
			invalid = append(invalid, pair.Entry)
			continue
		}
		valid = append(valid, pair)
	}
	return valid, invalid
}

func trainingBatchID(pairs []trainer.GamePair) string {
	ids := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		ids = append(ids, pair.Entry.ID)
	}
	sort.Strings(ids)
	sum := sha256.Sum256([]byte(strings.Join(ids, "\x00")))
	return fmt.Sprintf("%x", sum[:8])
}

func upsertTrainingJournal(brain *botbrain.Brain, entry JournalEntry) {
	for i := range brain.TrainingJournal {
		if brain.TrainingJournal[i].ID == entry.ID {
			brain.TrainingJournal[i] = entry
			return
		}
	}
	brain.TrainingJournal = append(brain.TrainingJournal, entry)
	if len(brain.TrainingJournal) > journalCap {
		brain.TrainingJournal = append([]JournalEntry(nil), brain.TrainingJournal[len(brain.TrainingJournal)-journalCap:]...)
	}
}

// TryRun executes one training pass unless one is already in flight
// (conflict=true, nothing executed). Used by both the Task Scheduler gRPC
// handler (sync) and the HTTP endpoint (async).
func (j *TrainJob) TryRun(ctx context.Context, runIDs ...string) (map[string]any, bool, error) {
	runID := ""
	if len(runIDs) > 0 {
		runID = strings.TrimSpace(runIDs[0])
	}
	if runID == "" {
		runID = "manual-" + time.Now().UTC().Format("20060102T150405.000000000Z")
	}
	if conflictStatus, conflict := j.reserveRun(runID); conflict {
		return conflictStatus, true, nil
	}
	st, err := j.runReserved(ctx, runID)
	return st, false, err
}

func (j *TrainJob) reserveRun(runID string) (map[string]any, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.running {
		return map[string]any{
			"activeRunID": j.activeRunID,
			"sameRun":     runID != "" && runID == j.activeRunID,
		}, true
	}
	j.running = true
	j.activeRunID = runID
	return nil, false
}

func (j *TrainJob) runReserved(ctx context.Context, runID string) (map[string]any, error) {
	st, err := j.RunTrainingFor(ctx, runID)
	if st == nil {
		st = map[string]any{"runID": runID}
	}
	if err != nil {
		st["error"] = err.Error()
		log.Printf("train: run failed: %v", err)
	}
	st["finishedAt"] = time.Now().UTC().Format(time.RFC3339)
	j.mu.Lock()
	j.running = false
	j.activeRunID = ""
	j.last = st
	j.mu.Unlock()
	return st, err
}

// ── HTTP surface ──────────────────────────────────────────────────────────────

// TrainHandler is the Task Scheduler's target: POST {basePath}/bot/train.
// Auth: x-trigger-secret header OR ?key= query (whichever the scheduler can
// send). Runs async (LLM reflection can exceed the HTTP write timeout) and
// replies 202; progress/results via TrainerDebugHandler. 409 while running.
func (j *TrainJob) TrainHandler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if secret == "" || (r.Header.Get("x-trigger-secret") != secret && r.URL.Query().Get("key") != secret) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		runID := "http-" + time.Now().UTC().Format("20060102T150405.000000000Z")
		if _, conflict := j.reserveRun(runID); conflict {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"ok":false,"reason":"training already running"}`))
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			_, _ = j.runReserved(ctx, runID)
		}()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "started": true, "runID": runID})
	}
}

// BotBrainHandler serves the play-affecting subset of the brain to the AMS bot
// DS (fetched at trigger time). Cached for 60s so a burst of triggers doesn't
// hammer CloudSave. Same shared-secret auth as the other bot endpoints.
func (j *TrainJob) BotBrainHandler(secret string) http.HandlerFunc {
	type cached struct {
		at         time.Time
		body       []byte
		refreshing chan struct{}
		lastErr    error
	}
	var mu sync.Mutex
	var c cached
	load := func(ctx context.Context) ([]byte, error) {
		var brain botbrain.Brain
		found, err := fetchAdminValueContext(ctx, BotBrainKey(j.botID), &brain)
		if err != nil {
			return nil, err
		}
		out := map[string]any{"version": 0}
		if found {
			out["version"] = brain.Version
			if t := brain.PlayTuning; t != nil {
				out["difficulty"] = t.Difficulty
				out["thinkMsMean"] = t.ThinkMsMean
				out["thinkMsJitter"] = t.ThinkMsJitter
				out["searchBudgetMs"] = t.SearchBudgetMs
				out["maxShufflePlies"] = t.MaxShufflePlies
				out["book"] = t.Book
				out["bookRevision"] = t.Revision
				out["bookScore"] = t.BookScore
				out["style"] = t.Style
			}
		}
		return json.Marshal(out)
	}
	write := func(w http.ResponseWriter, body []byte) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if secret == "" || (r.Header.Get("x-trigger-secret") != secret && r.URL.Query().Get("key") != secret) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		mu.Lock()
		if c.body != nil && time.Since(c.at) <= 60*time.Second {
			body := c.body
			mu.Unlock()
			write(w, body)
			return
		}
		if c.refreshing != nil {
			// A stale response is preferable to making every burst request wait
			// behind the single CloudSave refresh.
			if c.body != nil {
				body := c.body
				mu.Unlock()
				write(w, body)
				return
			}
			done := c.refreshing
			mu.Unlock()
			select {
			case <-done:
			case <-r.Context().Done():
				w.WriteHeader(http.StatusRequestTimeout)
				return
			}
			mu.Lock()
			body, err := c.body, c.lastErr
			mu.Unlock()
			if body == nil {
				if err != nil {
					log.Printf("bot-brain: fetch: %v", err)
				}
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			write(w, body)
			return
		}
		c.refreshing = make(chan struct{})
		done := c.refreshing
		mu.Unlock()

		body, err := load(r.Context())
		mu.Lock()
		if err == nil {
			c.at = time.Now()
			c.body = body
		}
		c.lastErr = err
		close(done)
		c.refreshing = nil
		body = c.body
		mu.Unlock()
		if err != nil && body == nil {
			log.Printf("bot-brain: fetch: %v", err)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		write(w, body)
	}
}

// TrainerDebugHandler reports the last run + whether one is in flight.
func (j *TrainJob) TrainerDebugHandler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if secret == "" || (r.Header.Get("x-trigger-secret") != secret && r.URL.Query().Get("key") != secret) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		j.mu.Lock()
		out := map[string]any{"running": j.running, "lastRun": j.last, "botID": j.botID}
		j.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}

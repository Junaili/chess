package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
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
	botID  string
	botDir string

	mu      sync.Mutex
	running bool
	last    map[string]any // status for /debug/trainer
}

func NewTrainJob(botID, botDir string) *TrainJob {
	return &TrainJob{botID: botID, botDir: botDir, last: map[string]any{}}
}

func BotBrainKey(botID string) string   { return "chess-bot-" + botID + "-brain" }
func BotJournalKey(botID string) string { return "chess-bot-" + botID + "-journal" }

type journalEntry struct {
	Date string `json:"date"`
	Text string `json:"text"`
}
type journalValue struct {
	Entries   []journalEntry `json:"entries"`
	UpdatedAt string         `json:"updatedAt"`
}

const journalCap = 60

// ── generic admin-record helpers (mirror bottrainer.go's, any value type) ────

func fetchAdminValue(key string, out any) (bool, error) {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return false, err
	}
	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return false, fmt.Errorf("get token: %w", err)
	}
	req, err := http.NewRequest(http.MethodGet, adminRecordURL(baseURL, namespace, key), nil)
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
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return false, err
	}
	var rec struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(body, &rec); err != nil {
		return false, fmt.Errorf("parse admin record %q: %w", key, err)
	}
	if err := json.Unmarshal(rec.Value, out); err != nil {
		return false, fmt.Errorf("parse admin record %q value: %w", key, err)
	}
	return true, nil
}

func putAdminValue(key string, val any) error {
	baseURL, clientID, clientSecret, namespace, err := agsConfig()
	if err != nil {
		return err
	}
	token, err := getClientCredentialsToken(baseURL, clientID, clientSecret)
	if err != nil {
		return fmt.Errorf("get token: %w", err)
	}
	body, err := json.Marshal(val)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPut, adminRecordURL(baseURL, namespace, key), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := outboundHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return fmt.Errorf("save admin record %q returned %d: %s", key, resp.StatusCode, string(raw))
	}
	return nil
}

// ── the training run ──────────────────────────────────────────────────────────

// RunTraining executes one pass: load brain (CloudSave, seeded from the baked
// brain.json on first run) → fetch the last 24h of the bot's own games → replay
// → LLM reflection (if configured; deterministic learning happens regardless) →
// play tuning → save brain + journal back to CloudSave.
func (j *TrainJob) RunTraining(ctx context.Context) (map[string]any, error) {
	status := map[string]any{"startedAt": time.Now().UTC().Format(time.RFC3339)}

	bot, err := botbrain.LoadBot(j.botDir)
	if err != nil {
		return status, fmt.Errorf("load bot dir: %w", err)
	}
	var cloudBrain botbrain.Brain
	found, err := fetchAdminValue(BotBrainKey(j.botID), &cloudBrain)
	if err != nil {
		return status, fmt.Errorf("load brain: %w", err)
	}
	if found {
		bot.Brain = &cloudBrain
	} else {
		log.Printf("train: no CloudSave brain yet — seeding from baked brain.json (v%d)", bot.Brain.Version)
	}

	since := time.Now().Add(-24 * time.Hour)
	matches, err := FetchBotGameHistory(BotHistoryKey(j.botID), since)
	if err != nil {
		return status, fmt.Errorf("fetch games: %w", err)
	}
	var fresh []botbrain.MatchEntry
	for _, m := range matches {
		if !bot.Brain.AlreadyProcessed(m.ID) {
			fresh = append(fresh, m)
		}
	}
	status["gamesInWindow"] = len(matches)
	status["newGames"] = len(fresh)
	if len(fresh) == 0 {
		status["result"] = "no_new_games"
		return status, nil
	}

	pairs := trainer.ReconstructAll(fresh, bot.ID)

	// LLM reflection — optional; a failure degrades to deterministic-only learning.
	var refl *trainer.Reflection
	cfg := llm.FromEnv()
	if cfg.Configured() {
		provider, perr := llm.New(cfg)
		if perr == nil {
			rctx, cancel := context.WithTimeout(ctx, 90*time.Second)
			refl, err = trainer.Reflect(rctx, provider, bot, pairs)
			cancel()
			if err != nil {
				log.Printf("train: LLM reflection failed (continuing deterministic): %v", err)
				status["llmError"] = err.Error()
				refl = nil
			} else {
				status["llm"] = provider.Name() + "/" + provider.Model()
			}
		} else {
			status["llmError"] = perr.Error()
		}
	} else {
		status["llm"] = "not configured"
	}

	outcome := trainer.Apply(bot, pairs, refl, time.Now())
	trainer.ComputePlayTuning(bot.Brain, matches)

	if err := putAdminValue(BotBrainKey(j.botID), bot.Brain); err != nil {
		return status, fmt.Errorf("save brain: %w", err)
	}
	var jv journalValue
	_, _ = fetchAdminValue(BotJournalKey(j.botID), &jv)
	jv.Entries = append(jv.Entries, journalEntry{Date: time.Now().UTC().Format("2006-01-02"), Text: outcome.JournalText})
	if len(jv.Entries) > journalCap {
		jv.Entries = jv.Entries[len(jv.Entries)-journalCap:]
	}
	jv.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := putAdminValue(BotJournalKey(j.botID), jv); err != nil {
		log.Printf("train: save journal: %v", err)
	}

	status["result"] = "trained"
	status["brainVersion"] = bot.Brain.Version
	status["lessonsAdded"] = outcome.LessonsAdded
	status["openingsTouched"] = outcome.OpeningsTouched
	status["gamesLearned"] = outcome.GamesLearned
	if bot.Brain.PlayTuning != nil {
		status["difficulty"] = bot.Brain.PlayTuning.Difficulty
		status["winRate"] = bot.Brain.PlayTuning.WinRate
		status["bookLines"] = len(bot.Brain.PlayTuning.Book)
	}
	log.Printf("train: brain v%d — +%d lessons, %d openings, %d games (difficulty=%v)",
		bot.Brain.Version, outcome.LessonsAdded, outcome.OpeningsTouched, outcome.GamesLearned, status["difficulty"])
	return status, nil
}

// TryRun executes one training pass unless one is already in flight
// (conflict=true, nothing executed). Used by both the Task Scheduler gRPC
// handler (sync) and the HTTP endpoint (async).
func (j *TrainJob) TryRun(ctx context.Context) (map[string]any, bool, error) {
	j.mu.Lock()
	if j.running {
		j.mu.Unlock()
		return nil, true, nil
	}
	j.running = true
	j.mu.Unlock()

	st, err := j.RunTraining(ctx)
	if err != nil {
		st["error"] = err.Error()
		log.Printf("train: run failed: %v", err)
	}
	st["finishedAt"] = time.Now().UTC().Format(time.RFC3339)
	j.mu.Lock()
	j.running = false
	j.last = st
	j.mu.Unlock()
	return st, false, err
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
		j.mu.Lock()
		running := j.running
		j.mu.Unlock()
		if running {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"ok":false,"reason":"training already running"}`))
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			_, _, _ = j.TryRun(ctx)
		}()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"ok":true,"started":true}`))
	}
}

// BotBrainHandler serves the play-affecting subset of the brain to the AMS bot
// DS (fetched at trigger time). Cached for 60s so a burst of triggers doesn't
// hammer CloudSave. Same shared-secret auth as the other bot endpoints.
func (j *TrainJob) BotBrainHandler(secret string) http.HandlerFunc {
	type cached struct {
		at   time.Time
		body []byte
	}
	var mu sync.Mutex
	var c cached
	return func(w http.ResponseWriter, r *http.Request) {
		if secret == "" || (r.Header.Get("x-trigger-secret") != secret && r.URL.Query().Get("key") != secret) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if c.body == nil || time.Since(c.at) > 60*time.Second {
			var brain botbrain.Brain
			found, err := fetchAdminValue(BotBrainKey(j.botID), &brain)
			if err != nil {
				log.Printf("bot-brain: fetch: %v", err)
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			out := map[string]any{"version": 0}
			if found {
				out["version"] = brain.Version
				if t := brain.PlayTuning; t != nil {
					out["difficulty"] = t.Difficulty
					out["thinkMsMean"] = t.ThinkMsMean
					out["thinkMsJitter"] = t.ThinkMsJitter
					out["maxShufflePlies"] = t.MaxShufflePlies
					out["book"] = t.Book
				}
			}
			body, _ := json.Marshal(out)
			c = cached{at: time.Now(), body: body}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(c.body)
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

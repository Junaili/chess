package handler

// TrainRoster runs the daily self-learning pass for every hosted personality.
//
// Each bot keeps its own TrainJob — its own persona directory, its own brain,
// its own CloudSave history — so a bot's reflections come out in its own voice.
// The roster is only the fan-out: one Task Scheduler entry drives them all, so
// adding a personality needs no new cron in the Admin Portal.

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

// PerBotTrainTimeout bounds a single bot's training pass. It is per bot rather
// than shared across the roster: one slow LLM reflection must not eat the
// budget the next bot needs.
const PerBotTrainTimeout = 5 * time.Minute

type TrainRoster struct {
	defaultID string
	order     []string
	jobs      map[string]*TrainJob
}

func NewTrainRoster(defaultID string) *TrainRoster {
	return &TrainRoster{defaultID: defaultID, jobs: map[string]*TrainJob{}}
}

// Add registers a personality's trainer, returning the job so the caller can
// wire per-bot extras (performance capture, profile status).
func (r *TrainRoster) Add(botID, botDir string) *TrainJob {
	if existing, ok := r.jobs[botID]; ok {
		return existing
	}
	job := NewTrainJob(botID, botDir)
	r.jobs[botID] = job
	r.order = append(r.order, botID)
	return job
}

// Default is the trainer for the default personality; nil if none registered.
func (r *TrainRoster) Default() *TrainJob { return r.jobs[r.defaultID] }

// Get returns a personality's trainer.
func (r *TrainRoster) Get(botID string) (*TrainJob, bool) {
	job, ok := r.jobs[strings.TrimSpace(botID)]
	return job, ok
}

// IDs lists the registered personalities in registration order.
func (r *TrainRoster) IDs() []string {
	return append([]string(nil), r.order...)
}

// RosterRunResult is the outcome of one bot's pass within a roster run.
type RosterRunResult struct {
	BotID    string         `json:"botId"`
	Status   map[string]any `json:"status,omitempty"`
	Conflict bool           `json:"conflict,omitempty"`
	Error    string         `json:"error,omitempty"`
}

// RunAll trains every registered personality, in sequence so concurrent LLM
// reflections don't stampede CloudSave or the model provider.
//
// The run id is namespaced per bot: TryRun dedupes on it, so a shared id would
// let the first bot's reservation swallow the second bot's run as a duplicate.
//
// One bot's failure never aborts the others — each is independent, and a bad
// persona file or a transient CloudSave error on one bot must not cost the rest
// of the roster its training day.
func (r *TrainRoster) RunAll(ctx context.Context, runID string) []RosterRunResult {
	results := make([]RosterRunResult, 0, len(r.order))
	for _, botID := range r.order {
		job := r.jobs[botID]
		if ctx.Err() != nil {
			results = append(results, RosterRunResult{BotID: botID, Error: ctx.Err().Error()})
			continue
		}
		botCtx, cancel := context.WithTimeout(ctx, PerBotTrainTimeout)
		st, conflict, err := job.TryRun(botCtx, runID+":"+botID)
		cancel()

		out := RosterRunResult{BotID: botID, Status: st, Conflict: conflict}
		if err != nil {
			out.Error = err.Error()
			log.Printf("train-roster: %s failed: %v", botID, err)
		} else if conflict {
			log.Printf("train-roster: %s already training, skipped", botID)
		}
		results = append(results, out)
	}
	return results
}

// resolve picks the trainer a request names via ?bot=, defaulting to the
// default personality when none is given.
func (r *TrainRoster) resolve(requested string) (*TrainJob, bool) {
	if requested = strings.TrimSpace(requested); requested == "" {
		requested = r.defaultID
	}
	job, ok := r.jobs[requested]
	return job, ok
}

// TrainHandler is the manual/debug trigger: POST {basePath}/bot/train[?bot=id].
// Delegates to the named personality's trainer.
func (r *TrainRoster) TrainHandler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		job, ok := r.resolve(req.URL.Query().Get("bot"))
		if !ok {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"unknown bot"}`, http.StatusBadRequest)
			return
		}
		job.TrainHandler(secret)(w, req)
	}
}

// TrainerDebugHandler reports one bot's trainer state (?bot=), or the whole
// roster's when no bot is named.
func (r *TrainRoster) TrainerDebugHandler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if secret == "" || (req.Header.Get("x-trigger-secret") != secret && req.URL.Query().Get("key") != secret) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if requested := strings.TrimSpace(req.URL.Query().Get("bot")); requested != "" {
			job, ok := r.jobs[requested]
			if !ok {
				w.Header().Set("Content-Type", "application/json")
				http.Error(w, `{"error":"unknown bot"}`, http.StatusBadRequest)
				return
			}
			job.TrainerDebugHandler(secret)(w, req)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"default": r.defaultID, "bots": r.Status()})
	}
}

// Status reports every bot's trainer state, for the debug endpoint.
func (r *TrainRoster) Status() map[string]any {
	out := make(map[string]any, len(r.order))
	for _, botID := range r.order {
		running, last := r.jobs[botID].Status()
		out[botID] = map[string]any{"running": running, "lastRun": last}
	}
	return out
}

// SetPerformanceCapture wires performance capture into every bot's trainer.
func (r *TrainRoster) SetPerformanceCapture(capture func(string)) {
	for _, botID := range r.order {
		r.jobs[botID].SetPerformanceCapture(capture)
	}
}

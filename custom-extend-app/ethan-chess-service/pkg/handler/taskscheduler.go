package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	ts "github.com/junaili/ethan-chess-service/pkg/pb/generic/task_scheduler/v1"
)

// ScheduledTaskHandler implements the AGS Extend Task Scheduler contract
// (accelbyte.extend.task_scheduler.v1.ScheduledTaskHandler): the platform
// sidecar calls RunScheduledTask on this app's gRPC server per the cron
// configured in the Admin Portal's Task Scheduler tab. Our one task is the
// daily self-learning training run, which trains every hosted personality —
// one cron entry for the whole roster, so adding a bot needs no portal change.
type ScheduledTaskHandler struct {
	roster *TrainRoster
}

func NewScheduledTaskHandler(roster *TrainRoster) *ScheduledTaskHandler {
	return &ScheduledTaskHandler{roster: roster}
}

func (h *ScheduledTaskHandler) RunScheduledTask(ctx context.Context, req *ts.ScheduledTaskRequest) (*ts.ScheduledTaskResponse, error) {
	if req == nil || strings.TrimSpace(req.GetRunId()) == "" {
		return &ts.ScheduledTaskResponse{Success: false, Message: "missing scheduler run id", HttpStatusCode: 400}, nil
	}
	if expected := strings.TrimSpace(os.Getenv("BOT_TRAIN_TASK_NAME")); expected != "" && req.GetTaskName() != expected {
		return &ts.ScheduledTaskResponse{Success: false, Message: "unexpected task name", HttpStatusCode: 400}, nil
	}
	if expectedNS := strings.TrimSpace(os.Getenv("AB_NAMESPACE")); req.GetNamespace() != "" && expectedNS != "" && req.GetNamespace() != expectedNS {
		return &ts.ScheduledTaskResponse{Success: false, Message: "unexpected namespace", HttpStatusCode: 400}, nil
	}
	scheduled := "(unspecified)"
	if req.GetScheduledTime() != nil {
		scheduled = req.GetScheduledTime().AsTime().Format(time.RFC3339)
	}
	log.Printf("task-scheduler: run=%s task=%q attempt=%d scheduled=%s",
		req.GetRunId(), req.GetTaskName(), req.GetAttemptNumber(), scheduled)

	// Respect sidecar cancellation so a timed-out attempt cannot continue in the
	// background and race its retry on another replica. Each bot gets its own
	// budget inside RunAll; this bounds the roster as a whole.
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(len(h.roster.IDs()))*PerBotTrainTimeout)
	defer cancel()

	results := h.roster.RunAll(runCtx, req.GetRunId())
	if len(results) == 0 {
		return &ts.ScheduledTaskResponse{Success: false, Message: "no bots registered for training", HttpStatusCode: 500}, nil
	}

	var trained, conflicts int
	var failures []string
	for _, res := range results {
		switch {
		case res.Error != "":
			failures = append(failures, res.BotID+": "+res.Error)
		case res.Conflict:
			conflicts++
		default:
			trained++
		}
	}

	result, _ := json.Marshal(results)
	switch {
	case conflicts == len(results):
		// Nothing ran, so a retry is genuinely warranted. Never acknowledge an
		// in-flight retry as successful: the original attempt may still fail.
		// Asking the scheduler to retry means it will eventually observe the
		// durable run ID or perform the work itself.
		return &ts.ScheduledTaskResponse{
			Success:        false,
			Message:        "every bot is already training; retry this scheduled run",
			ResultData:     string(result),
			HttpStatusCode: 409,
		}, nil
	case trained == 0 && len(failures) > 0:
		return &ts.ScheduledTaskResponse{
			Success:        false,
			Message:        strings.Join(failures, "; "),
			ResultData:     string(result),
			HttpStatusCode: 500,
		}, nil
	}
	// A bot that conflicted is already being trained by someone, and a bot that
	// failed has its own error recorded — neither should cost the bots that did
	// train their successful run by forcing a whole-roster retry.
	message := fmt.Sprintf("training run completed for %d/%d bots", trained, len(results))
	if len(failures) > 0 {
		message += " (failed — " + strings.Join(failures, "; ") + ")"
	}
	return &ts.ScheduledTaskResponse{
		Success:        true,
		Message:        message,
		ResultData:     string(result),
		HttpStatusCode: 200,
	}, nil
}

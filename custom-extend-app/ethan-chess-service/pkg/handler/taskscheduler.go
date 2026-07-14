package handler

import (
	"context"
	"encoding/json"
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
// daily self-learning training run.
type ScheduledTaskHandler struct {
	job *TrainJob
}

func NewScheduledTaskHandler(job *TrainJob) *ScheduledTaskHandler {
	return &ScheduledTaskHandler{job: job}
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
	// background and race its retry on another replica.
	runCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	st, conflict, err := h.job.TryRun(runCtx, req.GetRunId())
	switch {
	case conflict:
		// Never acknowledge an in-flight retry as successful: the original
		// attempt may still fail. Asking the scheduler to retry means it will
		// eventually observe the durable run ID or perform the work itself.
		active, _ := st["activeRunID"].(string)
		return &ts.ScheduledTaskResponse{
			Success:        false,
			Message:        "training run " + active + " is in progress; retry this scheduled run",
			HttpStatusCode: 409,
		}, nil
	case err != nil:
		return &ts.ScheduledTaskResponse{
			Success:        false,
			Message:        err.Error(),
			HttpStatusCode: 500,
		}, nil
	}
	result, _ := json.Marshal(st)
	return &ts.ScheduledTaskResponse{
		Success:        true,
		Message:        "training run completed",
		ResultData:     string(result),
		HttpStatusCode: 200,
	}, nil
}

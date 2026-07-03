package handler

import (
	"context"
	"encoding/json"
	"log"
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
	log.Printf("task-scheduler: run=%s task=%q attempt=%d scheduled=%s",
		req.GetRunId(), req.GetTaskName(), req.GetAttemptNumber(), req.GetScheduledTime().AsTime().Format(time.RFC3339))

	// Run detached from the sidecar's context so a caller-side timeout can't
	// abort a training pass (incl. the LLM reflection) mid-flight.
	runCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	st, conflict, err := h.job.TryRun(runCtx)
	switch {
	case conflict:
		return &ts.ScheduledTaskResponse{
			Success:        false,
			Message:        "training already running",
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

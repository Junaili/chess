package botgame

import (
	"context"
	"errors"
	"testing"

	"github.com/pion/webrtc/v3"
)

func TestAnswerContextStopsBeforeAllocatingForCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	answer, pc, err := AnswerContext(ctx, webrtc.SessionDescription{}, nil, "Gambit Gus")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if pc != nil || answer.SDP != "" {
		t.Fatalf("canceled setup returned answer=%#v pc=%p", answer, pc)
	}
}

package main

import (
	"testing"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

func gameEndedAt(t time.Time) botbrain.MatchEntry {
	return botbrain.MatchEntry{Result: "loss", EndedAt: t.UTC().Format(time.RFC3339)}
}

func TestRecentGameCountUsesTheWindow(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	games := []botbrain.MatchEntry{
		gameEndedAt(now.Add(-1 * time.Hour)),
		gameEndedAt(now.Add(-40 * time.Hour)),
		gameEndedAt(now.Add(-90 * time.Hour)),
		{Result: "loss"}, // no timestamp — must not count
	}
	if got := recentGameCount(games, now, 48*time.Hour); got != 2 {
		t.Fatalf("48h window: got %d, want 2", got)
	}
	if got := recentGameCount(nil, now, 48*time.Hour); got != 0 {
		t.Fatalf("empty history: got %d, want 0", got)
	}
}

// A bot that has never trained must not report "0 days since training" — that
// reads as healthy, which is how the 35-day outage stayed invisible.
func TestStaleTrainingDaysOmitsUnknown(t *testing.T) {
	t.Parallel()

	if got := staleTrainingDays(-1); got != nil {
		t.Fatalf("never-trained: got %v, want nil", got)
	}
	if got := staleTrainingDays(2.34); got != 2.3 {
		t.Fatalf("rounding: got %v, want 2.3", got)
	}
}

func TestStallWarningIsRateLimited(t *testing.T) {
	t.Parallel()

	g := &botHandlers{botID: "gambit-gus"}
	g.warnStalled(35)
	first := g.lastStallWarn
	if first.IsZero() {
		t.Fatal("first stall warning did not record a timestamp")
	}
	g.warnStalled(35)
	if !g.lastStallWarn.Equal(first) {
		t.Fatal("second warning within the hour should have been suppressed")
	}
}

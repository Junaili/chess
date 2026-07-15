package perftelemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestLiveAGSTelemetry(t *testing.T) {
	if os.Getenv("AGS_PERF_TELEMETRY_INTEGRATION") != "1" {
		t.Skip("set AGS_PERF_TELEMETRY_INTEGRATION=1 to emit one live smoke event")
	}
	reporter, enabled, err := NewFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !enabled {
		t.Fatal("performance telemetry is disabled")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var token cachedToken
	if err := reporter.send(ctx, &token, reporter.sample("integration_smoke")); err != nil {
		t.Fatal(err)
	}
}

func TestReporterSendsAGSGameTelemetryAndCachesToken(t *testing.T) {
	var tokenCalls atomic.Int32
	events := make(chan []telemetryEvent, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/iam/v3/oauth/token":
			tokenCalls.Add(1)
			if id, secret, ok := r.BasicAuth(); !ok || id != "client" || secret != "secret" {
				t.Errorf("unexpected basic auth: %q %q %v", id, secret, ok)
				http.Error(w, "bad auth", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"service-token","expires_in":3600}`))
		case "/game-telemetry/v1/protected/events":
			if got := r.Header.Get("Authorization"); got != "Bearer service-token" {
				t.Errorf("authorization = %q", got)
				http.Error(w, "bad auth", http.StatusUnauthorized)
				return
			}
			var payload []telemetryEvent
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode telemetry: %v", err)
				http.Error(w, "bad payload", http.StatusBadRequest)
				return
			}
			events <- payload
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	reporter, err := New(Config{
		BaseURL: server.URL, Namespace: "seal-chessags", ClientID: "client",
		ClientSecret: "secret", Interval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reporter.Start(ctx)
	reporter.Capture("training_finish")

	for i := 0; i < 2; i++ {
		select {
		case batch := <-events:
			if len(batch) != 1 {
				t.Fatalf("batch length = %d", len(batch))
			}
			if batch[0].EventNamespace != "seal-chessags" || batch[0].EventName != eventName {
				t.Fatalf("unexpected event identity: %+v", batch[0])
			}
			if batch[0].Payload.SchemaVersion != 1 || batch[0].Payload.Service != "ethan-chess-service" {
				t.Fatalf("unexpected payload: %+v", batch[0].Payload)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for telemetry")
		}
	}
	if got := tokenCalls.Load(); got != 1 {
		t.Fatalf("token calls = %d, want 1", got)
	}
}

func TestManualCaptureHandlerRequiresSecret(t *testing.T) {
	reporter, err := New(Config{
		BaseURL: "https://ags.test", Namespace: "seal", ClientID: "client",
		ClientSecret: "secret", Interval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := reporter.Handler("trigger")

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	authorized := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("x-trigger-secret", "trigger")
	handler.ServeHTTP(authorized, req)
	if authorized.Code != http.StatusAccepted {
		t.Fatalf("authorized status = %d", authorized.Code)
	}
	select {
	case item := <-reporter.queue:
		if item.payload.Reason != "manual" {
			t.Fatalf("capture reason = %q", item.payload.Reason)
		}
	default:
		t.Fatal("manual capture was not queued")
	}
}

func TestSnapshotContainsRuntimeGaugesAndDeltas(t *testing.T) {
	reporter, err := New(Config{
		BaseURL: "https://ags.test", Namespace: "seal", ClientID: "client",
		ClientSecret: "secret", Interval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	first := reporter.sample("first")
	time.Sleep(time.Millisecond)
	second := reporter.sample("second")

	if first.payload.Goroutines == 0 || first.payload.MemoryTotalBytes == 0 {
		t.Fatalf("missing runtime gauges: %+v", first.payload)
	}
	if second.payload.WindowSeconds <= 0 {
		t.Fatalf("window = %f", second.payload.WindowSeconds)
	}
	if second.payload.CPUUtilizationPercent < 0 || second.payload.CPUUtilizationPercent > 100 {
		t.Fatalf("cpu utilization = %f", second.payload.CPUUtilizationPercent)
	}
}

func BenchmarkReporterSample(b *testing.B) {
	reporter, err := New(Config{
		BaseURL: "https://ags.test", Namespace: "seal", ClientID: "client",
		ClientSecret: "secret", Interval: time.Hour,
	})
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		reporter.sample("periodic")
	}
}

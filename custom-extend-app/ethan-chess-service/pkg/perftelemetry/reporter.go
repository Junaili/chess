// Package perftelemetry captures low-overhead Go runtime measurements and
// forwards compact snapshots to AccelByte Game Telemetry.
package perftelemetry

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"runtime/metrics"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultInterval = 5 * time.Minute
	minimumInterval = 30 * time.Second
	queueCapacity   = 8
	eventName       = "gambitGusServerPerformance"
)

var metricNames = [...]string{
	"/cpu/classes/total:cpu-seconds",
	"/cpu/classes/idle:cpu-seconds",
	"/cpu/classes/gc/total:cpu-seconds",
	"/gc/cycles/total:gc-cycles",
	"/gc/heap/allocs:bytes",
	"/gc/heap/frees:bytes",
	"/gc/heap/live:bytes",
	"/gc/heap/objects:objects",
	"/gc/heap/goal:bytes",
	"/gc/gogc:percent",
	"/gc/gomemlimit:bytes",
	"/memory/classes/total:bytes",
	"/memory/classes/heap/released:bytes",
	"/memory/classes/heap/stacks:bytes",
	"/sched/goroutines:goroutines",
	"/sync/mutex/wait/total:seconds",
}

type Config struct {
	BaseURL      string
	Namespace    string
	ClientID     string
	ClientSecret string
	Service      string
	Interval     time.Duration
	HTTPClient   *http.Client
}

type Reporter struct {
	config   Config
	instance string
	samples  []metrics.Sample
	queue    chan capture
	started  time.Time

	mu       sync.Mutex
	previous runtimeSnapshot
	havePrev bool
	sequence uint64

	dropped atomic.Uint64
}

type runtimeSnapshot struct {
	at             time.Time
	cpuTotal       float64
	cpuIdle        float64
	cpuGC          float64
	gcCycles       uint64
	allocBytes     uint64
	freedBytes     uint64
	heapLiveBytes  uint64
	heapObjects    uint64
	heapGoalBytes  uint64
	gcPercent      uint64
	memoryLimit    uint64
	memoryTotal    uint64
	heapReleased   uint64
	heapStackBytes uint64
	goroutines     uint64
	mutexWait      float64
}

type capture struct {
	timestamp time.Time
	payload   Payload
}

type Payload struct {
	SchemaVersion int     `json:"schema_version"`
	Service       string  `json:"service"`
	Instance      string  `json:"instance"`
	Reason        string  `json:"reason"`
	Sequence      uint64  `json:"sequence"`
	UptimeSeconds float64 `json:"uptime_seconds"`
	WindowSeconds float64 `json:"window_seconds"`

	GoVersion  string `json:"go_version"`
	GOOS       string `json:"goos"`
	GOARCH     string `json:"goarch"`
	NumCPU     int    `json:"num_cpu"`
	GOMAXPROCS int    `json:"gomaxprocs"`

	CPUUtilizationPercent  float64 `json:"cpu_utilization_percent"`
	CPUBusySeconds         float64 `json:"cpu_busy_seconds"`
	GCCPUPercent           float64 `json:"gc_cpu_percent"`
	GCCPUSeconds           float64 `json:"gc_cpu_seconds"`
	AllocationBytes        uint64  `json:"allocation_bytes"`
	AllocationBytesPerSec  float64 `json:"allocation_bytes_per_second"`
	FreedBytes             uint64  `json:"freed_bytes"`
	GCCycles               uint64  `json:"gc_cycles"`
	GCCyclesPerMinute      float64 `json:"gc_cycles_per_minute"`
	MutexWaitSeconds       float64 `json:"mutex_wait_seconds"`
	MutexWaitSecondsPerSec float64 `json:"mutex_wait_seconds_per_second"`

	HeapLiveBytes     uint64 `json:"heap_live_bytes"`
	HeapObjects       uint64 `json:"heap_objects"`
	HeapGoalBytes     uint64 `json:"heap_goal_bytes"`
	HeapReleasedBytes uint64 `json:"heap_released_bytes"`
	HeapStackBytes    uint64 `json:"heap_stack_bytes"`
	MemoryTotalBytes  uint64 `json:"memory_total_bytes"`
	MemoryLimitBytes  uint64 `json:"memory_limit_bytes"`
	GCPercent         uint64 `json:"gc_percent"`
	Goroutines        uint64 `json:"goroutines"`
	DroppedCaptures   uint64 `json:"dropped_captures"`
}

type telemetryEvent struct {
	EventNamespace  string  `json:"EventNamespace"`
	EventName       string  `json:"EventName"`
	ClientTimestamp string  `json:"ClientTimestamp"`
	Payload         Payload `json:"Payload"`
}

func New(config Config) (*Reporter, error) {
	config.BaseURL = strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	config.Namespace = strings.TrimSpace(config.Namespace)
	config.ClientID = strings.TrimSpace(config.ClientID)
	if config.BaseURL == "" || config.Namespace == "" || config.ClientID == "" || config.ClientSecret == "" {
		return nil, errors.New("performance telemetry requires AGS base URL, namespace, client ID, and client secret")
	}
	if config.Service == "" {
		config.Service = "ethan-chess-service"
	}
	if config.Interval == 0 {
		config.Interval = defaultInterval
	}
	if config.Interval < minimumInterval {
		return nil, fmt.Errorf("performance telemetry interval must be at least %s", minimumInterval)
	}
	if config.HTTPClient == nil {
		config.HTTPClient = &http.Client{Timeout: 10 * time.Second}
	}

	samples := make([]metrics.Sample, len(metricNames))
	for i, name := range metricNames {
		samples[i].Name = name
	}
	return &Reporter{
		config:   config,
		instance: instanceName(),
		samples:  samples,
		queue:    make(chan capture, queueCapacity),
		started:  time.Now(),
	}, nil
}

// NewFromEnv enables telemetry unless PERF_TELEMETRY_ENABLED is explicitly
// false. The existing confidential Extend credentials are reused server-side.
func NewFromEnv() (*Reporter, bool, error) {
	enabled, err := envBool("PERF_TELEMETRY_ENABLED", true)
	if err != nil || !enabled {
		return nil, enabled, err
	}
	interval := defaultInterval
	if raw := strings.TrimSpace(os.Getenv("PERF_TELEMETRY_INTERVAL")); raw != "" {
		interval, err = time.ParseDuration(raw)
		if err != nil {
			return nil, true, fmt.Errorf("parse PERF_TELEMETRY_INTERVAL: %w", err)
		}
	}
	reporter, err := New(Config{
		BaseURL:      os.Getenv("AB_BASE_URL"),
		Namespace:    os.Getenv("AB_NAMESPACE"),
		ClientID:     os.Getenv("AB_CLIENT_ID"),
		ClientSecret: os.Getenv("AB_CLIENT_SECRET"),
		Service:      "ethan-chess-service",
		Interval:     interval,
	})
	return reporter, true, err
}

func envBool(name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", name)
	}
	return value, nil
}

// Start launches one sender goroutine. Capture never performs network I/O and
// drops rather than blocks when the bounded queue is full.
func (r *Reporter) Start(ctx context.Context) {
	go r.run(ctx)
	r.Capture("startup")
}

func (r *Reporter) run(ctx context.Context) {
	ticker := time.NewTicker(r.config.Interval)
	defer ticker.Stop()
	var token cachedToken
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.Capture("periodic")
		case item := <-r.queue:
			sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := r.send(sendCtx, &token, item)
			cancel()
			if err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("performance telemetry: %v", err)
			}
		}
	}
}

// Capture samples runtime counters and enqueues a compact delta snapshot.
func (r *Reporter) Capture(reason string) {
	item := r.sample(reason)
	select {
	case r.queue <- item:
	default:
		r.dropped.Add(1)
	}
}

func (r *Reporter) sample(reason string) capture {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	metrics.Read(r.samples)
	current := runtimeSnapshot{
		at:             now,
		cpuTotal:       floatMetric(r.samples[0]),
		cpuIdle:        floatMetric(r.samples[1]),
		cpuGC:          floatMetric(r.samples[2]),
		gcCycles:       uintMetric(r.samples[3]),
		allocBytes:     uintMetric(r.samples[4]),
		freedBytes:     uintMetric(r.samples[5]),
		heapLiveBytes:  uintMetric(r.samples[6]),
		heapObjects:    uintMetric(r.samples[7]),
		heapGoalBytes:  uintMetric(r.samples[8]),
		gcPercent:      uintMetric(r.samples[9]),
		memoryLimit:    uintMetric(r.samples[10]),
		memoryTotal:    uintMetric(r.samples[11]),
		heapReleased:   uintMetric(r.samples[12]),
		heapStackBytes: uintMetric(r.samples[13]),
		goroutines:     uintMetric(r.samples[14]),
		mutexWait:      floatMetric(r.samples[15]),
	}

	r.sequence++
	payload := Payload{
		SchemaVersion:     1,
		Service:           r.config.Service,
		Instance:          r.instance,
		Reason:            sanitizeReason(reason),
		Sequence:          r.sequence,
		UptimeSeconds:     now.Sub(r.started).Seconds(),
		GoVersion:         runtime.Version(),
		GOOS:              runtime.GOOS,
		GOARCH:            runtime.GOARCH,
		NumCPU:            runtime.NumCPU(),
		GOMAXPROCS:        runtime.GOMAXPROCS(0),
		HeapLiveBytes:     current.heapLiveBytes,
		HeapObjects:       current.heapObjects,
		HeapGoalBytes:     current.heapGoalBytes,
		HeapReleasedBytes: current.heapReleased,
		HeapStackBytes:    current.heapStackBytes,
		MemoryTotalBytes:  current.memoryTotal,
		MemoryLimitBytes:  current.memoryLimit,
		GCPercent:         current.gcPercent,
		Goroutines:        current.goroutines,
		DroppedCaptures:   r.dropped.Load(),
	}
	if r.havePrev {
		window := current.at.Sub(r.previous.at).Seconds()
		if window > 0 {
			busy := nonNegativeFloat((current.cpuTotal - current.cpuIdle) - (r.previous.cpuTotal - r.previous.cpuIdle))
			gcCPU := nonNegativeFloat(current.cpuGC - r.previous.cpuGC)
			alloc := nonNegativeUint(current.allocBytes, r.previous.allocBytes)
			freed := nonNegativeUint(current.freedBytes, r.previous.freedBytes)
			cycles := nonNegativeUint(current.gcCycles, r.previous.gcCycles)
			mutexWait := nonNegativeFloat(current.mutexWait - r.previous.mutexWait)
			capacity := window * float64(payload.GOMAXPROCS)

			payload.WindowSeconds = window
			payload.CPUBusySeconds = busy
			payload.GCCPUSeconds = gcCPU
			payload.AllocationBytes = alloc
			payload.FreedBytes = freed
			payload.GCCycles = cycles
			payload.MutexWaitSeconds = mutexWait
			payload.AllocationBytesPerSec = float64(alloc) / window
			payload.GCCyclesPerMinute = float64(cycles) * 60 / window
			payload.MutexWaitSecondsPerSec = mutexWait / window
			if capacity > 0 {
				payload.CPUUtilizationPercent = clampPercent(busy * 100 / capacity)
				payload.GCCPUPercent = clampPercent(gcCPU * 100 / capacity)
			}
		}
	}
	r.previous = current
	r.havePrev = true
	return capture{timestamp: now.UTC(), payload: payload}
}

func floatMetric(sample metrics.Sample) float64 {
	if sample.Value.Kind() != metrics.KindFloat64 {
		return 0
	}
	return sample.Value.Float64()
}

func uintMetric(sample metrics.Sample) uint64 {
	if sample.Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return sample.Value.Uint64()
}

func nonNegativeFloat(value float64) float64 {
	if value < 0 {
		return 0
	}
	return value
}

func nonNegativeUint(current, previous uint64) uint64 {
	if current < previous {
		return 0
	}
	return current - previous
}

func clampPercent(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func sanitizeReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return "unspecified"
	}
	if len(reason) > 48 {
		return reason[:48]
	}
	return reason
}

func instanceName() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "unknown"
	}
	return name
}

type cachedToken struct {
	value     string
	expiresAt time.Time
}

func (r *Reporter) send(ctx context.Context, token *cachedToken, item capture) error {
	accessToken, err := r.accessToken(ctx, token)
	if err != nil {
		return fmt.Errorf("get AGS token: %w", err)
	}
	body, err := json.Marshal([]telemetryEvent{{
		EventNamespace:  r.config.Namespace,
		EventName:       eventName,
		ClientTimestamp: item.timestamp.Format(time.RFC3339Nano),
		Payload:         item.payload,
	}})
	if err != nil {
		return fmt.Errorf("encode event: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		r.config.BaseURL+"/game-telemetry/v1/protected/events", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.config.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("send event: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		if resp.StatusCode == http.StatusUnauthorized {
			token.value = ""
			token.expiresAt = time.Time{}
		}
		return fmt.Errorf("event endpoint returned status %d", resp.StatusCode)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return nil
}

func (r *Reporter) accessToken(ctx context.Context, cached *cachedToken) (string, error) {
	now := time.Now()
	if cached.value != "" && now.Add(30*time.Second).Before(cached.expiresAt) {
		return cached.value, nil
	}
	values := url.Values{"grant_type": {"client_credentials"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		r.config.BaseURL+"/iam/v3/oauth/token", strings.NewReader(values.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(r.config.ClientID, r.config.ClientSecret)
	resp, err := r.config.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return "", fmt.Errorf("IAM token endpoint returned status %d", resp.StatusCode)
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&payload); err != nil {
		return "", err
	}
	if payload.AccessToken == "" {
		return "", errors.New("IAM returned an empty access token")
	}
	if payload.ExpiresIn <= 0 {
		payload.ExpiresIn = 300
	}
	cached.value = payload.AccessToken
	cached.expiresAt = now.Add(time.Duration(payload.ExpiresIn) * time.Second)
	return cached.value, nil
}

// Handler queues an on-demand capture. It accepts the trigger secret only in a
// header so credentials do not leak into query strings or access logs.
func (r *Reporter) Handler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		provided := req.Header.Get("x-trigger-secret")
		if secret == "" || len(provided) != len(secret) ||
			subtle.ConstantTimeCompare([]byte(provided), []byte(secret)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		r.Capture("manual")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"status":"accepted"}`)
	}
}

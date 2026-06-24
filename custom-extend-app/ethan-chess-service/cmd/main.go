package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	"github.com/junaili/ethan-chess-service/pkg/common"
	pb "github.com/junaili/ethan-chess-service/pkg/pb"
	"github.com/junaili/ethan-chess-service/pkg/service"
)

const (
	grpcPort    = 6565
	gatewayPort = 8000
)

func main() {
	_ = godotenv.Load()

	for _, key := range []string{"GMAIL_USER", "GMAIL_APP_PW"} {
		if os.Getenv(key) == "" {
			log.Printf("WARNING: %s is not set — email sending will fail", key)
		}
	}

	basePath := os.Getenv("BASE_PATH")
	if basePath != "" && !strings.HasPrefix(basePath, "/") {
		basePath = "/" + basePath
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// gRPC server on port 6565
	grpcServer := grpc.NewServer()
	pb.RegisterChessServiceServer(grpcServer, service.NewChessServiceServer())
	reflection.Register(grpcServer)
	grpc_health_v1.RegisterHealthServer(grpcServer, health.NewServer())

	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", grpcPort))
	if err != nil {
		log.Fatalf("failed to listen on :%d: %v", grpcPort, err)
	}
	go func() {
		log.Printf("gRPC server listening on :%d", grpcPort)
		if err := grpcServer.Serve(lis); err != nil {
			log.Printf("gRPC server error: %v", err)
		}
	}()

	// HTTP gateway on port 8000
	gateway, err := common.NewGateway(ctx, fmt.Sprintf("localhost:%d", grpcPort), basePath)
	if err != nil {
		log.Fatalf("failed to create HTTP gateway: %v", err)
	}

	allowedOrigins := parseAllowedOrigins(os.Getenv("ALLOWED_ORIGIN"))

	auth := newAuthMiddleware(
		strings.TrimRight(os.Getenv("AB_BASE_URL"), "/"),
		os.Getenv("AB_CLIENT_ID"),
		os.Getenv("AB_CLIENT_SECRET"),
	)

	mux := http.NewServeMux()

	// Health check (no auth)
	mux.HandleFunc(basePath+"/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})

	// Swagger UI (no auth)
	swaggerUIPath := basePath + "/apidocs/"
	mux.Handle(swaggerUIPath, http.StripPrefix(swaggerUIPath,
		http.FileServer(http.Dir("third_party/swagger-ui"))))

	// Swagger JSON (no auth, basePath injected at runtime)
	mux.HandleFunc(basePath+"/apidocs/api.json", makeSwaggerJSONHandler(basePath))

	// API routes (auth required)
	mux.Handle("/", corsMiddleware(allowedOrigins, auth.wrap(gateway)))

	httpServer := &http.Server{
		Addr:    fmt.Sprintf(":%d", gatewayPort),
		Handler: mux,
	}

	go func() {
		log.Printf("HTTP gateway listening on :%d (basePath: %q)", gatewayPort, basePath)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP gateway error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")
	grpcServer.GracefulStop()
	_ = httpServer.Shutdown(context.Background())
}

// parseAllowedOrigins splits a comma-separated ALLOWED_ORIGIN env var into a set.
// Falls back to the GitHub Pages origin when the env var is empty.
func parseAllowedOrigins(raw string) map[string]struct{} {
	defaults := []string{"https://junaili.github.io", "https://localhost:8808"}
	set := make(map[string]struct{})
	if raw == "" {
		for _, o := range defaults {
			set[o] = struct{}{}
		}
		return set
	}
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			set[o] = struct{}{}
		}
	}
	return set
}

func corsMiddleware(allowed map[string]struct{}, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if _, ok := allowed[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// makeSwaggerJSONHandler reads gateway/apidocs/service.swagger.json and
// patches basePath at runtime so the Swagger UI calls the right prefix.
func makeSwaggerJSONHandler(basePath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		matches, err := filepath.Glob("gateway/apidocs/*.swagger.json")
		if err != nil || len(matches) == 0 {
			http.Error(w, "swagger spec not found", http.StatusNotFound)
			return
		}
		raw, err := os.ReadFile(matches[0])
		if err != nil {
			http.Error(w, "failed to read swagger spec", http.StatusInternalServerError)
			return
		}
		var spec map[string]interface{}
		if err := json.Unmarshal(raw, &spec); err != nil {
			http.Error(w, "failed to parse swagger spec", http.StatusInternalServerError)
			return
		}
		spec["basePath"] = basePath
		out, _ := json.MarshalIndent(spec, "", "  ")
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
	}
}

// emailRateLimiter enforces a per-user cap on email sends.
// max sends are allowed per window; old timestamps are pruned on each check.
type emailRateLimiter struct {
	mu      sync.Mutex
	records map[string][]time.Time
	window  time.Duration
	max     int
}

func newEmailRateLimiter(max int, window time.Duration) *emailRateLimiter {
	return &emailRateLimiter{records: make(map[string][]time.Time), window: window, max: max}
}

// allow returns true and records the attempt when the user is within their quota.
func (rl *emailRateLimiter) allow(userSub string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-rl.window)
	prev := rl.records[userSub]
	var recent []time.Time
	for _, t := range prev {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	if len(recent) >= rl.max {
		rl.records[userSub] = recent
		return false
	}
	rl.records[userSub] = append(recent, now)
	return true
}

// authMiddleware validates Bearer tokens using IAM token introspection.
type authMiddleware struct {
	baseURL      string
	clientID     string
	clientSecret string
	emailLimiter *emailRateLimiter
}

func newAuthMiddleware(baseURL, clientID, clientSecret string) *authMiddleware {
	return &authMiddleware{
		baseURL:      baseURL,
		clientID:     clientID,
		clientSecret: clientSecret,
		emailLimiter: newEmailRateLimiter(5, time.Hour),
	}
}

func (a *authMiddleware) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip validation if credentials are not configured (local dev)
		if a.clientSecret == "" {
			next.ServeHTTP(w, r)
			return
		}

		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			http.Error(w, `{"error":"missing bearer token"}`, http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(header, "Bearer ")

		sub, active, err := a.introspect(token)
		if err != nil || !active {
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		// Rate-limit the email send endpoint: 5 per user per hour.
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/invite/email") {
			if !a.emailLimiter.allow(sub) {
				http.Error(w, `{"error":"too many invite emails, try again later"}`, http.StatusTooManyRequests)
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

func (a *authMiddleware) introspect(token string) (sub string, active bool, err error) {
	endpoint := a.baseURL + "/iam/v3/oauth/introspect"

	body := url.Values{}
	body.Set("token", token)

	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(body.Encode()))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(a.clientID, a.clientSecret)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", false, err
	}

	var result struct {
		Active bool   `json:"active"`
		Sub    string `json:"sub"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", false, err
	}
	return result.Sub, result.Active, nil
}


package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"

	"github.com/junaili/ethan-chess-service/pkg/common"
	"github.com/junaili/ethan-chess-service/pkg/handler"
	pb "github.com/junaili/ethan-chess-service/pkg/pb"
	taskscheduler "github.com/junaili/ethan-chess-service/pkg/pb/generic/task_scheduler/v1"
	"github.com/junaili/ethan-chess-service/pkg/service"
)

const (
	grpcPort    = 6565
	gatewayPort = 8000
)

func main() {
	_ = godotenv.Load()

	var missing []string
	for _, key := range []string{
		"AB_BASE_URL",
		"AB_CLIENT_ID",
		"AB_CLIENT_SECRET",
		"AB_NAMESPACE",
		"GMAIL_USER",
		"GMAIL_APP_PW",
	} {
		if os.Getenv(key) == "" {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		log.Fatalf("required configuration is missing: %s", strings.Join(missing, ", "))
	}

	basePath := os.Getenv("BASE_PATH")
	if basePath != "" && !strings.HasPrefix(basePath, "/") {
		basePath = "/" + basePath
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// gRPC server on port 6565
	internalToken, err := generateInternalGatewayToken()
	if err != nil {
		log.Fatalf("failed to generate internal gateway token: %v", err)
	}
	// Bot self-learning (created before gRPC registration: the Extend Task
	// Scheduler sidecar invokes RunScheduledTask on this server daily).
	botID := os.Getenv("BOT_ID")
	if botID == "" {
		botID = "gambit-gus"
	}
	botDir := os.Getenv("BOT_DIR")
	if botDir == "" {
		botDir = "bots/" + botID
	}
	trainJob := handler.NewTrainJob(botID, botDir)

	grpcServer := grpc.NewServer(
		grpc.UnaryInterceptor(internalGatewayAuthInterceptor(internalToken)),
		grpc.MaxRecvMsgSize(64<<10),
		grpc.MaxSendMsgSize(1<<20),
	)
	pb.RegisterChessServiceServer(grpcServer, service.NewChessServiceServer())
	taskscheduler.RegisterScheduledTaskHandlerServer(grpcServer, handler.NewScheduledTaskHandler(trainJob))
	if strings.EqualFold(os.Getenv("ENABLE_GRPC_REFLECTION"), "true") {
		reflection.Register(grpcServer)
	}
	grpc_health_v1.RegisterHealthServer(grpcServer, health.NewServer())

	lis, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", grpcPort))
	if err != nil {
		log.Fatalf("failed to listen on :%d: %v", grpcPort, err)
	}
	go func() {
		log.Printf("gRPC server listening on 127.0.0.1:%d", grpcPort)
		if err := grpcServer.Serve(lis); err != nil {
			log.Printf("gRPC server error: %v", err)
		}
	}()

	// HTTP gateway on port 8000
	gateway, err := common.NewGateway(ctx, fmt.Sprintf("localhost:%d", grpcPort), basePath, internalToken)
	if err != nil {
		log.Fatalf("failed to create HTTP gateway: %v", err)
	}

	allowedOrigins := parseAllowedOrigins(os.Getenv("ALLOWED_ORIGIN"))

	auth := newAuthMiddleware(
		strings.TrimRight(os.Getenv("AB_BASE_URL"), "/"),
		os.Getenv("AB_CLIENT_ID"),
		os.Getenv("AB_CLIENT_SECRET"),
		os.Getenv("AB_NAMESPACE"),
	)

	mux := http.NewServeMux()

	// Health check (no auth)
	mux.HandleFunc(basePath+"/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})

	if strings.EqualFold(os.Getenv("ENABLE_API_DOCS"), "true") {
		swaggerUIPath := basePath + "/apidocs/"
		mux.Handle(swaggerUIPath, http.StripPrefix(swaggerUIPath,
			http.FileServer(http.Dir("third_party/swagger-ui"))))
		mux.HandleFunc(basePath+"/apidocs/api.json", makeSwaggerJSONHandler(basePath))
	}

	// Referral report → unlock the inviter's chess-recruiter achievement (auth required)
	mux.Handle(basePath+"/referral", corsMiddleware(allowedOrigins, auth.wrap(http.HandlerFunc(referralHandler))))

	// Native account deletion. The authenticated user comes from token
	// introspection; Apple credentials and the AGS S2S client stay server-side.
	accountDeletion := newAccountDeletionHandlerFromEnv()
	mux.Handle(basePath+"/account/deletion-requirements",
		corsMiddleware(allowedOrigins, auth.wrap(http.HandlerFunc(accountDeletion.requirements))))
	mux.Handle(basePath+"/account/deletion",
		corsMiddleware(allowedOrigins, auth.wrap(http.HandlerFunc(accountDeletion.deleteAccount))))

	// Reporting does not expose browser CORS headers. Keep the player token so
	// AGS records the authenticated player as the reporter, while this service
	// provides the browser-facing CORS boundary.
	safety := newSafetyProxyFromEnv()
	mux.Handle(basePath+"/safety/reasons",
		corsMiddleware(allowedOrigins, auth.wrap(http.HandlerFunc(safety.reasons))))
	mux.Handle(basePath+"/safety/reports",
		corsMiddleware(allowedOrigins, auth.wrap(http.HandlerFunc(safety.reports))))

	// Bot self-learning: game intake from the AMS bot DS (shared-secret auth)
	mux.HandleFunc(basePath+"/bot/games", handler.BotGamesHandler(os.Getenv("BOT_TRIGGER_SECRET"), botID))

	// Daily self-learning: the Task Scheduler invokes training via gRPC
	// (RunScheduledTask); this HTTP endpoint is the manual/debug trigger.
	mux.HandleFunc(basePath+"/bot/train", trainJob.TrainHandler(os.Getenv("BOT_TRIGGER_SECRET")))
	mux.HandleFunc(basePath+"/bot/brain", trainJob.BotBrainHandler(os.Getenv("BOT_TRIGGER_SECRET")))
	mux.HandleFunc(basePath+"/debug/trainer", trainJob.TrainerDebugHandler(os.Getenv("BOT_TRIGGER_SECRET")))

	// API routes (auth required)
	mux.Handle("/", corsMiddleware(allowedOrigins, auth.wrap(gateway)))

	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%d", gatewayPort),
		Handler:           securityHeadersMiddleware(http.MaxBytesHandler(mux, 64<<10)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	go func() {
		log.Printf("HTTP gateway listening on :%d (basePath: %q)", gatewayPort, basePath)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP gateway error: %v", err)
		}
	}()

	// Cold-start bot gate: watch the match pool and trigger the bot to queue when
	// a human has waited longer than the threshold (enabled via MATCH_WATCHER_*).
	if w, ok := handler.NewMatchWatcherFromEnv(); ok {
		// Debug endpoint: GET {basePath}/debug/watcher?key=<BOT_TRIGGER_SECRET>
		mux.HandleFunc(basePath+"/debug/watcher", w.DebugHandler(os.Getenv("BOT_TRIGGER_SECRET")))
		go w.Start(ctx)
	}

	<-ctx.Done()
	log.Println("shutting down")
	grpcServer.GracefulStop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}

func generateInternalGatewayToken() (string, error) {
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return "", err
	}
	return hex.EncodeToString(token), nil
}

func internalGatewayAuthInterceptor(expectedToken string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		if strings.HasPrefix(info.FullMethod, "/grpc.health.v1.Health/") {
			return handler(ctx, req)
		}
		// Extend Task Scheduler: the platform sidecar (same pod, localhost) calls
		// this without the internal gateway token; it only triggers the guarded,
		// idempotent training run.
		if strings.HasPrefix(info.FullMethod, "/accelbyte.extend.task_scheduler.v1.ScheduledTaskHandler/") {
			return handler(ctx, req)
		}
		if !strings.HasPrefix(info.FullMethod, "/chessservice.ChessService/") {
			return nil, status.Error(codes.PermissionDenied, "method not allowed")
		}
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "gateway authentication required")
		}
		values := md.Get("x-internal-gateway-token")
		if len(values) != 1 ||
			subtle.ConstantTimeCompare([]byte(values[0]), []byte(expectedToken)) != 1 {
			return nil, status.Error(codes.Unauthenticated, "gateway authentication required")
		}
		return handler(ctx, req)
	}
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// parseAllowedOrigins splits a comma-separated ALLOWED_ORIGIN env var into a set.
// Falls back to the GitHub Pages origin when the env var is empty.
func parseAllowedOrigins(raw string) map[string]struct{} {
	defaults := []string{"https://junaili.github.io", "https://localhost:8808", "capacitor://localhost"}
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
		if origin != "" {
			if _, ok := allowed[origin]; !ok {
				http.Error(w, `{"error":"origin not allowed"}`, http.StatusForbidden)
				return
			}
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
	baseURL         string
	clientID        string
	clientSecret    string
	namespace       string
	httpClient      *http.Client
	emailLimiter    *emailRateLimiter
	referralLimiter *emailRateLimiter
	lookupLimiter   *emailRateLimiter
}

func newAuthMiddleware(baseURL, clientID, clientSecret, namespace string) *authMiddleware {
	return &authMiddleware{
		baseURL:         baseURL,
		clientID:        clientID,
		clientSecret:    clientSecret,
		namespace:       namespace,
		httpClient:      &http.Client{Timeout: 10 * time.Second},
		emailLimiter:    newEmailRateLimiter(5, time.Hour),
		referralLimiter: newEmailRateLimiter(3, time.Hour),
		lookupLimiter:   newEmailRateLimiter(10, time.Hour),
	}
}

func (a *authMiddleware) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		parts := strings.Fields(header)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			http.Error(w, `{"error":"missing bearer token"}`, http.StatusUnauthorized)
			return
		}
		token := parts[1]

		sub, active, err := a.introspect(token)
		if err != nil {
			log.Printf("[auth] token introspection failed: %v", err)
		}
		if err != nil || !active || sub == "" {
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

		// Rate-limit referral reports: 3 per user per hour.
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/referral") {
			if !a.referralLimiter.allow(sub) {
				http.Error(w, `{"error":"too many referral reports, try again later"}`, http.StatusTooManyRequests)
				return
			}
		}

		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/lookup/email") {
			if !a.lookupLimiter.allow(sub) {
				http.Error(w, `{"error":"too many account lookups, try again later"}`, http.StatusTooManyRequests)
				return
			}
		}

		// Make the authenticated user id available to downstream handlers.
		r = r.WithContext(context.WithValue(r.Context(), subCtxKey, sub))
		next.ServeHTTP(w, r)
	})
}

// subCtxKey carries the authenticated user id (token sub) into handlers.
type ctxKey string

const subCtxKey ctxKey = "ab-sub"

func subFromContext(ctx context.Context) string {
	v, _ := ctx.Value(subCtxKey).(string)
	return v
}

// referralHandler unlocks the inviter's chess-recruiter achievement when a
// newly-registered user (the authenticated caller) reports who referred them.
func referralHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	newUserID := subFromContext(r.Context())
	if newUserID == "" {
		http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
		return
	}
	var body struct {
		InviterUserID string `json:"inviterUserId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}
	inviter := strings.TrimSpace(body.InviterUserID)
	if inviter == "" || inviter == newUserID || len(inviter) > 128 ||
		strings.ContainsAny(inviter, "\r\n\t /?#") {
		http.Error(w, `{"error":"invalid inviter"}`, http.StatusBadRequest)
		return
	}
	if err := handler.UnlockRecruiterAchievement(inviter); err != nil {
		log.Printf("[referral] unlock failed (inviter=%s): %v", inviter, err)
		http.Error(w, `{"error":"unlock failed"}`, http.StatusInternalServerError)
		return
	}
	log.Printf("[referral] new user %s recruited by %s — recruiter unlocked", newUserID, inviter)
	fmt.Fprint(w, `{"ok":true}`)
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

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("introspection returned status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", false, err
	}

	var result struct {
		Active    bool   `json:"active"`
		Sub       string `json:"sub"`
		Namespace string `json:"namespace"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", false, err
	}
	if result.Namespace != a.namespace {
		return "", false, nil
	}
	return result.Sub, result.Active, nil
}

package main

// "Coach Gus" journal narrative — journal Phase 4:
//
//	POST {basePath}/coach/report
//
// The client's journal builds a fully deterministic coach report; this
// endpoint layers 3–5 sentences in Gambit Gus's voice on top. Design rules
// (docs/ags-plans journal plan §7):
//
//   - Deterministic-first: the narrative is garnish, never load-bearing. When
//     the LLM is unconfigured or errors, respond 200 {"available": false} —
//     a distinct signal, not an error — and the client shows the
//     deterministic report unchanged.
//   - PII-free by construction: the request carries aggregates and SAN moves
//     only. SAN fields are whitelist-validated (they end up in the prompt),
//     free-text fields are clamped, and nothing identifying the player or
//     their opponents is accepted at all.
//   - Child sessions never call this endpoint (client-side gate) — no child
//     data goes to an LLM, period.
//
// Wiring mirrors gus_profile.go: corsMiddleware + auth.wrap, per-player and
// global rate limits sized for "a few journal entries a day", not chat.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/llm"
)

const (
	coachMomentCap    = 3
	coachNoteMaxChars = 900
	coachLabelMax     = 160
)

// SAN only — anything else is dropped before it can reach the prompt
// (e4, Nxf5+, O-O-O, e8=Q#, Rae1, ...).
var coachSANPattern = regexp.MustCompile(`^[a-hKQRBNOx1-8=+#\-]{1,10}$`)

type coachMoment struct {
	Kind      string  `json:"kind"` // "punished" | "swing"
	San       string  `json:"san"`
	GainPawns float64 `json:"gainPawns"`
}

type coachMistake struct {
	San       string  `json:"san"`
	BestSan   string  `json:"bestSan"`
	LossPawns float64 `json:"lossPawns"`
	Phase     string  `json:"phase"` // opening | middlegame | endgame
}

type coachGoal struct {
	Label    string `json:"label"`
	Achieved *bool  `json:"achieved,omitempty"`
	Detail   string `json:"detail,omitempty"`
}

type coachReportRequest struct {
	Window string `json:"window"`
	Record struct {
		Wins   int `json:"wins"`
		Losses int `json:"losses"`
		Draws  int `json:"draws"`
	} `json:"record"`
	Accuracy struct {
		MovesGraded  int     `json:"movesGraded"`
		StrongRate   float64 `json:"strongRate"`
		BlunderCount int     `json:"blunderCount"`
		WeakestPhase string  `json:"weakestPhase"`
	} `json:"accuracy"`
	BestMoments  []coachMoment  `json:"bestMoments"`
	Mistakes     []coachMistake `json:"mistakes"`
	Goal         string         `json:"goal"`
	PreviousGoal *coachGoal     `json:"previousGoal"`
}

type coachReportHandler struct {
	botName string
	persona string

	userLimiter   *emailRateLimiter
	globalLimiter *emailRateLimiter

	// Seams for tests: production wires these to llm.FromEnv()/llm.New().
	configured  func() bool
	newProvider func() (llm.Provider, error)
}

func newCoachReportHandler(botDir string) *coachReportHandler {
	name, persona := "Gambit Gus", ""
	if bot, err := botbrain.LoadBot(botDir); err == nil {
		if n, _, p := parsePersonaMarkdown(bot.Persona); n != "" {
			name, persona = n, p
		}
	} else {
		log.Printf("[coach] load bot dir %q: %v (using default persona)", botDir, err)
	}
	return &coachReportHandler{
		botName:       name,
		persona:       persona,
		userLimiter:   newEmailRateLimiter(4, time.Hour),
		globalLimiter: newEmailRateLimiter(30, time.Hour),
		configured:    func() bool { return llm.FromEnv().Configured() },
		newProvider:   func() (llm.Provider, error) { return llm.New(llm.FromEnv()) },
	}
}

// clampText bounds free-text fields that reach the prompt: length-capped,
// newlines flattened (a label should never smuggle in extra prompt lines).
func clampText(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		s = s[:max]
	}
	return s
}

func validSAN(s string) bool {
	return coachSANPattern.MatchString(s)
}

// sanitizeCoachRequest drops anything that isn't provably safe to embed in a
// prompt. Invalid SANs remove their whole moment (fail closed).
func sanitizeCoachRequest(req *coachReportRequest) {
	switch req.Window {
	case "24h", "7d", "since-last":
	default:
		req.Window = "24h"
	}
	moments := req.BestMoments[:0]
	for _, m := range req.BestMoments {
		if !validSAN(m.San) {
			continue
		}
		if m.Kind != "punished" {
			m.Kind = "swing"
		}
		moments = append(moments, m)
		if len(moments) == coachMomentCap {
			break
		}
	}
	req.BestMoments = moments

	mistakes := req.Mistakes[:0]
	for _, m := range req.Mistakes {
		if !validSAN(m.San) || (m.BestSan != "" && !validSAN(m.BestSan)) {
			continue
		}
		switch m.Phase {
		case "opening", "middlegame", "endgame":
		default:
			m.Phase = ""
		}
		mistakes = append(mistakes, m)
		if len(mistakes) == coachMomentCap {
			break
		}
	}
	req.Mistakes = mistakes

	switch req.Accuracy.WeakestPhase {
	case "opening", "middlegame", "endgame":
	default:
		req.Accuracy.WeakestPhase = ""
	}
	req.Goal = clampText(req.Goal, coachLabelMax)
	if req.PreviousGoal != nil {
		req.PreviousGoal.Label = clampText(req.PreviousGoal.Label, coachLabelMax)
		req.PreviousGoal.Detail = clampText(req.PreviousGoal.Detail, coachLabelMax)
	}
}

func buildCoachPrompt(botName, persona string, req coachReportRequest) llm.Request {
	system := fmt.Sprintf(`You are %s, the resident chess bot of Ethan's Chess, writing a short coach's note for a player who just reviewed their recent games in their journal.

Your personality:
%s

Rules:
- Write 3 to 5 short sentences of plain text. No lists, no markdown, no headings.
- Celebrate their best moment first, then draw ONE lesson from their biggest mistake, then encourage their goal.
- The audience includes kids: warm, playful, encouraging, never harsh or sarcastic.
- Use ONLY the facts you are given. Never invent moves, games, opponents, or numbers.
- Speak as yourself ("I"), to the player ("you"). You never know or use anyone's name.`,
		botName, strings.TrimSpace(persona))

	var b strings.Builder
	fmt.Fprintf(&b, "Window: %s\n", req.Window)
	fmt.Fprintf(&b, "Record: %d wins, %d losses, %d draws\n", req.Record.Wins, req.Record.Losses, req.Record.Draws)
	if req.Accuracy.MovesGraded > 0 {
		fmt.Fprintf(&b, "Moves analyzed: %d; strong-move rate: %.0f%%; blunders: %d\n",
			req.Accuracy.MovesGraded, req.Accuracy.StrongRate*100, req.Accuracy.BlunderCount)
	}
	if req.Accuracy.WeakestPhase != "" {
		fmt.Fprintf(&b, "Weakest phase: %s\n", req.Accuracy.WeakestPhase)
	}
	for _, m := range req.BestMoments {
		if m.Kind == "punished" {
			fmt.Fprintf(&b, "Best moment: %s — they spotted and punished an opponent mistake (about +%.1f pawns)\n", m.San, m.GainPawns)
		} else {
			fmt.Fprintf(&b, "Best moment: %s — a move that swung the game by about %.1f pawns\n", m.San, m.GainPawns)
		}
	}
	for _, m := range req.Mistakes {
		fmt.Fprintf(&b, "Biggest mistake: %s (gave up about %.1f pawns", m.San, m.LossPawns)
		if m.BestSan != "" {
			fmt.Fprintf(&b, "; engine preferred %s", m.BestSan)
		}
		if m.Phase != "" {
			fmt.Fprintf(&b, "; %s", m.Phase)
		}
		b.WriteString(")\n")
	}
	if req.Goal != "" {
		fmt.Fprintf(&b, "Their new goal: %s\n", req.Goal)
	}
	if pg := req.PreviousGoal; pg != nil && pg.Label != "" {
		verdict := "not enough data yet"
		if pg.Achieved != nil {
			if *pg.Achieved {
				verdict = "achieved"
			} else {
				verdict = "missed"
			}
		}
		fmt.Fprintf(&b, "Their previous goal: %s — %s (%s)\n", pg.Label, verdict, pg.Detail)
	}
	b.WriteString("\nWrite the coach's note now.")

	return llm.Request{
		System:      system,
		User:        b.String(),
		Temperature: 0.7,
		MaxTokens:   400,
	}
}

func (h *coachReportHandler) report(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	sub := subFromContext(r.Context())
	if sub == "" {
		http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
		return
	}
	// Unconfigured LLM is the designed steady state until a key exists — a
	// clean "no note today", not a failure.
	if !h.configured() {
		fmt.Fprint(w, `{"available":false}`)
		return
	}
	if !h.userLimiter.allow(sub) || !h.globalLimiter.allow("coach-report") {
		http.Error(w, `{"error":"coach gus needs a breather — try again later"}`, http.StatusTooManyRequests)
		return
	}

	var req coachReportRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}
	sanitizeCoachRequest(&req)

	provider, err := h.newProvider()
	if err != nil {
		log.Printf("[coach] provider: %v", err)
		fmt.Fprint(w, `{"available":false}`)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	note, err := provider.Complete(ctx, buildCoachPrompt(h.botName, h.persona, req))
	if err != nil {
		// Transient LLM failure degrades identically to unconfigured — the
		// deterministic report carries the pedagogy either way.
		log.Printf("[coach] complete: %v", err)
		fmt.Fprint(w, `{"available":false}`)
		return
	}
	note = strings.TrimSpace(note)
	if len(note) > coachNoteMaxChars {
		note = note[:coachNoteMaxChars]
	}
	if note == "" {
		fmt.Fprint(w, `{"available":false}`)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"available": true,
		"coach":     h.botName,
		"note":      note,
	})
}

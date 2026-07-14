package main

// Player-facing "Play with Gus" endpoints:
//
//	GET  {basePath}/bot/profile   — Gus's public card: persona, style, lifetime
//	                                stats, recent matches (replayable), learned
//	                                brain summary, daily journal, training
//	                                status, and what Gus knows about the caller.
//	GET  {basePath}/bot/profile?section=identity — lightweight identity-only
//	                                probe used by the home-screen panel.
//	POST {basePath}/bot/challenge — summon Gus immediately: bypasses the match
//	                                watcher's 20s humans-first gate for a player
//	                                who explicitly chose to play the bot. The
//	                                caller must already have (or be creating) a
//	                                ticket in the pool; if another human is
//	                                waiting there, AGS matchmaking may still pair
//	                                the two humans first — by design.
//
// Both sit behind the same corsMiddleware + auth.wrap as the other player
// endpoints (real AGS player token), so the profile can safely include the
// caller-specific opponent dossier without leaking other players' dossiers.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/handler"
)

const (
	gusRecentMatchLimit   = 10
	gusJournalLimit       = 14
	gusLessonLimit        = 8
	gusOpeningLimit       = 8
	gusProfileCacheTTL    = 30 * time.Second
	gusChallengeGlobalCap = 10 // per minute, protects the AMS fleet buffer
)

type gusHandlers struct {
	botID     string
	botUserID string
	trainJob  *handler.TrainJob
	watcher   *handler.MatchWatcher // nil when the match watcher is disabled

	// Baked-in-image persona/style, read once at startup (nil bot = not found).
	bot *botbrain.Bot

	// CloudSave reads are cached briefly: the profile is public data that a
	// burst of players opening the screen shouldn't turn into a record stampede.
	mu        sync.Mutex
	fetchedAt time.Time
	games     []botbrain.MatchEntry
	brain     *botbrain.Brain
	journal   []handler.JournalEntry

	userLimiter   *emailRateLimiter // challenge: per-player
	globalLimiter *emailRateLimiter // challenge: fleet-wide
}

func newGusHandlers(botID, botDir, botUserID string, trainJob *handler.TrainJob, watcher *handler.MatchWatcher) *gusHandlers {
	bot, err := botbrain.LoadBot(botDir)
	if err != nil {
		// Profile still works from CloudSave data; persona falls back to defaults.
		log.Printf("[gus] load bot dir %q: %v", botDir, err)
		bot = nil
	}
	return &gusHandlers{
		botID:         botID,
		botUserID:     botUserID,
		trainJob:      trainJob,
		watcher:       watcher,
		bot:           bot,
		userLimiter:   newEmailRateLimiter(3, time.Minute),
		globalLimiter: newEmailRateLimiter(gusChallengeGlobalCap, time.Minute),
	}
}

// ── persona parsing ───────────────────────────────────────────────────────────

// parsePersonaMarkdown pulls the display fields out of persona.md. The file is
// hand-authored, so parse defensively: name/tagline come from the "- **Name:**"
// bullet style, personality is the prose under "## Personality".
func parsePersonaMarkdown(md string) (name, tagline, personality string) {
	var inPersonality bool
	var para []string
	for _, line := range strings.Split(md, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			inPersonality = strings.EqualFold(strings.TrimSpace(strings.TrimLeft(trimmed, "# ")), "personality")
			continue
		}
		if inPersonality && trimmed != "" && !strings.HasPrefix(trimmed, ">") {
			para = append(para, trimmed)
		}
		if v, ok := personaBullet(trimmed, "name"); ok {
			name = v
		}
		if v, ok := personaBullet(trimmed, "tagline"); ok {
			tagline = strings.Trim(v, `"“”`)
		}
	}
	return name, tagline, strings.Join(para, " ")
}

// personaBullet matches `- **Key:** value` (case-insensitive key).
func personaBullet(line, key string) (string, bool) {
	if !strings.HasPrefix(line, "-") {
		return "", false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(line, "-"))
	rest = strings.ReplaceAll(rest, "**", "")
	prefix := key + ":"
	if len(rest) < len(prefix) || !strings.EqualFold(rest[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(rest[len(prefix):]), true
}

// ── stats computation (pure; unit-tested) ─────────────────────────────────────

type gusStats struct {
	Games          int     `json:"games"`
	Wins           int     `json:"wins"`
	Losses         int     `json:"losses"`
	Draws          int     `json:"draws"`
	Abandoned      int     `json:"abandoned"`
	WinRate        float64 `json:"winRate"`
	StreakType     string  `json:"streakType,omitempty"` // win|loss|draw
	StreakCount    int     `json:"streakCount"`
	GamesLast7Days int     `json:"gamesLast7Days"`
	AvgDurationMs  int64   `json:"avgDurationMs"`
	LastPlayedAt   string  `json:"lastPlayedAt,omitempty"`
}

// computeGusStats summarizes the bot's history. Results are stored from the
// bot's perspective ("win" = Gus won). Abandoned games (no decisive end) are
// tallied separately and excluded from the record and win rate.
func computeGusStats(matches []botbrain.MatchEntry, now time.Time) gusStats {
	var s gusStats
	var durTotal int64
	var durCount int64
	var lastPlayed time.Time
	for _, m := range matches {
		switch m.Result {
		case "win":
			s.Wins++
		case "loss":
			s.Losses++
		case "draw":
			s.Draws++
		default:
			s.Abandoned++
			continue
		}
		s.Games++
		if m.DurationMs > 0 {
			durTotal += m.DurationMs
			durCount++
		}
		if t := m.EndedAtTime(); !t.IsZero() {
			if t.After(lastPlayed) {
				lastPlayed = t
			}
			if now.Sub(t) <= 7*24*time.Hour {
				s.GamesLast7Days++
			}
		}
	}
	if s.Games > 0 {
		s.WinRate = float64(s.Wins) / float64(s.Games)
	}
	if durCount > 0 {
		s.AvgDurationMs = durTotal / durCount
	}
	if !lastPlayed.IsZero() {
		s.LastPlayedAt = lastPlayed.UTC().Format(time.RFC3339)
	}
	// Current streak: walk the completed games from newest to oldest. History
	// is stored append-ordered, so iterate from the end.
	for i := len(matches) - 1; i >= 0; i-- {
		r := matches[i].Result
		if r != "win" && r != "loss" && r != "draw" {
			continue
		}
		if s.StreakType == "" {
			s.StreakType = r
			s.StreakCount = 1
			continue
		}
		if r != s.StreakType {
			break
		}
		s.StreakCount++
	}
	return s
}

// gusAboutYou is the caller-specific slice of Gus's memory: his record against
// this player (from the player's perspective) plus the dossier note he keeps.
type gusAboutYou struct {
	GamesVsYou int    `json:"gamesVsYou"`
	YourWins   int    `json:"yourWins"`
	YourLosses int    `json:"yourLosses"`
	YourDraws  int    `json:"yourDraws"`
	Notes      string `json:"notes,omitempty"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
}

func computeGusAboutYou(matches []botbrain.MatchEntry, brain *botbrain.Brain, userID string) *gusAboutYou {
	if userID == "" {
		return nil
	}
	var a gusAboutYou
	for _, m := range matches {
		if m.OpponentUserID != userID {
			continue
		}
		switch m.Result { // bot's perspective → flip for the player
		case "win":
			a.YourLosses++
		case "loss":
			a.YourWins++
		case "draw":
			a.YourDraws++
		default:
			continue
		}
		a.GamesVsYou++
	}
	if brain != nil {
		if d := brain.OpponentDossiers[userID]; d != nil {
			a.Notes = d.Notes
			a.UpdatedAt = d.UpdatedAt
			if a.GamesVsYou == 0 {
				a.GamesVsYou = d.GamesPlayed
			}
		}
	}
	if a.GamesVsYou == 0 && a.Notes == "" {
		return nil
	}
	return &a
}

// gusBrainSummary is the public view of what Gus has learned. Lessons and
// openings are capped; processed-match bookkeeping stays private.
type gusBrainSummary struct {
	Version          int              `json:"version"`
	LastTrained      string           `json:"lastTrained,omitempty"`
	LastChecked      string           `json:"lastChecked,omitempty"`
	GamesLearnedFrom int              `json:"gamesLearnedFrom"`
	Difficulty       string           `json:"difficulty,omitempty"`
	ThinkMsMean      int              `json:"thinkMsMean,omitempty"`
	ThinkMsJitter    int              `json:"thinkMsJitter,omitempty"`
	SearchBudgetMs   int              `json:"searchBudgetMs,omitempty"`
	TrailingWinRate  float64          `json:"trailingWinRate,omitempty"`
	BookLines        int              `json:"bookLines"`
	BookRevision     int              `json:"bookRevision"`
	BookScore        float64          `json:"bookScore,omitempty"`
	OpponentsKnown   int              `json:"opponentsKnown"`
	Lessons          []gusLessonView  `json:"lessons"`
	Openings         []gusOpeningView `json:"openings"`
}

type gusLessonView struct {
	Text      string `json:"text"`
	LearnedAt string `json:"learnedAt,omitempty"`
}

type gusOpeningView struct {
	Line   string `json:"line"`
	Played int    `json:"played"`
	Wins   int    `json:"wins"`
	Draws  int    `json:"draws"`
	Losses int    `json:"losses"`
	Note   string `json:"note,omitempty"`
}

func summarizeGusBrain(brain *botbrain.Brain) *gusBrainSummary {
	if brain == nil {
		return nil
	}
	s := &gusBrainSummary{
		Version:          brain.Version,
		GamesLearnedFrom: brain.GamesLearnedFrom,
		OpponentsKnown:   len(brain.OpponentDossiers),
		Lessons:          []gusLessonView{},
		Openings:         []gusOpeningView{},
	}
	if brain.LastTrained != nil {
		s.LastTrained = *brain.LastTrained
	}
	if brain.LastChecked != nil {
		s.LastChecked = *brain.LastChecked
	}
	if t := brain.PlayTuning; t != nil {
		s.Difficulty = t.Difficulty
		s.ThinkMsMean = t.ThinkMsMean
		s.ThinkMsJitter = t.ThinkMsJitter
		s.SearchBudgetMs = t.SearchBudgetMs
		s.TrailingWinRate = t.WinRate
		s.BookLines = len(t.Book)
		s.BookRevision = t.Revision
		s.BookScore = t.BookScore
	}
	lessons := append([]botbrain.Lesson(nil), brain.Lessons...)
	sort.SliceStable(lessons, func(i, j int) bool { return lessons[i].Weight > lessons[j].Weight })
	for _, l := range lessons {
		if len(s.Lessons) >= gusLessonLimit {
			break
		}
		if strings.TrimSpace(l.Text) == "" {
			continue
		}
		s.Lessons = append(s.Lessons, gusLessonView{Text: l.Text, LearnedAt: l.LearnedAt})
	}
	openings := make([]gusOpeningView, 0, len(brain.OpeningBook))
	for line, st := range brain.OpeningBook {
		if st == nil {
			continue
		}
		name := st.Line
		if name == "" {
			name = line
		}
		openings = append(openings, gusOpeningView{
			Line: name, Played: st.Played, Wins: st.Wins, Draws: st.Draws, Losses: st.Losses, Note: st.Note,
		})
	}
	sort.SliceStable(openings, func(i, j int) bool {
		if openings[i].Played != openings[j].Played {
			return openings[i].Played > openings[j].Played
		}
		return openings[i].Line < openings[j].Line
	})
	if len(openings) > gusOpeningLimit {
		openings = openings[:gusOpeningLimit]
	}
	s.Openings = openings
	return s
}

// recentGusMatches returns the newest completed-or-abandoned games first, with
// full move lists so the client can offer replays.
func recentGusMatches(matches []botbrain.MatchEntry, limit int) []botbrain.MatchEntry {
	out := make([]botbrain.MatchEntry, 0, limit)
	for i := len(matches) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, matches[i])
	}
	return out
}

// journalNewestFirst returns up to limit entries, newest first.
func journalNewestFirst(entries []handler.JournalEntry, limit int) []handler.JournalEntry {
	out := make([]handler.JournalEntry, 0, limit)
	for i := len(entries) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, entries[i])
	}
	return out
}

// ── data refresh ──────────────────────────────────────────────────────────────

// snapshot returns the (briefly cached) CloudSave state: games, brain, journal.
// The brain falls back to the baked-in seed when the bot has never trained.
func (g *gusHandlers) snapshot() (games []botbrain.MatchEntry, brain *botbrain.Brain, journal []handler.JournalEntry, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if time.Since(g.fetchedAt) < gusProfileCacheTTL {
		return g.games, g.brain, g.journal, nil
	}
	games, err = handler.FetchAllBotGames(handler.BotHistoryKey(g.botID))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("fetch games: %w", err)
	}
	brain, found, err := handler.FetchBotBrain(g.botID)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("fetch brain: %w", err)
	}
	if !found && g.bot != nil {
		brain = g.bot.Brain
	}
	if brain != nil && len(brain.TrainingJournal) > 0 {
		journal = brain.TrainingJournal
	} else {
		journal, err = handler.FetchBotJournal(g.botID)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("fetch journal: %w", err)
		}
	}
	g.games, g.brain, g.journal, g.fetchedAt = games, brain, journal, time.Now()
	return games, brain, journal, nil
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

func (g *gusHandlers) identity() map[string]any {
	name, tagline, personality := "Gambit Gus", "", ""
	var style json.RawMessage
	if g.bot != nil {
		if n, t, p := parsePersonaMarkdown(g.bot.Persona); n != "" {
			name, tagline, personality = n, t, p
		}
		style = g.bot.Style
	}
	id := map[string]any{
		"id":          g.botID,
		"userId":      g.botUserID,
		"name":        name,
		"tagline":     tagline,
		"personality": personality,
	}
	if len(style) > 0 {
		id["style"] = style
	}
	return id
}

func (g *gusHandlers) profile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Query().Get("section") == "identity" {
		_ = json.NewEncoder(w).Encode(map[string]any{"bot": g.identity(), "playable": g.watcher != nil})
		return
	}
	games, brain, journal, err := g.snapshot()
	if err != nil {
		log.Printf("[gus] profile snapshot: %v", err)
		http.Error(w, `{"error":"gus is unavailable right now"}`, http.StatusBadGateway)
		return
	}
	running, lastRun := false, map[string]any{}
	if g.trainJob != nil {
		running, lastRun = g.trainJob.Status()
	}
	lastChecked := ""
	trainingHealthy := false
	if brain != nil && brain.LastChecked != nil {
		lastChecked = *brain.LastChecked
		if checked, parseErr := time.Parse(time.RFC3339, lastChecked); parseErr == nil {
			trainingHealthy = time.Since(checked) <= 36*time.Hour
		}
	}
	out := map[string]any{
		"bot":           g.identity(),
		"playable":      g.watcher != nil,
		"stats":         computeGusStats(games, time.Now()),
		"recentMatches": recentGusMatches(games, gusRecentMatchLimit),
		"brain":         summarizeGusBrain(brain),
		"aboutYou":      computeGusAboutYou(games, brain, subFromContext(r.Context())),
		"journal":       journalNewestFirst(journal, gusJournalLimit),
		"training": map[string]any{
			"running":     running,
			"lastRun":     lastRun,
			"cadence":     "scheduled_daily",
			"lastChecked": lastChecked,
			"healthy":     trainingHealthy,
		},
	}
	_ = json.NewEncoder(w).Encode(out)
}

func (g *gusHandlers) challenge(w http.ResponseWriter, r *http.Request) {
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
	if g.watcher == nil {
		http.Error(w, `{"error":"gus is offline"}`, http.StatusServiceUnavailable)
		return
	}
	if !g.userLimiter.allow(sub) || !g.globalLimiter.allow("gus-challenge") {
		http.Error(w, `{"error":"gus needs a breather — try again in a minute"}`, http.StatusTooManyRequests)
		return
	}
	g.watcher.TriggerNow()
	log.Printf("[gus] challenge accepted from %s — bot trigger dispatched", sub)
	fmt.Fprint(w, `{"ok":true,"summoned":true}`)
}

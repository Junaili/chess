// Package trainer turns a batch of the bot's own recent games into updates to
// its brain. Facts (opening win/loss tallies, opponent game counts) are computed
// deterministically from the reconstructed games; insight (lessons, opponent
// reads, the journal note) comes from the configured LLM provider. The bot
// learns only from the games passed in.
package trainer

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/chessreplay"
	"github.com/junaili/ethan-chess-service/pkg/llm"
)

const maxLessons = 200
const promptPGNMaxBytes = 12 << 10

// GamePair couples a stored match with its reconstruction.
type GamePair struct {
	Entry botbrain.MatchEntry
	Game  *chessreplay.Game
}

// ReconstructAll replays every entry; games that fail replay keep what was
// recovered and are flagged Truncated.
func ReconstructAll(entries []botbrain.MatchEntry, botName string) []GamePair {
	pairs := make([]GamePair, 0, len(entries))
	for _, e := range entries {
		g, _ := chessreplay.Reconstruct(e, botName)
		pairs = append(pairs, GamePair{Entry: e, Game: g})
	}
	return pairs
}

// Reflection is the LLM's structured output (insight only).
type Reflection struct {
	JournalSummary string `json:"journal_summary"`
	Lessons        []struct {
		MatchID string   `json:"match_id"`
		Text    string   `json:"text"`
		Tags    []string `json:"tags"`
	} `json:"lessons"`
	OpponentNotes []struct {
		OpponentName   string `json:"opponent_name"`
		OpponentUserID string `json:"opponent_user_id"`
		Note           string `json:"note"`
	} `json:"opponent_notes"`
}

// Outcome summarizes what a training run changed.
type Outcome struct {
	GamesLearned     int
	LessonsAdded     int
	OpeningsTouched  int
	OpponentsTouched int
	Summary          string
	JournalText      string
	AcceptedLessons  []string
	VerifiedLessons  []string
	ModelSuggestions []string
}

type ApplyContext struct {
	Analyses map[string]GameAnalysis
	Tuning   TuningOutcome
}

// BuildPrompt assembles the system + user prompts from the persona, style, the
// current brain, and the games to reflect on.
func BuildPrompt(bot *botbrain.Bot, pairs []GamePair, supplied ...map[string]GameAnalysis) (system, user string) {
	system = fmt.Sprintf(`You are %s, a chess bot that learns ONLY from your own games.
You keep a private training journal. Below is your personality and your style settings.

--- PERSONA ---
%s

--- STYLE (style.json) ---
%s

Be concise, concrete, and honest about your mistakes. Keep your attacking soul,
but learn what actually works. The deterministic evidence below is authoritative.
Never infer a different result, move, opponent id, or evaluation.`,
		bot.ID, strings.TrimSpace(bot.Persona), strings.TrimSpace(string(bot.Style)))

	var b strings.Builder
	b.WriteString("WHAT YOU'VE LEARNED SO FAR (do not repeat these lessons):\n")
	if len(bot.Brain.Lessons) == 0 {
		b.WriteString("  (nothing yet — you are a blank slate)\n")
	} else {
		for _, l := range bot.Brain.Lessons {
			fmt.Fprintf(&b, "  - %q\n", l.Text)
		}
	}

	analyses := map[string]GameAnalysis(nil)
	if len(supplied) > 0 {
		analyses = supplied[0]
	}
	if analyses == nil {
		analyses = AnalyzeAll(pairs)
	}
	b.WriteString("\nVERIFIED COMPLETED GAMES IN THIS TRAINING BATCH:\n")
	for i, p := range pairs {
		g := p.Game
		fmt.Fprintf(&b, "\nGame %d\n  match_id: %q\n  opponent_name: %q\n  opponent_user_id: %q\n  bot_color: %q\n  recorded_completed_result: %q\n  replay_terminal_method: %q\n",
			i+1, p.Entry.ID, opponentName(p.Entry), dash(p.Entry.OpponentUserID),
			dash(g.BotColor), botResult(g), g.EngineMethod)
		if analysis := analyses[p.Entry.ID]; analysis.Moment != nil {
			moment := analysis.Moment
			fmt.Fprintf(&b, "  critical_evidence: move %d, played %s, stronger bounded-search move %s, regret_cp %d, fen %s\n",
				moment.MoveNumber, moment.PlayedSAN, moment.BetterSAN, moment.RegretCP, moment.FEN)
		} else {
			b.WriteString("  critical_evidence: no tactical regression crossed the bounded-review threshold\n")
		}
		fmt.Fprintf(&b, "  replayed_pgn: %q\n", promptPGN(g.PGN))
	}

	b.WriteString(`
Return one short voice line, zero to three non-duplicate lessons tied to an
exact match_id above, and notes only for the exact opponent_user_id supplied.
Do not put win/loss/draw claims in journal_summary. Never put a match id,
opponent id, or opponent name in journal_summary or a lesson. Respond as this JSON shape:
{
  "journal_summary": "one sentence of personality, without result claims",
  "lessons": [ { "match_id": "exact supplied id", "text": "specific actionable lesson supported by evidence", "tags": ["opening|tactics|endgame|opponent|psychology"] } ],
  "opponent_notes": [ { "opponent_name": "exact supplied name", "opponent_user_id": "exact supplied id", "note": "specific evidence-grounded tendency" } ]
}`)
	user = b.String()
	return system, user
}

func promptPGN(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= promptPGNMaxBytes {
		return value
	}
	half := promptPGNMaxBytes / 2
	return value[:half] + "\n[... middle plies omitted from model prompt; deterministic replay used the complete game ...]\n" + value[len(value)-half:]
}

// Reflect calls the provider and parses its structured reflection.
func Reflect(ctx context.Context, p llm.Provider, bot *botbrain.Bot, pairs []GamePair, analyses ...map[string]GameAnalysis) (*Reflection, error) {
	system, user := BuildPrompt(bot, pairs, analyses...)
	raw, err := p.Complete(ctx, llm.Request{
		System: system, User: user,
		SchemaName: "gus_daily_reflection", JSONSchema: reflectionSchema(),
	})
	if err != nil {
		return nil, fmt.Errorf("llm complete: %w", err)
	}
	return ParseReflection(raw)
}

func reflectionSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"journal_summary": map[string]any{"type": "string"},
			"lessons": map[string]any{
				"type": "array", "maxItems": 3,
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"match_id": map[string]any{"type": "string"},
						"text":     map[string]any{"type": "string"},
						"tags": map[string]any{
							"type": "array", "maxItems": 4,
							"items": map[string]any{"type": "string", "enum": []string{"opening", "tactics", "endgame", "opponent", "psychology"}},
						},
					},
					"required": []string{"match_id", "text", "tags"}, "additionalProperties": false,
				},
			},
			"opponent_notes": map[string]any{
				"type": "array", "maxItems": 3,
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"opponent_name":    map[string]any{"type": "string"},
						"opponent_user_id": map[string]any{"type": "string"},
						"note":             map[string]any{"type": "string"},
					},
					"required": []string{"opponent_name", "opponent_user_id", "note"}, "additionalProperties": false,
				},
			},
		},
		"required":             []string{"journal_summary", "lessons", "opponent_notes"},
		"additionalProperties": false,
	}
}

// ParseReflection tolerantly extracts the JSON object from a model response.
func ParseReflection(raw string) (*Reflection, error) {
	s := strings.TrimSpace(raw)
	if i := strings.IndexByte(s, '{'); i >= 0 {
		if j := strings.LastIndexByte(s, '}'); j > i {
			s = s[i : j+1]
		}
	}
	var r Reflection
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		return nil, fmt.Errorf("parse reflection JSON: %w", err)
	}
	return &r, nil
}

// Apply merges deterministic tallies + the LLM's insight into the brain and
// returns a summary. It bumps the version, records processed match ids, and
// builds the journal text. It does NOT write files (the caller saves).
func Apply(bot *botbrain.Bot, pairs []GamePair, r *Reflection, now time.Time, optional ...ApplyContext) Outcome {
	br := bot.Brain
	seenInput := map[string]bool{}
	freshPairs := make([]GamePair, 0, len(pairs))
	for _, pair := range pairs {
		id := strings.TrimSpace(pair.Entry.ID)
		if id == "" || seenInput[id] || br.AlreadyProcessed(id) {
			continue
		}
		seenInput[id] = true
		freshPairs = append(freshPairs, pair)
	}
	pairs = freshPairs
	if len(pairs) == 0 {
		return Outcome{}
	}
	out := Outcome{GamesLearned: len(pairs)}
	nowISO := now.UTC().Format(time.RFC3339)
	touchedOpenings := map[string]bool{}
	touchedOpponents := map[string]bool{}
	ctx := ApplyContext{Analyses: AnalyzeAll(pairs)}
	if len(optional) > 0 {
		ctx = optional[0]
		if ctx.Analyses == nil {
			ctx.Analyses = AnalyzeAll(pairs)
		}
	}
	entries := make([]botbrain.MatchEntry, 0, len(pairs))
	knownPairs := make(map[string]GamePair, len(pairs))
	knownOpponents := map[string]botbrain.MatchEntry{}
	pairsByOpponent := map[string][]GamePair{}
	for _, pair := range pairs {
		entries = append(entries, pair.Entry)
		knownPairs[pair.Entry.ID] = pair
		if pair.Entry.OpponentUserID != "" {
			knownOpponents[pair.Entry.OpponentUserID] = pair.Entry
			pairsByOpponent[pair.Entry.OpponentUserID] = append(pairsByOpponent[pair.Entry.OpponentUserID], pair)
		}
	}
	NormalizeBrain(br, entries)

	// Deterministic facts: opening + opponent tallies from the games themselves.
	for _, p := range pairs {
		g := p.Game
		if key := openingKey(g); key != "" {
			os := br.OpeningBook[key]
			if os == nil {
				os = &botbrain.OpeningStat{Line: key}
				br.OpeningBook[key] = os
			}
			os.Played++
			switch botResult(g) {
			case "win":
				os.Wins++
			case "loss":
				os.Losses++
			case "draw":
				os.Draws++
			}
			touchedOpenings[key] = true
		}
		if dk := opponentKey(p.Entry); dk != "" {
			d := br.OpponentDossiers[dk]
			if d == nil {
				d = &botbrain.OpponentDossier{
					OpponentUserID: p.Entry.OpponentUserID,
					OpponentName:   p.Entry.OpponentName,
				}
				br.OpponentDossiers[dk] = d
			}
			d.GamesPlayed++
			if line := openingKey(g); line != "" {
				d.Notes = "Latest verified game began " + line + "."
			}
			d.UpdatedAt = nowISO
			touchedOpponents[dk] = true
		}
		br.MarkProcessed(p.Entry.ID)
	}

	addLesson := func(text string, tags []string, matchID, source string) {
		text = strings.TrimSpace(text)
		if text == "" || len(text) > 320 {
			return
		}
		recordJournalLesson := func(target *[]string) {
			if len(*target) >= 5 {
				return
			}
			for _, existing := range *target {
				if existing == text {
					return
				}
			}
			*target = append(*target, text)
		}
		if source == "verified" {
			recordJournalLesson(&out.VerifiedLessons)
		} else if source == "model" {
			recordJournalLesson(&out.ModelSuggestions)
		}
		if existing := similarLessonIndex(br.Lessons, text); existing >= 0 {
			br.Lessons[existing].Weight += 0.25
			br.Lessons[existing].LearnedAt = nowISO
			return
		}
		br.Lessons = append(br.Lessons, botbrain.Lesson{
			ID: lessonID(text), Text: text, Tags: normalizeLessonTags(tags), Weight: 1.0,
			FromGame: matchID, LearnedAt: nowISO,
		})
		out.LessonsAdded++
		out.AcceptedLessons = append(out.AcceptedLessons, text)
	}

	// A tactical regression creates a factual lesson even if the LLM is down.
	// This makes daily learning useful without making model prose the source of
	// truth for move quality.
	for _, pair := range pairs {
		if moment := ctx.Analyses[pair.Entry.ID].Moment; moment != nil {
			addLesson(verifiedMomentLesson(moment), []string{"tactics", "verified"}, pair.Entry.ID, "verified")
		}
	}

	// Insight from the LLM: lessons + opponent notes.
	if r != nil {
		for _, l := range r.Lessons {
			matchID := strings.TrimSpace(l.MatchID)
			if matchID == "" && len(pairs) == 1 {
				matchID = pairs[0].Entry.ID
			}
			pair, ok := knownPairs[matchID]
			if !ok {
				continue
			}
			text := strings.TrimSpace(l.Text)
			if !reflectionTextGrounded(text, pair) || reflectionContainsAnyIdentity(text, pairs) {
				continue
			}
			addLesson(text, l.Tags, matchID, "model")
		}
		for _, n := range r.OpponentNotes {
			dk := strings.TrimSpace(n.OpponentUserID)
			match, ok := knownOpponents[dk]
			if !ok { // never let a model invent or name-key an identity
				continue
			}
			d := br.OpponentDossiers[dk]
			if d == nil {
				d = &botbrain.OpponentDossier{OpponentUserID: dk, OpponentName: match.OpponentName}
				br.OpponentDossiers[dk] = d
			}
			if note := strings.TrimSpace(n.Note); note != "" && len(note) <= 240 && groundedForAny(note, pairsByOpponent[dk]) {
				combined := strings.TrimSpace(d.Notes + " Model reflection: " + note)
				if len(combined) <= 400 {
					d.Notes = combined
				}
				d.OpponentUserID = dk
				if match.OpponentName != "" {
					d.OpponentName = match.OpponentName
				}
				d.UpdatedAt = nowISO
				touchedOpponents[dk] = true
			}
		}
	}

	consolidateLessons(br)

	br.Version++
	br.GamesLearnedFrom += len(pairs)
	br.LastTrained = &nowISO
	out.OpeningsTouched = len(touchedOpenings)
	out.OpponentsTouched = len(touchedOpponents)
	if r != nil {
		out.Summary = safeVoiceLine(r.JournalSummary)
		for _, pair := range pairs {
			if reflectionContainsIdentity(out.Summary, pair) {
				out.Summary = ""
				break
			}
		}
	}
	out.JournalText = buildJournal(bot, pairs, out, ctx, now)
	return out
}

func normalizeLessonTags(tags []string) []string {
	allowed := map[string]bool{"opening": true, "tactics": true, "endgame": true, "opponent": true, "psychology": true, "verified": true}
	out := make([]string, 0, 4)
	for _, tag := range tags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if !allowed[tag] {
			continue
		}
		seen := false
		for _, existing := range out {
			if existing == tag {
				seen = true
				break
			}
		}
		if !seen {
			out = append(out, tag)
		}
		if len(out) == 4 {
			break
		}
	}
	return out
}

// consolidateLessons caps the lesson list, dropping the lowest-weight (then
// oldest) lessons so the brain stays sharp as days accumulate.
func consolidateLessons(br *botbrain.Brain) {
	if len(br.Lessons) <= maxLessons {
		return
	}
	sort.SliceStable(br.Lessons, func(i, j int) bool {
		if br.Lessons[i].Weight != br.Lessons[j].Weight {
			return br.Lessons[i].Weight > br.Lessons[j].Weight
		}
		return br.Lessons[i].LearnedAt > br.Lessons[j].LearnedAt
	})
	br.Lessons = br.Lessons[:maxLessons]
}

func buildJournal(bot *botbrain.Bot, pairs []GamePair, out Outcome, ctx ApplyContext, now time.Time) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n## %s — brain v%d\n\n", now.UTC().Format("2006-01-02 15:04 MST"), bot.Brain.Version)
	wins, losses, draws := 0, 0, 0
	var critical *CriticalMoment
	for _, pair := range pairs {
		switch botResult(pair.Game) {
		case "win":
			wins++
		case "loss":
			losses++
		case "draw":
			draws++
		}
		if moment := ctx.Analyses[pair.Entry.ID].Moment; moment != nil && (critical == nil || moment.RegretCP > critical.RegretCP) {
			critical = moment
		}
	}
	fmt.Fprintf(&b, "Training set: %d completed game(s) — %d win(s), %d loss(es), %d draw(s).\n\n",
		out.GamesLearned, wins, losses, draws)
	if out.Summary != "" {
		b.WriteString("Model-assisted reflection (not a position evaluation):\n")
		fmt.Fprintf(&b, "> %s\n\n", out.Summary)
	}
	b.WriteString("Verified position:\n")
	fmt.Fprintf(&b, "- %s\n", momentSentence(critical))
	if critical != nil {
		fmt.Fprintf(&b, "- Position (FEN): %s\n", critical.FEN)
	}
	b.WriteString("\n")
	if len(out.VerifiedLessons) > 0 {
		b.WriteString("Analyzer-verified lessons:\n")
		for _, lesson := range out.VerifiedLessons {
			fmt.Fprintf(&b, "- %s\n", lesson)
		}
		b.WriteString("\n")
	}
	if len(out.ModelSuggestions) > 0 {
		b.WriteString("Model-assisted suggestions (check against the position):\n")
		for _, lesson := range out.ModelSuggestions {
			fmt.Fprintf(&b, "- %s\n", lesson)
		}
		b.WriteString("\n")
	}
	b.WriteString("Opening candidate:\n")
	if ctx.Tuning.Promoted {
		fmt.Fprintf(&b, "- Promoted %d replay-checked line(s) from %d completed game(s); evidence score %.3f.\n",
			ctx.Tuning.CandidateLines, ctx.Tuning.SampleSize, ctx.Tuning.CandidateScore)
	} else {
		fmt.Fprintf(&b, "- Not promoted: %s (candidate evidence %.3f; champion evidence %.3f).\n",
			ctx.Tuning.Reason, ctx.Tuning.CandidateScore, ctx.Tuning.ChampionScore)
	}
	return b.String()
}

func similarLessonIndex(lessons []botbrain.Lesson, text string) int {
	for i := range lessons {
		if lessonSimilarity(lessons[i].Text, text) >= 0.72 {
			return i
		}
	}
	return -1
}

func safeVoiceLine(value string) string {
	value = strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if value == "" || len(value) > 240 {
		return ""
	}
	lower := strings.ToLower(value)
	for _, forbidden := range []string{
		" i won", " i lost", "my win", "my loss", "drawn game", "i drew",
		" crushed", " victory", " defeated", " checkmated", " walked into mate",
	} {
		if strings.Contains(" "+lower, forbidden) {
			return ""
		}
	}
	return value
}

func verifiedMomentLesson(moment *CriticalMoment) string {
	return fmt.Sprintf("On move %d as %s, compare %s with %s before committing; the bounded two-ply tactical check valued the played move %.1f pawns lower.",
		moment.MoveNumber, moment.Color, moment.PlayedSAN, moment.BetterSAN, float64(moment.RegretCP)/100)
}

// reflectionTextGrounded requires model advice to cite at least one move or
// destination square that actually occurred in the linked game. The model may
// interpret the evidence, but it cannot add free-floating advice to the public
// brain or journal.
func reflectionTextGrounded(text string, pair GamePair) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" || pair.Game == nil || reflectionContainsIdentity(text, pair) {
		return false
	}
	replacer := strings.NewReplacer("x", "", "+", "", "#", "", "!", "", "?", "", "=", "")
	for _, san := range pair.Game.SANs {
		token := strings.ToLower(san)
		token = replacer.Replace(token)
		if len(token) >= 2 && strings.Contains(lower, token) {
			return true
		}
		for i := 0; i+1 < len(token); i++ {
			if token[i] >= 'a' && token[i] <= 'h' && token[i+1] >= '1' && token[i+1] <= '8' && strings.Contains(lower, token[i:i+2]) {
				return true
			}
		}
	}
	return false
}

func reflectionContainsIdentity(text string, pair GamePair) bool {
	for _, identity := range []string{pair.Entry.ID, pair.Entry.OpponentUserID, pair.Entry.OpponentName} {
		if containsFoldIdentity(text, identity) {
			return true
		}
	}
	return false
}

func reflectionContainsAnyIdentity(text string, pairs []GamePair) bool {
	for _, pair := range pairs {
		if reflectionContainsIdentity(text, pair) {
			return true
		}
	}
	return false
}

func containsFoldIdentity(text, identity string) bool {
	text = strings.ToLower(text)
	identity = strings.ToLower(strings.TrimSpace(identity))
	if text == "" || identity == "" {
		return false
	}
	for offset := 0; offset <= len(text)-len(identity); {
		index := strings.Index(text[offset:], identity)
		if index < 0 {
			return false
		}
		index += offset
		end := index + len(identity)
		beforeOK := index == 0 || !identityByte(text[index-1])
		afterOK := end == len(text) || !identityByte(text[end])
		if beforeOK && afterOK {
			return true
		}
		offset = index + 1
	}
	return false
}

func identityByte(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= '0' && value <= '9' || value == '_' || value >= 0x80
}

func groundedForAny(text string, pairs []GamePair) bool {
	for _, pair := range pairs {
		if reflectionTextGrounded(text, pair) {
			return true
		}
	}
	return false
}

// ── helpers ──────────────────────────────────────────────────────────────────

func botResult(g *chessreplay.Game) string {
	switch g.EngineOutcome {
	case "1-0":
		if g.BotColor == "white" {
			return "win"
		}
		if g.BotColor == "black" {
			return "loss"
		}
	case "0-1":
		if g.BotColor == "black" {
			return "win"
		}
		if g.BotColor == "white" {
			return "loss"
		}
	case "1/2-1/2":
		return "draw"
	}
	switch strings.ToLower(strings.TrimSpace(g.StoredResult)) {
	case "win", "won":
		return "win"
	case "loss", "lost", "lose":
		return "loss"
	case "draw", "drawn", "stalemate":
		return "draw"
	}
	return "unknown"
}

// openingKey is the first few plies in movetext form, used to group openings.
func openingKey(g *chessreplay.Game) string {
	const maxPlies = 6
	n := len(g.SANs)
	if n == 0 {
		return ""
	}
	if n > maxPlies {
		n = maxPlies
	}
	var b strings.Builder
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			fmt.Fprintf(&b, "%d.%s ", i/2+1, g.SANs[i])
		} else {
			b.WriteString(g.SANs[i] + " ")
		}
	}
	return strings.TrimSpace(b.String())
}

func opponentKey(e botbrain.MatchEntry) string {
	if e.OpponentUserID != "" {
		return e.OpponentUserID
	}
	return e.OpponentName
}

func opponentName(e botbrain.MatchEntry) string {
	switch {
	case e.OpponentName != "":
		return e.OpponentName
	case e.OpponentUserID != "":
		return e.OpponentUserID
	default:
		return "(unknown)"
	}
}

func lessonTextSet(ls []botbrain.Lesson) map[string]bool {
	s := make(map[string]bool, len(ls))
	for _, l := range ls {
		s[strings.ToLower(strings.TrimSpace(l.Text))] = true
	}
	return s
}

func lessonID(text string) string {
	h := sha1.Sum([]byte(text))
	return "L" + fmt.Sprintf("%x", h[:4])
}

func dash(s string) string {
	if s == "" {
		return "?"
	}
	return s
}

// Package botbrain holds the data model and file I/O for a self-learning chess
// personality bot: the user-authored persona/style config, the machine-grown
// "brain" (learned memory), and the match-history records the trainer learns
// from. It has no AGS or network dependencies — those live in package handler.
package botbrain

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Move is a single coordinate move exactly as stored in the app's
// chess-match-history CloudSave record (see src/stats.js recordMatchHistory).
type Move struct {
	Fr       int    `json:"fr"`
	Fc       int    `json:"fc"`
	ToR      int    `json:"toR"`
	ToC      int    `json:"toC"`
	PromType string `json:"promType"`
}

// MatchEntry is one completed game in a player's chess-match-history record.
// startedAt/endedAt are ISO-8601 strings written by the web client.
type MatchEntry struct {
	ID             string `json:"id"`
	Mode           string `json:"mode"`
	OpponentUserID string `json:"opponentUserId"`
	OpponentName   string `json:"opponentName"`
	Result         string `json:"result"`
	StartedAt      string `json:"startedAt"`
	EndedAt        string `json:"endedAt"`
	DurationMs     int64  `json:"durationMs"`
	WhiteName      string `json:"whiteName"`
	BlackName      string `json:"blackName"`
	Moves          []Move `json:"moves"`
}

// EndedAtTime parses the ISO-8601 endedAt; zero time if absent/unparseable.
func (m MatchEntry) EndedAtTime() time.Time {
	if m.EndedAt == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, m.EndedAt)
	if err != nil {
		// Tolerate millisecond precision without timezone edge cases.
		if t2, err2 := time.Parse("2006-01-02T15:04:05.999Z07:00", m.EndedAt); err2 == nil {
			return t2
		}
		return time.Time{}
	}
	return t
}

// ── Learned memory (the brain) ───────────────────────────────────────────────

// OpeningStat tracks how a discovered opening line has performed for the bot.
type OpeningStat struct {
	Line   string `json:"line"` // e.g. "1.e4 e5 2.f4" (king's gambit)
	Played int    `json:"played"`
	Wins   int    `json:"wins"`
	Draws  int    `json:"draws"`
	Losses int    `json:"losses"`
	Note   string `json:"note,omitempty"`
}

// Lesson is a short, retrievable thing the bot learned from its own games.
type Lesson struct {
	ID        string   `json:"id"`
	Text      string   `json:"text"`
	Tags      []string `json:"tags,omitempty"`
	Weight    float64  `json:"weight"` // recency × outcome importance
	FromGame  string   `json:"fromGame,omitempty"`
	LearnedAt string   `json:"learnedAt"`
}

// OpponentDossier is what the bot remembers about a recurring opponent.
type OpponentDossier struct {
	OpponentUserID string `json:"opponentUserId"`
	OpponentName   string `json:"opponentName"`
	GamesPlayed    int    `json:"gamesPlayed"`
	Notes          string `json:"notes"`
	UpdatedAt      string `json:"updatedAt"`
}

// Brain is the machine-grown memory. The trainer owns this file.
type Brain struct {
	Comment           string                      `json:"_comment,omitempty"`
	SchemaVersion     int                         `json:"schema_version"`
	BotID             string                      `json:"bot_id"`
	Version           int                         `json:"version"`
	LastTrained       *string                     `json:"last_trained"`
	GamesLearnedFrom  int                         `json:"games_learned_from"`
	ProcessedMatchIDs []string                    `json:"processed_match_ids"`
	OpeningBook       map[string]*OpeningStat     `json:"opening_book"`
	Lessons           []Lesson                    `json:"lessons"`
	OpponentDossiers  map[string]*OpponentDossier `json:"opponent_dossiers"`
}

// processedSet returns the processed match IDs as a lookup set.
func (b *Brain) processedSet() map[string]struct{} {
	s := make(map[string]struct{}, len(b.ProcessedMatchIDs))
	for _, id := range b.ProcessedMatchIDs {
		s[id] = struct{}{}
	}
	return s
}

// AlreadyProcessed reports whether a match id has been learned from already.
func (b *Brain) AlreadyProcessed(id string) bool {
	_, ok := b.processedSet()[id]
	return ok
}

// ── Bot config + file layout ─────────────────────────────────────────────────

// Bot bundles the on-disk artifacts for one bot under bots/<id>/.
type Bot struct {
	Dir     string
	ID      string
	Persona string          // raw persona.md
	Style   json.RawMessage // raw style.json
	Brain   *Brain
}

// LoadBot reads persona.md, style.json, and brain.json from dir.
func LoadBot(dir string) (*Bot, error) {
	persona, err := os.ReadFile(filepath.Join(dir, "persona.md"))
	if err != nil {
		return nil, fmt.Errorf("read persona.md: %w", err)
	}
	style, err := os.ReadFile(filepath.Join(dir, "style.json"))
	if err != nil {
		return nil, fmt.Errorf("read style.json: %w", err)
	}
	if !json.Valid(style) {
		return nil, fmt.Errorf("style.json is not valid JSON")
	}
	brainBytes, err := os.ReadFile(filepath.Join(dir, "brain.json"))
	if err != nil {
		return nil, fmt.Errorf("read brain.json: %w", err)
	}
	var brain Brain
	if err := json.Unmarshal(brainBytes, &brain); err != nil {
		return nil, fmt.Errorf("parse brain.json: %w", err)
	}
	if brain.OpeningBook == nil {
		brain.OpeningBook = map[string]*OpeningStat{}
	}
	if brain.OpponentDossiers == nil {
		brain.OpponentDossiers = map[string]*OpponentDossier{}
	}
	id := brain.BotID
	if id == "" {
		id = filepath.Base(dir)
	}
	return &Bot{Dir: dir, ID: id, Persona: string(persona), Style: style, Brain: &brain}, nil
}

// SaveBrain writes brain.json back atomically (temp file + rename).
func (b *Bot) SaveBrain() error {
	out, err := json.MarshalIndent(b.Brain, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	path := filepath.Join(b.Dir, "brain.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// AppendJournal writes a per-run markdown note under journal/<date>.md.
func (b *Bot) AppendJournal(date, content string) error {
	dir := filepath.Join(b.Dir, "journal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, date+".md")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(content)
	return err
}

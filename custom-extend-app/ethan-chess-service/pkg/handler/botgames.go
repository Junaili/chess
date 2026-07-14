package handler

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// Cap on the retained bot history. The trainer backfills every unprocessed
// completed game in this record, so a missed scheduler day does not lose data.
const botHistoryCap = 500

// BotGamesHandler accepts finished game records POSTed by the AMS bot DS
// (peerjs-bot-spike/ds.mjs reportGame) and appends them to the bot's admin
// game-record history — the source the daily self-learning trainer reads.
// Auth is the shared x-trigger-secret (same secret the DS trigger uses).
func BotGamesHandler(secret, botID string) http.HandlerFunc {
	key := BotHistoryKey(botID)
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if secret == "" || r.Header.Get("x-trigger-secret") != secret {
			w.WriteHeader(http.StatusForbidden)
			return
		}

		var entry botbrain.MatchEntry
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10)).Decode(&entry); err != nil {
			http.Error(w, "bad payload", http.StatusBadRequest)
			return
		}
		if err := validateCompletedBotGame(entry); err != nil {
			http.Error(w, "invalid game record: "+err.Error(), http.StatusBadRequest)
			return
		}

		duplicate, err := AppendBotGame(key, entry, botHistoryCap)
		if err != nil {
			log.Printf("bot-games: save history: %v", err)
			http.Error(w, "storage error", http.StatusBadGateway)
			return
		}
		log.Printf("bot-games: recorded game %s (%s, %d moves, duplicate=%v)",
			entry.ID, entry.Result, len(entry.Moves), duplicate)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "duplicate": duplicate})
	}
}

func validateCompletedBotGame(entry botbrain.MatchEntry) error {
	if entry.ID == "" || len(entry.ID) > 128 {
		return fmt.Errorf("missing or oversized id")
	}
	if len(entry.Mode) > 32 || len(entry.OpponentUserID) > 128 || len(entry.OpponentName) > 80 ||
		len(entry.WhiteName) > 80 || len(entry.BlackName) > 80 {
		return fmt.Errorf("oversized game metadata")
	}
	switch strings.ToLower(strings.TrimSpace(entry.BotColor)) {
	case "white", "black":
	default:
		return fmt.Errorf("botColor must be white or black")
	}
	switch strings.ToLower(strings.TrimSpace(entry.Result)) {
	case "win", "loss", "draw":
	default:
		return fmt.Errorf("result must be win, loss, or draw")
	}
	if len(entry.Moves) < 4 || len(entry.Moves) > 1024 {
		return fmt.Errorf("completed game must contain 4-1024 plies")
	}
	for i, move := range entry.Moves {
		if move.Fr < 0 || move.Fr > 7 || move.Fc < 0 || move.Fc > 7 ||
			move.ToR < 0 || move.ToR > 7 || move.ToC < 0 || move.ToC > 7 {
			return fmt.Errorf("move %d has an out-of-range square", i+1)
		}
		switch strings.ToLower(move.PromType) {
		case "", "queen", "rook", "bishop", "knight":
		default:
			return fmt.Errorf("move %d has an invalid promotion", i+1)
		}
	}
	if entry.EndedAt == "" {
		return fmt.Errorf("missing endedAt")
	}
	ended, err := time.Parse(time.RFC3339, entry.EndedAt)
	if err != nil || ended.IsZero() {
		return fmt.Errorf("endedAt must be RFC3339")
	}
	if entry.StartedAt == "" {
		return fmt.Errorf("missing startedAt")
	}
	started, err := time.Parse(time.RFC3339, entry.StartedAt)
	if err != nil || started.After(ended) {
		return fmt.Errorf("startedAt must be RFC3339 and no later than endedAt")
	}
	if entry.DurationMs < 0 || entry.DurationMs > int64(24*time.Hour/time.Millisecond) {
		return fmt.Errorf("durationMs is out of range")
	}
	return nil
}

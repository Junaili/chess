package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
)

// Cap on the stored bot history (the daily trainer only reads a ~24h window;
// this just bounds the admin record's size).
const botHistoryCap = 500

// BotGamesHandler accepts finished game records POSTed by the AMS bot DS
// (peerjs-bot-spike/ds.mjs reportGame) and appends them to the bot's admin
// game-record history — the source the daily self-learning trainer reads.
// Auth is the shared x-trigger-secret (same secret the DS trigger uses).
func BotGamesHandler(secret, botID string) http.HandlerFunc {
	var mu sync.Mutex // serialize read-modify-write of the history record
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
		if entry.ID == "" || len(entry.Moves) == 0 || len(entry.Moves) > 1024 {
			http.Error(w, "invalid game record", http.StatusBadRequest)
			return
		}

		mu.Lock()
		defer mu.Unlock()
		all, err := FetchAllBotGames(key)
		if err != nil {
			log.Printf("bot-games: fetch history: %v", err)
			http.Error(w, "storage error", http.StatusBadGateway)
			return
		}
		for _, m := range all {
			if m.ID == entry.ID {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true,"duplicate":true}`))
				return
			}
		}
		all = append(all, entry)
		if len(all) > botHistoryCap {
			all = all[len(all)-botHistoryCap:]
		}
		if err := SaveBotGameHistory(key, all); err != nil {
			log.Printf("bot-games: save history: %v", err)
			http.Error(w, "storage error", http.StatusBadGateway)
			return
		}
		log.Printf("bot-games: recorded game %s (%s, %d moves) — history now %d",
			entry.ID, entry.Result, len(entry.Moves), len(all))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
}

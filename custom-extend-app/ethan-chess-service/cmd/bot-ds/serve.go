package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/pion/webrtc/v3"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/botgame"
)

// serveGames starts a local HTTP signaling endpoint (POST /offer) so a browser
// can connect to this DS over WebRTC and play the bot. This is the LOCAL-DEV
// bridge for end-to-end testing; on AMS, signaling instead goes through AGS
// session data (the data channel itself is identical). CORS is open so the web
// game — a different origin in dev — can reach it.
func serveGames(addr string, bot *botbrain.Bot) {
	mux := http.NewServeMux()

	mux.HandleFunc("/offer", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var offer webrtc.SessionDescription
		if err := json.NewDecoder(r.Body).Decode(&offer); err != nil {
			http.Error(w, "bad offer", http.StatusBadRequest)
			return
		}
		answer, _, err := botgame.AnswerContext(r.Context(), offer, bot.Style, bot.ID)
		if err != nil {
			http.Error(w, "webrtc: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(answer)
	})

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = w.Write([]byte(`{"status":"ok","bot":"` + bot.ID + `"}`))
	})

	log.Printf("bot-ds: serving local game signaling on %s (POST /offer)", addr)
	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("bot-ds: serve error: %v", err)
		}
	}()
}

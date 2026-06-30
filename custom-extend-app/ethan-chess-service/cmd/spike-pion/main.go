// Command spike-pion de-risks the AMS bot architecture: a Go pion/webrtc server
// that holds a WebRTC data channel with a browser and plays the real bot brain
// over it (preview of the AMS dedicated server's core loop). The chess-over-
// data-channel logic lives in pkg/botgame, shared with the AMS DS.
//
// Signaling here is a simple same-origin HTTP POST /offer. On AMS, signaling
// moves to AGS session data over HTTPS — the data-channel transport is identical.
//
// Run:  go run ./cmd/spike-pion --bot-dir bots/gambit-gus
// Open: http://localhost:8090
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"

	"github.com/pion/webrtc/v3"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/botgame"
)

var (
	botStyle []byte
	botName  string
)

func main() {
	botDir := flag.String("bot-dir", "bots/gambit-gus", "bot directory (for style.json)")
	addr := flag.String("addr", ":8090", "HTTP listen address")
	webDir := flag.String("web", "cmd/spike-pion/web", "static web directory")
	flag.Parse()

	bot, err := botbrain.LoadBot(*botDir)
	if err != nil {
		log.Fatalf("load bot: %v", err)
	}
	botStyle = bot.Style
	botName = bot.ID

	http.Handle("/", http.FileServer(http.Dir(*webDir)))
	http.HandleFunc("/offer", handleOffer)

	log.Printf("spike-pion: bot %q ready — open http://localhost%s", botName, *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}

// handleOffer accepts the browser's SDP offer, hands it to botgame to wire up a
// data channel that plays the bot, and returns the SDP answer.
func handleOffer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var offer webrtc.SessionDescription
	if err := json.NewDecoder(r.Body).Decode(&offer); err != nil {
		http.Error(w, "bad offer", http.StatusBadRequest)
		return
	}
	answer, _, err := botgame.Answer(offer, botStyle, botName)
	if err != nil {
		http.Error(w, "webrtc: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(answer)
}

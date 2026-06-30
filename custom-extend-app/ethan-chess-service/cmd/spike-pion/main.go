// Command spike-pion de-risks the AMS bot architecture: it proves a Go server
// using pion/webrtc can hold a WebRTC data channel with a browser and play chess
// over it, with the REAL bot brain choosing moves server-side. This is a preview
// of the AMS dedicated server's core loop.
//
// Signaling here is a simple same-origin HTTP POST /offer (browser offers, server
// answers). In production on AMS, signaling instead goes through AGS session data
// (DS publishes its offer/ICE, client reads it over HTTPS) — but the data-channel
// transport proven here is identical.
//
// Run:  go run ./cmd/spike-pion --bot-dir bots/gambit-gus
// Open: http://localhost:8090
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"github.com/notnil/chess"
	"github.com/pion/webrtc/v3"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/selfplay"
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

// handleOffer accepts the browser's SDP offer, wires up a data channel that plays
// chess with the bot, and returns the SDP answer.
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

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	})
	if err != nil {
		http.Error(w, "peer connection: "+err.Error(), http.StatusInternalServerError)
		return
	}

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("peer connection state: %s", s)
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			_ = pc.Close()
		}
	})

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		s := &session{rng: rand.New(rand.NewSource(time.Now().UnixNano()))}
		dc.OnOpen(func() { log.Printf("data channel %q open", dc.Label()) })
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			reply := s.handle(msg.Data)
			if reply != "" {
				_ = dc.SendText(reply)
			}
		})
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		http.Error(w, "set remote: "+err.Error(), http.StatusInternalServerError)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		http.Error(w, "create answer: "+err.Error(), http.StatusInternalServerError)
		return
	}
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		http.Error(w, "set local: "+err.Error(), http.StatusInternalServerError)
		return
	}
	<-gatherDone // non-trickle: return the answer once ICE candidates are gathered

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(pc.LocalDescription())
}

// session is one browser's game vs the bot. Human plays White, bot plays Black.
type session struct {
	mu   sync.Mutex
	game *chess.Game
	rng  *rand.Rand
}

type clientMsg struct {
	Type string `json:"type"` // "new" | "move"
	UCI  string `json:"uci"`
}

func (s *session) handle(data []byte) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	var m clientMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return errMsg("bad message")
	}

	switch m.Type {
	case "new":
		s.game = chess.NewGame()
		return stateMsg(s.game, "white")

	case "move":
		if s.game == nil {
			s.game = chess.NewGame()
		}
		// Apply the human's move.
		hm, err := chess.UCINotation{}.Decode(s.game.Position(), m.UCI)
		if err != nil {
			return errMsg("illegal move: " + m.UCI)
		}
		if err := s.game.Move(hm); err != nil {
			return errMsg("illegal move: " + m.UCI)
		}
		if s.game.Outcome() != chess.NoOutcome {
			return gameoverMsg(s.game)
		}
		// Bot replies using its real move-selection logic.
		posBefore := s.game.Position()
		bm := selfplay.ChooseMove(s.game, botStyle, s.rng)
		if bm == nil {
			return gameoverMsg(s.game)
		}
		san := chess.AlgebraicNotation{}.Encode(posBefore, bm)
		uci := chess.UCINotation{}.Encode(posBefore, bm)
		if err := s.game.Move(bm); err != nil {
			return errMsg("bot move failed")
		}
		return moveMsg(s.game, uci, san)

	default:
		return errMsg("unknown message type")
	}
}

func stateMsg(g *chess.Game, youAre string) string {
	return jsonMsg(map[string]any{
		"type": "state", "fen": g.FEN(), "youAre": youAre, "bot": botName,
	})
}
func moveMsg(g *chess.Game, uci, san string) string {
	out := map[string]any{
		"type": "move", "uci": uci, "san": san, "fen": g.FEN(),
		"outcome": string(g.Outcome()), "method": g.Method().String(),
	}
	return jsonMsg(out)
}
func gameoverMsg(g *chess.Game) string {
	return jsonMsg(map[string]any{
		"type": "gameover", "fen": g.FEN(),
		"outcome": string(g.Outcome()), "method": g.Method().String(),
	})
}
func errMsg(text string) string { return jsonMsg(map[string]any{"type": "error", "message": text}) }

func jsonMsg(m map[string]any) string {
	b, err := json.Marshal(m)
	if err != nil {
		return fmt.Sprintf(`{"type":"error","message":%q}`, err.Error())
	}
	return string(b)
}

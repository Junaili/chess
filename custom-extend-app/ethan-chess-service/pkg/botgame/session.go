// Package botgame is the transport-agnostic core of a live bot game: it plays
// the bot against a remote opponent over a simple JSON message channel. The
// human plays White, the bot plays Black. Feed each inbound client message to
// Handle and send back the returned reply string. The same logic backs both the
// local pion spike and the AMS dedicated server.
package botgame

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/notnil/chess"

	"github.com/junaili/ethan-chess-service/pkg/selfplay"
)

// Session is one opponent's game vs the bot. Safe for the single-goroutine
// delivery a data channel provides; guarded anyway for safety.
type Session struct {
	mu      sync.Mutex
	game    *chess.Game
	rng     *rand.Rand
	style   []byte
	botName string
}

// NewSession creates a session that plays with the given style.json knobs.
func NewSession(style []byte, botName string) *Session {
	return &Session{
		rng:     rand.New(rand.NewSource(time.Now().UnixNano())),
		style:   style,
		botName: botName,
	}
}

type clientMsg struct {
	Type string `json:"type"` // "new" | "move"
	UCI  string `json:"uci"`
}

// Handle processes one client message and returns the reply to send back (or "").
func (s *Session) Handle(data []byte) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	var m clientMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return s.errMsg("bad message")
	}

	switch m.Type {
	case "new":
		s.game = chess.NewGame()
		return s.stateMsg("white")

	case "move":
		if s.game == nil {
			s.game = chess.NewGame()
		}
		hm, err := chess.UCINotation{}.Decode(s.game.Position(), m.UCI)
		if err != nil {
			return s.errMsg("illegal move: " + m.UCI)
		}
		if err := s.game.Move(hm); err != nil {
			return s.errMsg("illegal move: " + m.UCI)
		}
		if s.game.Outcome() != chess.NoOutcome {
			return s.gameoverMsg()
		}
		posBefore := s.game.Position()
		bm := selfplay.ChooseMove(s.game, s.style, s.rng)
		if bm == nil {
			return s.gameoverMsg()
		}
		san := chess.AlgebraicNotation{}.Encode(posBefore, bm)
		uci := chess.UCINotation{}.Encode(posBefore, bm)
		if err := s.game.Move(bm); err != nil {
			return s.errMsg("bot move failed")
		}
		return s.moveMsg(uci, san)

	default:
		return s.errMsg("unknown message type")
	}
}

// Outcome reports the engine outcome ("*" while ongoing) and method.
func (s *Session) Outcome() (outcome, method string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.game == nil {
		return "*", "NoMethod"
	}
	return string(s.game.Outcome()), s.game.Method().String()
}

func (s *Session) stateMsg(youAre string) string {
	return jsonMsg(map[string]any{"type": "state", "fen": s.game.FEN(), "youAre": youAre, "bot": s.botName})
}
func (s *Session) moveMsg(uci, san string) string {
	return jsonMsg(map[string]any{
		"type": "move", "uci": uci, "san": san, "fen": s.game.FEN(),
		"outcome": string(s.game.Outcome()), "method": s.game.Method().String(),
	})
}
func (s *Session) gameoverMsg() string {
	return jsonMsg(map[string]any{
		"type": "gameover", "fen": s.game.FEN(),
		"outcome": string(s.game.Outcome()), "method": s.game.Method().String(),
	})
}
func (s *Session) errMsg(text string) string {
	return jsonMsg(map[string]any{"type": "error", "message": text})
}

func jsonMsg(m map[string]any) string {
	b, err := json.Marshal(m)
	if err != nil {
		return fmt.Sprintf(`{"type":"error","message":%q}`, err.Error())
	}
	return string(b)
}

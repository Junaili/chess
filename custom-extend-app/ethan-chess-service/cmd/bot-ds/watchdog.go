package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Watchdog is the DS-side client for the AMS local watchdog. The DS connects via
// WebSocket (default ws://localhost:5555/watchdog), announces "ready" once it can
// serve a session, sends a "heartbeat" at least every 15s to stay healthy, and
// exits cleanly on "drain". (AMS DS states: Creating -> Ready -> In Session ->
// Draining.)
//
// AMS watchdog messages are JSON objects keyed by the message type with an object
// value, e.g. {"ready":{}}, {"heartbeat":{}}, and (received) {"drain":{}}.
type Watchdog struct {
	url     string
	conn    *websocket.Conn
	onDrain func()
	mu      sync.Mutex
	closed  bool
}

func NewWatchdog(url string) *Watchdog { return &Watchdog{url: url} }

// OnDrain registers the callback invoked when AMS asks the DS to drain.
func (w *Watchdog) OnDrain(fn func()) { w.onDrain = fn }

// Connect dials the watchdog. Returns an error if unreachable (e.g. local dev
// with no watchdog), letting the caller run in standalone mode.
func (w *Watchdog) Connect(ctx context.Context) error {
	c, _, err := websocket.DefaultDialer.DialContext(ctx, w.url, nil)
	if err != nil {
		return err
	}
	w.conn = c
	go w.readLoop()
	return nil
}

// SendReady tells the watchdog the DS can now be allocated to a session.
func (w *Watchdog) SendReady() error { return w.sendType("ready") }

// SendHeartbeat keeps the DS marked healthy.
func (w *Watchdog) SendHeartbeat() error { return w.sendType("heartbeat") }

// ResetSessionTimeout optionally extends the session timeout (e.g. a long game).
func (w *Watchdog) ResetSessionTimeout() error { return w.sendType("resetSessionTimeout") }

// StartHeartbeat sends a heartbeat on an interval until ctx is cancelled. AMS
// expects one at least every 15s.
func (w *Watchdog) StartHeartbeat(ctx context.Context, every time.Duration) {
	go func() {
		// Send one immediately so the DS is marked healthy right after ready.
		_ = w.SendHeartbeat()
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = w.SendHeartbeat()
			}
		}
	}()
}

// sendType writes a watchdog message of the form {"<msgType>":{}}.
func (w *Watchdog) sendType(msgType string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.conn == nil || w.closed {
		return nil
	}
	return w.conn.WriteJSON(map[string]map[string]any{msgType: {}})
}

func (w *Watchdog) readLoop() {
	for {
		_, data, err := w.conn.ReadMessage()
		if err != nil {
			return
		}
		log.Printf("watchdog <- %s", data) // debug: raw inbound message
		var msg map[string]json.RawMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if _, ok := msg["drain"]; ok {
			log.Printf("watchdog: drain received")
			if w.onDrain != nil {
				w.onDrain()
			}
		}
	}
}

func (w *Watchdog) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	if w.conn != nil {
		_ = w.conn.Close()
	}
}

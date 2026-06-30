package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Watchdog is the DS-side client for the AMS local watchdog. The DS connects via
// WebSocket (default ws://localhost:5555/watchdog), announces "ready" once it can
// serve a session, heartbeats to stay healthy, and exits cleanly on "drain".
// (AMS DS states: Creating -> Ready -> In Session -> Draining.)
//
// NOTE: the exact watchdog message wire format must be confirmed against the
// official AMS watchdog protocol / AccelByte DS SDK before production — the
// field names here are a placeholder. The semantics (ready / heartbeat / drain)
// and the transport (ws localhost:5555/watchdog) follow the AMS docs.
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

type wdMessage struct {
	Type string `json:"type"` // placeholder: "ready" | "heartbeat" | "drain"
}

// SendReady tells the watchdog the DS can now be allocated to a session.
func (w *Watchdog) SendReady() error { return w.send(wdMessage{Type: "ready"}) }

// StartHeartbeat sends periodic heartbeats until ctx is cancelled.
func (w *Watchdog) StartHeartbeat(ctx context.Context, every time.Duration) {
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = w.send(wdMessage{Type: "heartbeat"})
			}
		}
	}()
}

func (w *Watchdog) send(m wdMessage) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.conn == nil || w.closed {
		return nil
	}
	return w.conn.WriteJSON(m)
}

func (w *Watchdog) readLoop() {
	for {
		var m wdMessage
		if err := w.conn.ReadJSON(&m); err != nil {
			return
		}
		if m.Type == "drain" {
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

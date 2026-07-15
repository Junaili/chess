package main

import (
	"encoding/json"
	"testing"
)

func TestWatchdogMessagesUseAMSShapes(t *testing.T) {
	w := NewWatchdog("ws://localhost:5555/watchdog", "ds-test-123")
	var ready struct {
		Ready struct {
			DSID string `json:"dsid"`
		} `json:"ready"`
	}
	if err := json.Unmarshal(w.ready, &ready); err != nil {
		t.Fatalf("ready message is invalid JSON: %v", err)
	}
	if ready.Ready.DSID != "ds-test-123" {
		t.Fatalf("ready dsid = %q", ready.Ready.DSID)
	}
	if string(heartbeatMessage) != `{"heartbeat":{}}` {
		t.Fatalf("heartbeat message = %s", heartbeatMessage)
	}
}

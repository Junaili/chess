package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v3"
)

// TestDataChannelPlaysBotOverWebRTC stands up the spike's /offer handler, then
// connects a second pion peer (standing in for the browser), opens a data
// channel, plays 1.e4, and asserts the bot replies over the channel. This proves
// the end-to-end WebRTC data-channel transport + server-side chess, which is the
// core risk in the AMS architecture.
func TestDataChannelPlaysBotOverWebRTC(t *testing.T) {
	botStyle = []byte(`{"aggression":0.85,"king_attack_focus":0.8,"risk_tolerance":0.8}`)
	botName = "test-bot"

	mux := http.NewServeMux()
	mux.HandleFunc("/offer", handleOffer)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new peer connection: %v", err)
	}
	defer pc.Close()

	got := make(chan string, 8)
	dc, err := pc.CreateDataChannel("chess", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}
	dc.OnOpen(func() {
		// Human (White) opens with 1.e4; server creates the game on demand.
		_ = dc.SendText(`{"type":"move","uci":"e2e4"}`)
	})
	dc.OnMessage(func(msg webrtc.DataChannelMessage) { got <- string(msg.Data) })

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local: %v", err)
	}
	<-gatherDone

	body, _ := json.Marshal(pc.LocalDescription())
	resp, err := http.Post(srv.URL+"/offer", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post offer: %v", err)
	}
	defer resp.Body.Close()
	var answer webrtc.SessionDescription
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
		t.Fatalf("decode answer: %v", err)
	}
	if err := pc.SetRemoteDescription(answer); err != nil {
		t.Fatalf("set remote: %v", err)
	}

	select {
	case m := <-got:
		if !strings.Contains(m, `"type":"move"`) || !strings.Contains(m, `"uci"`) {
			t.Fatalf("expected a bot move over the data channel, got: %s", m)
		}
		t.Logf("bot replied over WebRTC data channel: %s", m)
	case <-time.After(20 * time.Second):
		t.Fatal("timed out waiting for the bot's reply over the data channel")
	}
}

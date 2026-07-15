package botgame

import (
	"context"
	"fmt"
	"time"

	"github.com/pion/webrtc/v3"
)

const iceGatherTimeout = 10 * time.Second

// Answer accepts a remote WebRTC SDP offer, wires the inbound data channel to a
// fresh bot game Session, and returns the local SDP answer (non-trickle: ICE is
// fully gathered before returning). The caller transports the offer/answer
// however it likes — HTTP for the local spike, AGS session data on AMS. The data
// channel itself is identical in both cases.
//
// The returned *PeerConnection is kept alive by pion's internal handlers; the
// caller may hold it to close on game end.
func Answer(offer webrtc.SessionDescription, style []byte, botName string) (webrtc.SessionDescription, *webrtc.PeerConnection, error) {
	return AnswerContext(context.Background(), offer, style, botName)
}

// AnswerContext is Answer with cancellation for the signaling/ICE-gathering
// phase. The context does not own the established PeerConnection; callers close
// the returned connection when their session ends, and terminal Pion states are
// also cleaned up automatically.
func AnswerContext(ctx context.Context, offer webrtc.SessionDescription, style []byte, botName string) (webrtc.SessionDescription, *webrtc.PeerConnection, error) {
	if err := ctx.Err(); err != nil {
		return webrtc.SessionDescription{}, nil, fmt.Errorf("gather ICE candidates: %w", err)
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	})
	if err != nil {
		return webrtc.SessionDescription{}, nil, err
	}

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		sess := NewSession(style, botName)
		dc.OnClose(func() {
			_ = pc.Close()
		})
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if reply := sess.Handle(msg.Data); reply != "" {
				_ = dc.SendText(reply)
			}
		})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed {
			_ = pc.Close()
		}
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		_ = pc.Close()
		return webrtc.SessionDescription{}, nil, err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		_ = pc.Close()
		return webrtc.SessionDescription{}, nil, err
	}
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		_ = pc.Close()
		return webrtc.SessionDescription{}, nil, err
	}
	timer := time.NewTimer(iceGatherTimeout)
	defer timer.Stop()
	select {
	case <-gatherDone:
	case <-ctx.Done():
		_ = pc.Close()
		return webrtc.SessionDescription{}, nil, fmt.Errorf("gather ICE candidates: %w", ctx.Err())
	case <-timer.C:
		_ = pc.Close()
		return webrtc.SessionDescription{}, nil, fmt.Errorf("gather ICE candidates: timed out after %s", iceGatherTimeout)
	}

	local := pc.LocalDescription()
	if local == nil {
		_ = pc.Close()
		return webrtc.SessionDescription{}, nil, fmt.Errorf("gather ICE candidates: missing local description")
	}
	return *local, pc, nil
}

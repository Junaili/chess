package botgame

import (
	"github.com/pion/webrtc/v3"
)

// Answer accepts a remote WebRTC SDP offer, wires the inbound data channel to a
// fresh bot game Session, and returns the local SDP answer (non-trickle: ICE is
// fully gathered before returning). The caller transports the offer/answer
// however it likes — HTTP for the local spike, AGS session data on AMS. The data
// channel itself is identical in both cases.
//
// The returned *PeerConnection is kept alive by pion's internal handlers; the
// caller may hold it to close on game end.
func Answer(offer webrtc.SessionDescription, style []byte, botName string) (webrtc.SessionDescription, *webrtc.PeerConnection, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	})
	if err != nil {
		return webrtc.SessionDescription{}, nil, err
	}

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		sess := NewSession(style, botName)
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if reply := sess.Handle(msg.Data); reply != "" {
				_ = dc.SendText(reply)
			}
		})
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
	<-gatherDone

	return *pc.LocalDescription(), pc, nil
}

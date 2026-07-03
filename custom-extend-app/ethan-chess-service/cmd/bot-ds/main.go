// Command bot-ds is the AccelByte AMS dedicated-server skeleton for the chess
// personality bot. When matchmaking can't pair a human with another human, AGS
// claims one of these bot DS instances for the session; the human connects and
// plays the bot, which runs the chess + brain server-side via pkg/botgame (the
// transport already proven in cmd/spike-pion).
//
// Lifecycle (per AMS — Creating -> Ready -> In Session -> Draining):
//
//	start -> connect watchdog -> send "ready" -> heartbeat
//	     -> on claim: subscribe to the AGS session, signal via session data,
//	        open the WebRTC data channel, play the game (botgame)
//	     -> on game end: record result to AGS
//	     -> on "drain": finish the active session, then exit.
//
// Real today: the watchdog client and the WebRTC + chess game core (botgame).
// Stubbed (need a live AMS fleet + AGS session wiring to run end-to-end): the
// session-claim subscription and the session-data signaling, marked TODO(ams).
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/pion/webrtc/v3"

	"github.com/junaili/ethan-chess-service/pkg/botbrain"
	"github.com/junaili/ethan-chess-service/pkg/botgame"
)

func main() {
	botDir := flag.String("bot-dir", "bots/gambit-gus", "bot directory (persona/style/brain)")
	watchdogURL := flag.String("watchdog-url", envOr("AMS_WATCHDOG_URL", "ws://localhost:5555/watchdog"), "AMS watchdog websocket URL")
	heartbeat := flag.Duration("heartbeat", 5*time.Second, "watchdog heartbeat interval")
	serveAddr := flag.String("serve-addr", "", "local game-serving address, e.g. :8090 (dev: lets a browser play the bot over WebRTC via POST /offer)")
	envFile := flag.String("env", ".env", "AGS credentials env file")
	flag.Parse()

	_ = godotenv.Load(*envFile)

	bot, err := botbrain.LoadBot(*botDir)
	if err != nil {
		log.Fatalf("load bot: %v", err)
	}
	log.Printf("bot-ds: bot %q (brain v%d, %d lessons) starting", bot.ID, bot.Brain.Version, len(bot.Brain.Lessons))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Local dev: serve games directly so a browser can play the bot over WebRTC
	// without AMS/AGS signaling. (On a real fleet, signaling comes via AGS.)
	localServe := *serveAddr != ""
	if localServe {
		serveGames(*serveAddr, bot)
	}

	// 1. Connect to the AMS watchdog and announce readiness.
	wd := NewWatchdog(*watchdogURL)
	wd.OnDrain(func() {
		if localServe {
			log.Printf("bot-ds: drain received (ignored — local serve mode keeps hosting games)")
			return
		}
		log.Printf("bot-ds: draining — will finish the active session and exit")
		stop()
	})
	if err := wd.Connect(ctx); err != nil {
		log.Printf("bot-ds: no watchdog at %s (%v) — running in standalone/dev mode", *watchdogURL, err)
	} else {
		defer wd.Close()
		if err := wd.SendReady(); err != nil {
			log.Printf("bot-ds: send ready: %v", err)
		}
		wd.StartHeartbeat(ctx, *heartbeat)
		log.Printf("bot-ds: registered with watchdog — ready for a session")
	}

	// 2. Wait to be claimed for a session, then serve it.
	//
	// TODO(ams): subscribe to AGS session notifications for this DS. On claim,
	// read the matched human's WebRTC offer from the session data and call
	// serveSession; the rest of the game plays over the data channel.
	log.Printf("bot-ds: waiting for a session claim (AGS session subscription not wired yet — TODO)")

	<-ctx.Done()
	log.Printf("bot-ds: shutting down")
}

// serveSession runs one claimed game. `offer` is the matched human's WebRTC offer
// (in production, read from AGS session data). It answers via the shared bot game
// core, after which the game plays out over the data channel.
//
// TODO(ams): publish `answer` to the AGS session data so the client can connect;
// watch the connection / session outcome; on game end record the result to AGS
// (stats, leaderboard, match history, and the bot's own history for the trainer).
func serveSession(_ context.Context, bot *botbrain.Bot, offer webrtc.SessionDescription) (webrtc.SessionDescription, error) {
	answer, pc, err := botgame.Answer(offer, bot.Style, bot.ID)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	_ = pc // hold to close on game end
	return answer, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

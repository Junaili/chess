// Command bot-ds is the AccelByte AMS dedicated-server skeleton for the chess
// personality bots. When matchmaking can't pair a human with another human, AGS
// claims one of these bot DS instances for the session; the human connects and
// plays the bot, which runs the chess + brain server-side via pkg/botgame (the
// transport already proven in cmd/spike-pion).
//
// One instance hosts every personality staged under --bots-dir. AMS claims a DS
// without knowing which bot the waiting player queued for, so the personality is
// chosen per claim from the game session's match pool (chess-quickmatch → Gambit
// Gus, fortress-fiona → Fortress Fiona) and each answers on its own
// session-storage signaling key. That is what lets one fleet — one buffer of
// warm servers — serve all of them.
//
// Lifecycle (per AMS — Creating -> Ready -> In Session -> Draining):
//
//	start -> connect watchdog -> send "ready" -> heartbeat
//	     -> on claim: subscribe to the AGS session, signal via session data,
//	        open the WebRTC data channel, play the game (botgame)
//	     -> on game end: record result to AGS
//	     -> on "drain": finish the active session, then exit.
//
// Real today: watchdog lifecycle, AGS claim polling, session-storage signaling,
// and the WebRTC + chess game core (botgame). Match-result persistence remains
// future work and is marked TODO(ams).
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
	botID := flag.String("bot-id", "", "default bot personality ID (or BOT_ID; default gambit-gus)")
	botDir := flag.String("bot-dir", "", "default bot directory (or BOT_DIR; default <bots-dir>/<bot-id>)")
	signalKey := flag.String("signal-key", "", "AGS session-storage signaling key for the default bot (or BOT_SIGNAL_KEY)")
	watchdogDefault := envOr("AMS_WATCHDOG_URL", "ws://localhost:5555/watchdog")
	watchdogURL := watchdogDefault
	flag.StringVar(&watchdogURL, "watchdog-url", watchdogDefault, "AMS watchdog websocket URL")
	flag.StringVar(&watchdogURL, "watchdog_url", watchdogDefault, "AMS-compatible watchdog websocket URL")
	flag.StringVar(&watchdogURL, "WatchdogUrl", watchdogDefault, "Unreal-compatible watchdog websocket URL")
	dsID := envOr("DS_ID", "")
	flag.StringVar(&dsID, "dsid", dsID, "AMS dedicated-server ID")
	var gamePort int
	flag.IntVar(&gamePort, "port", 0, "AMS-injected game port")
	heartbeat := flag.Duration("heartbeat", 15*time.Second, "watchdog heartbeat interval")
	serveAddr := flag.String("serve-addr", "", "local game-serving address, e.g. :8090 (dev: lets a browser play the bot over WebRTC via POST /offer)")
	envFile := flag.String("env", ".env", "AGS credentials env file")
	botsDir := flag.String("bots-dir", "", "directory holding every hostable bot personality (or BOTS_DIR; default bots)")
	flag.Parse()
	_ = gamePort // accepted for the future game listener/session integration

	_ = godotenv.Load(*envFile)

	// Resolved after godotenv.Load so a BOTS_DIR set only in .env still applies,
	// and resolved once so discovery and the roster agree on the same root.
	botsRoot := firstNonEmpty(*botsDir, os.Getenv("BOTS_DIR"), defaultBotsDir)
	discovered, err := discoverPersonaDirs(botsRoot)
	if err != nil {
		log.Fatalf("scan bots dir %s: %v", botsRoot, err)
	}
	roster, err := resolveBotRoster(botsRoot, discovered, *botID, *botDir, *signalKey, os.Getenv)
	if err != nil {
		log.Fatalf("configure bots: %v", err)
	}
	bots, err := loadRoster(roster)
	if err != nil {
		log.Fatalf("%v", err)
	}
	for _, persona := range roster.Personas {
		bot := bots[persona.ID]
		marker := ""
		if persona.ID == roster.DefaultID {
			marker = " (default)"
		}
		log.Printf("bot-ds: hosting %q (%s, brain v%d, %d lessons) for pool %q via %q%s",
			bot.ID, bot.Name, bot.Brain.Version, len(bot.Brain.Lessons), persona.MatchPool, persona.SignalKey, marker)
	}
	defaultBot := bots[roster.DefaultID]

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Local dev: serve games directly so a browser can play the bot over WebRTC
	// without AMS/AGS signaling. (On a real fleet, signaling comes via AGS.)
	localServe := *serveAddr != ""
	if localServe {
		serveGames(*serveAddr, defaultBot)
	}

	// 1. Connect to the AMS watchdog and announce readiness.
	wd := NewWatchdog(watchdogURL, dsID)
	wd.OnDrain(func() {
		if localServe {
			log.Printf("bot-ds: drain received (ignored — local serve mode keeps hosting games)")
			return
		}
		log.Printf("bot-ds: draining — will finish the active session and exit")
		stop()
	})
	if err := wd.Connect(ctx); err != nil {
		log.Printf("bot-ds: no watchdog at %s (%v) — running in standalone/dev mode", watchdogURL, err)
	} else {
		defer wd.Close()
		if err := wd.SendReady(); err != nil {
			log.Printf("bot-ds: send ready: %v", err)
		}
		wd.StartHeartbeat(ctx, *heartbeat)
		log.Printf("bot-ds: registered with watchdog — ready for a session")
	}

	// AGS attaches the claimed game session to this AMS DS. A server-only
	// client acknowledges readiness; local mode remains completely offline.
	if !localServe {
		if ags, enabled := newAGSSessionClient(); enabled && dsID != "" {
			go func() {
				session, err := ags.waitForClaim(ctx, dsID)
				if err != nil {
					log.Printf("bot-ds: AGS session discovery: %v", err)
					return
				}
				if err := ags.setReady(ctx, session.ID); err != nil {
					log.Printf("bot-ds: AGS session ready: %v", err)
					return
				}

				// AMS claims a DS without knowing which personality the waiting
				// player queued for; the session's match pool is what tells us.
				persona, matched := roster.forMatchPool(session.MatchPool)
				if !matched {
					persona = roster.defaultPersona()
					log.Printf("bot-ds: session %s has match pool %q, which no hosted bot claims — falling back to %q; "+
						"set BOT_MATCH_POOLS if the pool was renamed", session.ID, session.MatchPool, persona.ID)
				}
				bot := bots[persona.ID]
				log.Printf("bot-ds: AGS session %s (pool %q) is ready for signaling as %s via %q",
					session.ID, session.MatchPool, bot.Name, persona.SignalKey)

				pc, err := ags.answerSignal(ctx, session.ID, bot, persona.SignalKey)
				if err != nil {
					log.Printf("bot-ds: %s signaling: %v", bot.Name, err)
					return
				}
				defer pc.Close()
				log.Printf("bot-ds: %s WebRTC session connected", bot.Name)
				<-ctx.Done()
			}()
		} else {
			log.Printf("bot-ds: AGS session discovery disabled (set BOT_CLIENT_ID, BOT_CLIENT_SECRET, BOT_NAMESPACE, and BOT_BASE_URL)")
		}
	}

	// 2. waitForClaim polls the AGS game-session assignment for this DS. Once
	// claimed, answerSignal exchanges WebRTC descriptions through the selected
	// personality's session-storage key; gameplay then stays on the data channel.
	log.Printf("bot-ds: waiting for a session claim")

	<-ctx.Done()
	log.Printf("bot-ds: shutting down")
}

// serveSession runs one claimed game. `offer` is the matched human's WebRTC offer
// (in production, read from AGS session data). It answers via the shared bot game
// core, after which the game plays out over the data channel.
//
// TODO(ams): watch the connection / session outcome; on game end record the
// result to AGS (stats, leaderboard, match history, and the bot's own history
// for the trainer).
func serveSession(ctx context.Context, bot *botbrain.Bot, offer webrtc.SessionDescription) (webrtc.SessionDescription, error) {
	answer, pc, err := botgame.AnswerContext(ctx, offer, bot.Style, bot.Name)
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

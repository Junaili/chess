# Testing

End-to-end and unit tests for Ethan's Chess, covering the major features on both
the **browser** and **iOS/iPad** targets. Run the gate before every commit:

```bash
npm run test:precommit
```

## What runs

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm run test:unit` | Chess/AI logic, content moderation, and AGS Chat protocol | node only — fast |
| `npm run test:e2e` | Full app E2E on **Chromium (browser)** and **WebKit/iPad (iOS engine)** | Playwright browsers |
| `npm run test:live` | Live AGS integration (auth, stats, social, matchmaking, AGS Chat, online match) | `.env.test` creds |
| `npm run test:ios` | iOS/iPad **simulator** boot + render smoke | Xcode + iPad sim |
| `npm run test:precommit` | unit → build → e2e → live (the commit gate) | — |
| `npm run test:all` | precommit **plus** the iOS simulator smoke | Xcode |

Why this split: the iOS app is a Capacitor shell that loads the **same web
bundle** the WebKit/iPad Playwright project drives end-to-end — so `test:e2e`
already exercises the iOS app's feature logic on its real engine (WebKit).
`test:ios` then verifies the native shell itself builds, launches, and renders on
an iPad simulator. `test:ios` is kept out of `test:precommit` because
`xcodebuild` is slow; run it on demand or in CI.

## Feature coverage

- **Chess rules** (`tests/unit/chess-engine.test.cjs`): legal/illegal moves,
  castling (both sides, blocked-through-check), en passant, promotion +
  underpromotion, pins, check, checkmate, stalemate, draws (insufficient
  material, fifty-move, threefold repetition), move notation.
- **AI opponent** (`tests/unit/ai-engine.test.cjs`): returns legal moves, takes
  hanging material, material-symmetric evaluation, all difficulty depths.
- **AGS Chat transport** (`tests/unit/chat.test.cjs`): JSON-RPC connection and
  fragmentation, session/personal topics, history, send deduplication,
  authoritative filter updates, mute state, token refresh, and the invariant
  that PeerJS contains no chat payload.
- **Gameplay UI** (`tests/e2e/gameplay.spec.js`): play vs computer as white and
  black, computer replies, illegal-move rejection, hint, new game, resign /
  game-over — on Chromium and WebKit/iPad.
- **Navigation / smoke** (`tests/e2e/ui-smoke.spec.js`): home entry points, guest
  flow, login/register screens, board renders 32 pieces, no uncaught errors.
- **Live AGS** (`tests/e2e/live/`): password login + profile + logout,
  leaderboard + stats fetch, friends list, achievements modal, matchmaking
  ticket create/cancel, and a two-player online match with move sync over PeerJS
  plus text delivery over AGS Chat.
- **Video-call quality** (`tests/unit/video-call.test.cjs`,
  `tests/e2e/video-chat-gate.spec.js`): capture constraints, TURN response
  validation, privacy-safe WebRTC stats, adaptive quality transitions, media
  call/answer wiring, device controls, mute, and teardown with fake media.

## Video-call real-device matrix

Browser automation verifies behavior, but camera, microphone, Bluetooth, and
radio handoff quality must also be checked on physical devices before release.
Use two accounts that are friends and record the quality badge plus the
`video_call_quality` telemetry samples for each run.

| Scenario | Required checks |
| --- | --- |
| iPhone ↔ desktop, Wi-Fi | Echo-free speech, lip sync, 720p when bandwidth allows, mute/camera controls |
| iPad ↔ Android, cellular | Stable audio, adaptive video downgrade, portrait/landscape resize |
| AirPods/Bluetooth headset | Correct input/output route, no speaker echo, route change survives reconnect |
| Wi-Fi → cellular handoff | Reconnecting state appears, ICE restart recovers without ending the game |
| 3–8% packet loss / 250–500 ms RTT | Voice remains intelligible, quality moves to Fair/Poor, video drops before audio |
| TURN-forced call | Candidate type reports `relay`, UDP works, TCP/TLS fallback works on restricted networks |
| Incoming phone/audio interruption on iOS | Call audio pauses and resumes with `.videoChat` routing restored |

For a release candidate, run at least ten minutes per scenario and verify there
are no repeated freezes, runaway quality oscillation, raw IP addresses, or
device labels in telemetry. The iOS simulator smoke test proves native build and
plugin registration only; it does not substitute for physical audio hardware.

## Live tests setup

```bash
cp .env.test.example .env.test   # then fill in throwaway AGS test accounts
npm run test:live
```

Without `.env.test`, the live specs **skip** (they don't fail), so
`test:precommit` still passes on a machine without credentials. The two-player
online match needs the optional `TEST_USER_2_*` account.

The live Chat assertion also requires Chat to be enabled and the
`chess-quickmatch` session template to use `textChat: true` and
`textChatMode: GAME`.

Live tests run against real AGS through the vite dev server proxy (which avoids
CORS), so they need network access to the configured AccelByte environment.

## Notes

- The vite dev server (HTTPS, self-signed cert) is started automatically by
  Playwright; an already-running `npm run dev` is reused.
- Offline E2E specs block all AGS/PeerJS traffic so the app boots in its
  signed-out, fully-local guest mode.
- Override the iOS simulator with `IOS_SIM_UDID=<udid> npm run test:ios`.
- HTML report after an E2E run: `npx playwright show-report`.

# AGS Plan — In-Match Chat Migration

**Date:** 2026-07-01
**Approved feature:** Replace PeerJS in-match text chat with AccelByte Gaming Services Chat while preserving PeerJS for chess moves, reconnection, and video.

---

## Confirmed Context

- **Project:** Vanilla HTML/JavaScript chess game packaged for iOS with Capacitor.
- **AGS deployment:** Shared Cloud at `https://seal-chessags.prod.gamingservices.accelbyte.io`.
- **Namespace:** `seal-chessags`.
- **Game client:** Public IAM client `4d98466a671d4172aa98f9a3f1fa29d1`; authenticated player access tokens are held by the shared AGS SDK instance.
- **Existing realtime path:** `src/presence.js` owns the Lobby WebSocket for presence and invitations. `app.js` sends match chat directly through the PeerJS data channel.
- **Random matchmaking:** AGS Matchmaking creates a game session, but `src/matchmaking.js` currently discards the session ID after fetching its members.
- **Direct friend/invite matches:** These use PeerJS without creating an AGS game session.
- **SDKs:** `@accelbyte/sdk-lobby@5.2.6` is installed. `@accelbyte/sdk-chat@6.3.5` is current but not installed.
- **TypeScript SDK limitation:** The official TypeScript Chat package exposes REST configuration, history, mute, ban, and moderation APIs but does not expose the realtime Chat WebSocket client. The official Unity SDK documents the browser-compatible Chat JSON-RPC protocol and `/chat/` WebSocket endpoint.
- **AGS tooling:** AGS CLI `0.2.0` targets the correct Shared Cloud namespace but is not authenticated. Read-only API schema discovery works; live namespace configuration and permission-group verification do not.
- **Live verification:** Two test-account variables exist, but the primary stored password currently fails AGS login. End-to-end Chat verification is blocked until valid test credentials are supplied.

---

## Goal

All visible in-match text messages use AGS Chat transport:

1. Random matches use the chat topic automatically associated with the AGS game session.
2. Direct friend matches use an AGS personal topic between the two authenticated player IDs.
3. The UI displays AGS connection, send, filtering, mute, and reconnect errors.
4. PeerJS no longer carries or resynchronizes text-chat payloads.
5. The existing local profanity filter remains as defense in depth, while AGS Chat performs authoritative server-side filtering and retains moderator-accessible history.

---

## Non-Goals

- Moving chess moves, rematches, reconnection state, or video calls away from PeerJS.
- Implementing player/message reporting or blocking UI in this slice.
- Migrating anonymous invite-link users into AGS accounts. Chat will be unavailable when either participant lacks an authenticated AGS user ID.
- Replacing the existing matchmaking pool, rules, or P2P host selection.

---

## Affected Areas

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | Add `@accelbyte/sdk-chat@6.3.5` for public topic history/config APIs. |
| `src/chat.js` *(new)* | Browser Chat JSON-RPC WebSocket adapter, topic activation, send acknowledgements, incoming message events, history, token refresh, reconnect, and cleanup. |
| `src/matchmaking.js` | Return the AGS session ID and session data with matched member IDs. |
| `src/session.js` | Notify Chat when the AGS access token refreshes. |
| `src/main.js` | Own the Chat module lifecycle and expose narrow callbacks to the existing classic-script game layer. |
| `app.js` | Activate session/personal topics, send through AGS Chat, render AGS events, disable chat on service errors, and remove PeerJS chat frames/resync payloads. |
| `index.html`, `style.css` | Reuse the existing chat UI while exposing connecting, filtered, muted, and unavailable states. |
| `tests/e2e/live/online-match.live.spec.js` | Verify clean two-player AGS Chat delivery and confirm no PeerJS chat frame is used. |
| `tests/e2e/` and `tests/unit/` | Add lifecycle, filtering, reconnect, duplicate-message, and error-state coverage. |
| `README.md`, `TESTING.md` | Document Chat configuration and the live verification path. |

---

## AGS Modules

- **IAM** — supplies the authenticated player token used by Chat.
- **Chat** — realtime topics, profanity filtering, send/receive, history, mute/ban enforcement.
- **Session** — creates the random-match chat topic when the session template has text chat enabled.
- **Matchmaking** — existing path that creates the game session and supplies its ID.

---

## Authorization Plan

```text
Caller:                Game client (browser/Capacitor)
Environment:           Shared Cloud
Environment evidence:  VITE_ACCELBYTE_BASE_URL ends in gamingservices.accelbyte.io
Token source:           Authenticated player's AGS user access token
IAM client type:        Public
Secret location:        None; no client secret is shipped
AGS calls:              Chat WebSocket connect; actionRefreshToken;
                        sendChat; queryChat; actionCreateTopic;
                        TopicApi.getTopic/getChats_ByTopic; existing
                        GameSessionApi.getGamesession_BySessionId
Permission discovery:  AGS CLI schema discovery plus official SDK/docs;
                        CLI is unauthenticated for live client/group checks
Required permissions:  Chat player operations are user-token and
                        topic-membership scoped; the CLI does not expose
                        WebSocket permission metadata
Shared Cloud groups:    Not checked because AGS CLI has no operator session
Verified access:        No — blocked by invalid test credentials and
                        unverified namespace/session Chat configuration
```

No client secret or service token will be added to the app.

---

## Required AGS Admin Portal Setup

Before live verification:

1. Identify the session configuration template attached to match pool `chess-quickmatch`.
2. Set that template to:
   - `textChat: true`
   - `textChatMode: GAME`
3. Under **Multiplayer → Chat → Chat Configurations**:
   - Enable Chat.
   - Enable the default profanity filter.
   - Configure the profanity dictionary.
   - Set appropriate message length, rate, spam, and mute limits.
4. Confirm the two live-test accounts can authenticate.
5. Authenticate the AGS CLI or provide Admin Portal access so the template and Chat configuration can be read back.

Admin template mutations require `ADMIN:NAMESPACE:{namespace}:SESSION:CONFIGURATION [UPDATE]`. The matching Shared Cloud permission group cannot be named safely until the authenticated permission catalog is available.

---

## Implementation Steps

### Step 0 — Verify AGS configuration

Read back the quick-match session template and public Chat configuration. Do not remove PeerJS chat until Chat is enabled and the generated session exposes a session topic.

### Step 1 — Add the Chat SDK and browser adapter

- Install `@accelbyte/sdk-chat@6.3.5`.
- Implement the official Chat JSON-RPC envelope over `wss://seal-chessags.prod.gamingservices.accelbyte.io/chat/`.
- Use the current AGS access token as the WebSocket subprotocol.
- Implement request correlation, server events, fragmentation envelopes, bounded retries, token refresh, and idempotent cleanup.

### Step 2 — Propagate match/session identity

- Return `{ sessionId, session, memberUserIds }` from the matchmaking path.
- Bind the random match to its `s.` session topic.
- Wait for topic membership before enabling the chat input.

### Step 3 — Support direct friend matches

- After the two authenticated user IDs are known, create or resolve their AGS personal topic.
- Disable chat with a visible explanation if an invite-link participant is not authenticated.

### Step 4 — Replace the PeerJS chat transport

- Send only through AGS Chat and render only AGS `eventNewChat` events.
- Keep local profanity rejection before send.
- Treat server-filtered, muted, banned, rate-limited, and disconnected responses as visible UI states.
- Remove `type: "chat"` handling and `chatMessages` from PeerJS resynchronization.
- Do not silently fall back to P2P chat.

### Step 5 — Restore history and handle reconnection

- Query recent topic history on activation/reconnection.
- Deduplicate by AGS chat ID.
- Refresh the Chat token whenever IAM refreshes.
- Disconnect and clear topic state on logout or match exit.

### Step 6 — Verify

- Unit-test JSON-RPC request/response/event handling.
- Run existing unit and browser/iPad suites.
- Run the live two-account random-match test.
- Send a clean message in each direction and observe AGS delivery.
- Send configured profanity and verify the AGS response/history contains the configured filtered result or rejection.
- Confirm PeerJS carries no chat message or chat-history payload.
- Build and launch the iPad Release simulator app.

---

## Verification Contract

**Service evidence**

- Chat WebSocket emits `eventConnected`.
- Both players receive the session/personal topic.
- `sendChat` returns a successful response with chat/topic identifiers.
- The other player receives `eventNewChat`.
- `queryChat` or `TopicApi.getChats_ByTopic` returns the message.
- Configured profanity is filtered or rejected by AGS.

**Game-flow evidence**

- The existing Match Chat input is disabled while Chat connects.
- A sent message appears exactly once for both players.
- Filter, mute, rate-limit, and reconnect errors are visible and recoverable.
- Leaving the game clears Chat state and prevents cross-match messages.
- Moves, rematches, and video continue through PeerJS unchanged.

---

## Risks and Open Questions

1. **Session template is unverified:** AGS creates no session topic unless `textChat` is enabled.
2. **No TypeScript Chat WebSocket wrapper:** the browser adapter must remain small and conform exactly to the official JSON-RPC protocol.
3. **Live credentials are invalid:** service and game-flow completion cannot be claimed until two accounts authenticate.
4. **Topic timing:** clients may receive topic membership before or after PeerJS connects; activation must be order-independent.
5. **Direct invite links:** unauthenticated peers cannot use AGS Chat and will see chat unavailable.
6. **Moderation is broader than filtering:** Apple Guideline 1.2 still requires report, block, moderation response, and published contact mechanisms; those are outside this migration.

---

## Deferred Requested Integrations

*(none — this is a single-slice request)*

---

## Current Status

Implemented on 2026-07-02. Local protocol, browser, WebKit/iPad, production
build, and iPad simulator checks pass. Live AGS Chat verification remains
blocked until the configured test-account password and namespace Chat settings
can be verified.

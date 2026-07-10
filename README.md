# Ethan's Chess

A browser chess game — vanilla HTML, CSS, and JavaScript, integrated with [AccelByte Gaming Services (AGS)](https://docs.accelbyte.io/) for auth, social, and live-ops — that has grown into a small family-friendly online chess platform: friends and matchmaking, a parent-managed family/COPPA mode, achievements, a self-reflection coaching journal, player safety tooling, and an iOS app via Capacitor. A companion Go service (`custom-extend-app/`) deployed on AGS Extend backs the server-side pieces (email, parent-authorized child accounts, Sign in with Apple account deletion, GDPR deletion, and a self-learning matchmaking bot).

This project is intended to serve as a practical reference for integrating a browser-based game with AGS using the TypeScript Web SDK.

## Features

**Play**
- **Play vs Computer** — three difficulty levels powered by a minimax AI
- **Invite Friend** — share a link and play peer-to-peer via WebRTC (PeerJS)
- **Play vs Random** — AGS Matchmaking pairs you with a random online player, including a cold-start AI opponent ("Gus") backed by an AMS dedicated server
- **Guest Play** — try a game against the computer without creating an account
- **Move Hints** — on-demand hint, or post-move AI feedback
- **Live Spectating** — watch a friend's match in real time; replay moves after it ends

**Account & Social**
- **Sign in with Google, Apple, or email/password** — plus account creation, password reset, and display-name moderation
- **Friends & Presence** — friend requests, online status, and game invites over AGS Lobby
- **Match Chat** — AGS Chat provides session/private topics, history, and server-side profanity filtering
- **Video Chat** — built-in video/voice during online games (requires HTTPS), gated to friends
- **Family accounts** — COPPA-compliant parent-managed child accounts: age gate, no stored email for children, restricted friending, analytics forced off
- **Global Leaderboard** — ranked by wins, with Elo-style rating tracked per player
- **Achievements** — unlocked via AGS Achievements as players hit milestones
- **My Chess Journal** — post-game self-reflection, an AI coach report on weak phases/openings, and a puzzle practice loop generated from the player's own games
- **Player Safety** — report/block, content moderation on chat and display names, and an in-app privacy center with opt-in analytics consent

---

## Project Structure

```
chess-ethan/
├── index.html                # App shell and all UI screens
├── style.css                 # All styles
├── app.js                    # Chess UI, game flow, online multiplayer, video chat
├── chess-engine.js           # Chess logic (moves, rules, board state)
├── ai-engine.js               # Minimax AI with piece-square tables
├── vite.config.js            # Dev server (HTTPS + reverse proxy to AGS)
├── capacitor.config.json     # iOS app shell config
├── src/
│   ├── main.js                # App bootstrap; wires every screen and AGS call together
│   ├── ags-client.js          # AGS SDK initialisation
│   │
│   │   # Auth & session
│   ├── auth.js                 # Google/Apple/email login, registration, password reset
│   ├── auth-data.mjs           # Pure auth response parsing/mapping helpers
│   ├── session.js              # Token refresh scheduling, keep-alive
│   ├── native-auth-bounce.js   # iOS Capacitor OAuth redirect handling
│   ├── login-queue.js          # Serializes concurrent login attempts
│   │
│   │   # Player data, stats, social
│   ├── stats.js                 # Win/loss stats (Social Stats) + CloudSave match history
│   ├── match-stats.mjs          # Elo rating math, per-match aggregation (pure functions)
│   ├── match-resume.mjs         # Resuming an in-progress match after reload
│   ├── leaderboard.js           # Global leaderboard (LeaderboardDataV3Api)
│   ├── achievements.js          # AGS Achievements unlock + display
│   ├── friends.js               # Friend requests, list, lookup (Lobby + IAM)
│   ├── presence.js              # Online presence (Lobby WebSocket)
│   ├── chat.mjs                 # AGS Chat JSON-RPC WebSocket transport
│   ├── spectator.js             # Live match publishing/watching via CloudSave
│   ├── matchmaking.js           # Random matchmaking (MatchTicketsApi + GameSessionApi)
│   ├── gus.js / gus-data.mjs    # "Play with Gus" cold-start bot profile + challenge flow
│   │
│   │   # Family (COPPA)
│   ├── family.js                # Parent-managed child accounts, family membership
│   ├── family-safety.mjs        # Child-session detection and restriction rules (pure)
│   ├── family-feedback.mjs      # Copy/messaging for family flows (pure)
│   │
│   │   # Safety & moderation
│   ├── safety.js                 # Report/block a player (Lobby + Extend)
│   ├── safety-payloads.mjs       # Report payload shaping (pure)
│   ├── content-moderation.mjs    # Chat/display-name filtering client-side pass
│   ├── friend-feedback.mjs       # Copy/messaging for friend flows (pure)
│   │
│   │   # Journal & coaching
│   ├── journal.js                # Journal UI flow: reflection, coach report, puzzles
│   ├── journal-data.mjs          # Grading/puzzle-generation logic (pure)
│   │
│   │   # Privacy, telemetry, legal
│   ├── privacy-preferences.mjs   # Analytics consent storage (pure)
│   ├── telemetry.js              # Gameplay/funnel events sent to AGS Game Telemetry
│   ├── anon-id.js                # Device/session id + platform stamping for events
│   ├── legal.js / legal-data.mjs / legal-markdown.mjs   # AGS Legal fetch, accept, render
│   │
│   │   # Account lifecycle & backend bridge
│   ├── account-deletion.js            # Native account deletion (incl. Apple revocation)
│   ├── account-deletion-contract.mjs  # Request/response shaping (pure)
│   ├── extend-client.js               # Authenticated fetch wrapper for the Extend service
│   └── notifications.js               # In-app toast/notification rendering
│
├── custom-extend-app/ethan-chess-service/   # Go backend on AGS Extend — see below
├── peerjs-bot-spike/                        # Prototype: Node peer that speaks the P2P protocol
├── legal-documents/                         # Source docs + manifest for AGS Legal provisioning
├── scripts/                                  # Legal page generation, AGS Legal provisioning, iOS test runner
├── tests/                                    # Unit (node:test) + Playwright e2e/live suites — see TESTING.md
├── ios/                                      # Capacitor-generated native iOS project
├── appstore-screenshots/                     # App Store listing assets
├── .env.example                              # Environment variable template
└── .env.production                           # Production env vars (committed; no secrets)
```

`.mjs` files are pure logic (no AGS SDK calls, no DOM) with matching unit tests in `tests/unit/`; `.js` files wire that logic to AGS and the UI.

---

## Setting Up for Local Development

### 1. Prerequisites

- **Node.js 20.19+ or 22.12+**
- An AccelByte namespace (see [Integrating with AccelByte](#integrating-with-accelbyte-gaming-services) below)

### 2. Install dependencies

```bash
npm install
```

### 3. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
VITE_ACCELBYTE_BASE_URL=https://your-namespace.prod.gamingservices.accelbyte.io
VITE_ACCELBYTE_CLIENT_ID=your_client_id
VITE_ACCELBYTE_NAMESPACE=your-namespace
VITE_ACCELBYTE_REDIRECT_URI=https://192.168.x.x:8808/
```

Set `VITE_ACCELBYTE_REDIRECT_URI` to your machine's local IP (not `localhost` unless you're only testing from the same machine):

```bash
ipconfig getifaddr en0        # Mac
ipconfig | findstr "IPv4"     # Windows
```

### 4. Trust the self-signed certificate

The dev server runs over HTTPS using a local `cert.pem` / `key.pem` (generate your own self-signed pair; they're gitignored). Your browser will warn on first load — click **Advanced → Proceed** to continue.

### 5. Start the dev server

```bash
npm run dev
```

Friends, chat, family accounts, and other social features additionally require the Extend backend service running (see below) — the front end alone covers auth, stats, leaderboard, matchmaking, and CloudSave-backed features.

---

## Backend Service (AGS Extend)

`custom-extend-app/ethan-chess-service/` is a Go service deployed to [AGS Extend](https://docs.accelbyte.io/) that handles everything that needs a server-side client secret or admin-scoped IAM permission:

- Email delivery (welcome, invites, password reset support)
- Parent-authorized child account creation (family/COPPA)
- Sign in with Apple token revocation on account deletion
- GDPR/native account deletion
- Referral-triggered achievement unlocks
- A self-learning matchmaking bot ("Gus"), trained on a daily loop and served from an AMS dedicated server (`cmd/bot-ds`)

See `custom-extend-app/ethan-chess-service/.env.example` for required configuration (an AGS server-side IAM client, Apple credentials, CORS/invite-host allowlists) and its `Makefile` for build/deploy targets. The frontend talks to it through `src/extend-client.js`.

---

## Integrating with AccelByte Gaming Services

This section explains what AGS does in this game and how each service was integrated, so you can apply the same patterns to your own browser game. It covers the core client-side integration; family/COPPA, achievements, safety, and the Extend backend build on the same patterns and are covered at a higher level in [Features](#features) and [Backend Service](#backend-service-ags-extend) above.

### Overview of AGS services used

| Service | AGS Module | What it does in this game |
|---|---|---|
| Authentication | IAM | Google, Apple, and email/password sign-in; guest play; parent-managed child accounts |
| Player Stats | Social Stats | Tracks wins, losses, and rating per player |
| Match History | CloudSave | Stores per-player match records and live spectating state |
| Leaderboard | Leaderboard | Global win rankings |
| Matchmaking | Matchmaking v2 | Queues players and pairs them, including the AMS-backed bot |
| Match Chat | Chat | Session/private topics, history, filtering, and mute enforcement |
| Friends & Presence | Lobby | Friend list, online status, and player report/block |
| Achievements | Achievements | Milestone unlocks |
| Legal | Legal | Versioned Privacy Policy / Terms / Community Standards acceptance |
| Analytics | Game Telemetry | Gameplay and funnel event tracking, gated on opt-in consent |
| Live Spectating | CloudSave | Publishes live board state for watchers |

---

### Step 1 — Create an AGS namespace

Log in to the [AGS Admin Portal](https://prod.gamingservices.accelbyte.io). On Shared Cloud your namespace is provisioned for you. Your namespace's base URL will be:

```
https://your-namespace.prod.gamingservices.accelbyte.io
```

---

### Step 2 — Create an OAuth client

In **Admin Portal → IAM → OAuth Clients**, create a client with:

- **Type**: Public (browser apps cannot safely store a secret)
- **Redirect URIs**: every URL the app will run on, e.g.:
  - `https://192.168.x.x:8808/` (local dev)
  - `https://yourusername.github.io/your-repo/` (GitHub Pages)
- **Scopes**: `openid`, `offline`

Copy the **Client ID** — this goes into your `.env` as `VITE_ACCELBYTE_CLIENT_ID`.

---

### Step 3 — Install the AGS TypeScript Web SDK

```bash
npm install @accelbyte/sdk @accelbyte/sdk-iam @accelbyte/sdk-social \
            @accelbyte/sdk-leaderboard @accelbyte/sdk-matchmaking \
            @accelbyte/sdk-session @accelbyte/sdk-cloudsave @accelbyte/sdk-lobby \
            @accelbyte/sdk-chat @accelbyte/sdk-achievement @accelbyte/sdk-gametelemetry
```

Each package maps to one AGS service. Only install the ones you use.

---

### Step 4 — Initialise the SDK

All SDK calls share a single `sdk` instance, configured once at startup.

```js
// src/ags-client.js
import { AccelByte } from '@accelbyte/sdk'

const baseURL = import.meta.env.DEV
  ? window.location.origin        // dev: Vite proxies /iam, /cloudsave, etc. to AGS
  : import.meta.env.VITE_ACCELBYTE_BASE_URL

export const sdk = AccelByte.SDK({
  coreConfig: {
    baseURL,
    clientId:    import.meta.env.VITE_ACCELBYTE_CLIENT_ID,
    redirectURI: import.meta.env.VITE_ACCELBYTE_REDIRECT_URI || window.location.origin + '/',
    namespace:   import.meta.env.VITE_ACCELBYTE_NAMESPACE,
  },
  axiosConfig: {
    request: { withCredentials: true },
  },
})
```

In **development**, Vite's dev server acts as a reverse proxy — `/iam`, `/cloudsave`, `/social`, etc. are forwarded to AGS. This avoids CORS issues locally.

```js
// vite.config.js (dev proxy excerpt)
proxy: {
  '/iam':            { target: agsTarget, changeOrigin: true },
  '/cloudsave':      { target: agsTarget, changeOrigin: true },
  '/social':         { target: agsTarget, changeOrigin: true },
  '/leaderboard':    { target: agsTarget, changeOrigin: true },
  '/match2':         { target: agsTarget, changeOrigin: true },
  '/session':        { target: agsTarget, changeOrigin: true },
  '/lobby':          { target: agsTarget, changeOrigin: true, ws: true },
  '/achievement':    { target: agsTarget, changeOrigin: true },
  '/game-telemetry': { target: agsTarget, changeOrigin: true },
}
```

In **production**, the SDK calls AGS directly. AGS must have your domain in its CORS allowed origins.

---

### Step 5 — Authentication (AGS IAM)

The app supports Google (authorization code + PKCE), Apple, email/password, and guest play — all in `src/auth.js`. Google is the simplest to reason about and illustrates the pattern the others follow:

**How Google sign-in works:**

1. User clicks "Sign in with Google"
2. The AGS SDK generates a PKCE verifier, challenge, and CSRF-bound state
3. The system browser opens the AGS authorization page, where Google is the configured identity provider
4. AGS redirects back with a short-lived authorization code
5. The SDK verifies state and exchanges the code plus PKCE verifier for AGS tokens

```js
// src/auth.js
export async function loginWithGoogle() {
  const auth = new IamUserAuthorizationClient(sdk)
  window.location.assign(auth.createLoginURL())
}

export async function handleCallback() {
  const params = new URLSearchParams(window.location.search)
  return new IamUserAuthorizationClient(sdk).exchangeAuthorizationCode({
    code: params.get('code'),
    error: params.get('error'),
    state: params.get('state'),
  })
}
```

PKCE is designed for public clients: the app proves possession of a one-time verifier without embedding a client secret. Tokens are retained only for the current WebView/browser session.

**Required setup:**
- Configure Google as an identity provider in **AGS Admin Portal → IAM**
- Add the exact HTTPS redirect URI to the public IAM client
- For iOS, keep the HTTPS redirect page and register `io.github.junaili.chess:/oauth2redirect` as the native return URL

Email/password login and registration use `IamUserAuthorizationClient`'s password grant directly (`loginWithPassword`, `registerWithPassword` in `src/auth.js`); parent-managed child accounts go through the same registration call with a guardian's session and a `groupId` linking the child to the family (`registerChildAccount`).

---

### Step 6 — Player Stats

Create stat configurations in **Admin Portal → Stats → Stat Configurations**:

| Stat Code | Increment by | Description |
|---|---|---|
| `chess-wins` | 1 per win | Total wins |
| `chess-losses` | 1 per loss | Total losses |

```js
// src/stats.js
import { UserStatisticApi } from '@accelbyte/sdk-social'

// Initialise stat items on first login (safe to call every time — idempotent)
await UserStatisticApi(sdk).createStatitemBulk_ByUserId(userId, [
  { statCode: 'chess-wins' },
  { statCode: 'chess-losses' },
])

// Increment after a match
await UserStatisticApi(sdk).patchStatitemValue_ByUserId_ByStatCode(
  userId, 'chess-wins', { inc: 1 }
)

// Read a player's stats
const res = await UserStatisticApi(sdk).getStatitems_ByUserId(userId, {
  statCodes: 'chess-wins,chess-losses',
})
const wins   = res.data.data.find(i => i.statCode === 'chess-wins')?.value ?? 0
const losses = res.data.data.find(i => i.statCode === 'chess-losses')?.value ?? 0
```

---

### Step 7 — CloudSave (match history & live spectating)

CloudSave stores per-player JSON blobs accessible by key. No schema is required — you define the structure yourself.

This game uses two CloudSave keys:

| Key | Visibility | Content |
|---|---|---|
| `chess-match-history` | Public | Array of completed match records |
| `chess-live` | Public | Current board state, updated every move |

**Public records** use `__META: { is_public: true }` so other players can read them without authentication.

```js
// src/stats.js — write a public match history record
import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'

const api = PublicPlayerRecordApi(sdk, {
  coreConfig: { ...coreConfig, useSchemaValidation: false },
})

const record = {
  __META: { is_public: true },
  matches: [...existingMatches, newMatchEntry].slice(0, 50),
}

// Upsert pattern: try update, fall back to create on 404
try {
  await api.updateRecord_ByUserId_ByKey(userId, 'chess-match-history', record)
} catch (e) {
  if (e?.response?.status === 404) {
    await api.createRecord_ByUserId_ByKey(userId, 'chess-match-history', record)
  }
}

// Read another player's public record (no auth required on the caller's side)
const res = await api.getPublic_ByUserId_ByKey(targetUserId, 'chess-match-history')
const matches = res.data?.value?.matches || []
```

**Live spectating** publishes the board state after every move and polls for updates on the watcher's side:

```js
// src/spectator.js — publish after each move (the player's side)
export async function publishLiveMatch(userId, boardData) {
  const record = { __META: { is_public: true }, ...boardData, updatedAt: new Date().toISOString() }
  try {
    await api().updateRecord_ByUserId_ByKey(userId, 'chess-live', record)
  } catch (e) {
    if (e?.response?.status === 404) {
      await api().createRecord_ByUserId_ByKey(userId, 'chess-live', record)
    }
  }
}

// Poll for updates as a spectator (every 3 seconds)
export function startWatching(userId, onUpdate) {
  const poll = async () => {
    const res = await api().getPublic_ByUserId_ByKey(userId, 'chess-live')
    if (res.data?.value) onUpdate(res.data.value)
  }
  poll()
  _pollInterval = setInterval(poll, 3000)
}
```

---

### Step 8 — Leaderboard

Create a leaderboard in **Admin Portal → Leaderboard**:

- **Leaderboard Code**: `chess-wins-lb`
- **Stat Code**: `chess-wins` (entries are ranked automatically by this stat)
- **Sort**: descending
- **Cycle**: all-time

```js
// src/leaderboard.js
import { LeaderboardDataV3Api } from '@accelbyte/sdk-leaderboard'

// Fetch top 10 players
const res = await LeaderboardDataV3Api(sdk).getAlltime_ByLeaderboardCode_v3(
  'chess-wins-lb', { limit: 10, offset: 0 }
)
const rankings = res.data?.data || []
// Each entry: { userId, point, rank, additionalData }

// Fetch a specific player's rank
const rankRes = await LeaderboardDataV3Api(sdk).getUser_ByLeaderboardCode_ByUserId_v3(
  'chess-wins-lb', userId
)
const rank = rankRes.data?.allTime?.rank
```

> **Displaying names:** Leaderboard entries contain `userId` but not display names. Fetch names from IAM (`/iam/v4/public/namespaces/{ns}/users/{userId}`) and cache them in `localStorage` to avoid redundant calls.

---

### Step 9 — Matchmaking

Create a match pool in **Admin Portal → Matchmaking → Match Pools**:

- **Pool Name**: `chess-quickmatch`
- **Rule set**: basic (no skill rating needed for casual matching)
- **Team configuration**: 1v1
- **Ticket expiry**: 120 seconds

```js
// src/matchmaking.js
import { MatchTicketsApi } from '@accelbyte/sdk-matchmaking'
import { GameSessionApi }  from '@accelbyte/sdk-session'

// 1. Enter the queue
const res = await MatchTicketsApi(sdk).createMatchTicket({
  matchPool:  'chess-quickmatch',
  attributes: {},
  latencies:  {},
})
const ticketId = res.data.matchTicketID

// 2. Poll until matched (every 2 seconds)
const timer = setInterval(async () => {
  const r = await MatchTicketsApi(sdk).getMatchTicket_ByTicketid(ticketId)
  if (!r.data.matchFound) return

  clearInterval(timer)

  // 3. Fetch the session to get matched player IDs
  const session = await GameSessionApi(sdk).getGamesession_BySessionId(r.data.sessionID)
  const userIds = session.data.members.map(m => m.id)
  startOnlineGame(userIds)
}, 2000)

// Cancel if the player backs out
await MatchTicketsApi(sdk).deleteMatchTicket_ByTicketid(ticketId)
```

The same pool also matches players against "Gus," a bot running on an AGS AMS dedicated server, when no human opponent is available within a short window — see `src/gus.js` and `custom-extend-app/ethan-chess-service/cmd/bot-ds`.

---

### Step 10 — Match Chat

The app connects an authenticated player to the AGS Chat WebSocket after login.
Random matches use the `s.` topic created for their AGS game session. Direct
friend matches create an AGS personal topic for the two authenticated user IDs.
PeerJS continues carrying chess moves, rematches, reconnection state, and video,
but never carries text-chat messages or chat history.

The TypeScript Chat package supplies public configuration and history REST
calls. `src/chat.mjs` implements the realtime JSON-RPC commands used by the
official game SDKs (`actionCreateTopic`, `sendChat`, `queryChat`, and
`actionRefreshToken`) because the TypeScript package does not include the Chat
WebSocket wrapper.

Required AGS configuration:

- Enable Chat and its profanity filter under **Multiplayer → Chat → Chat Configurations**.
- Enable the default dictionary and configure message/rate/spam/mute limits.
- Set `textChat: true` and `textChatMode: GAME` on the session template used by
  the `chess-quickmatch` pool.
- Use authenticated accounts for both players. Anonymous invite-link players see
  chat as unavailable; the app does not fall back to unmoderated P2P chat.

---

### Step 11 — Friends & Presence (Lobby)

The AGS Lobby service provides a WebSocket connection for real-time events. This game uses it for:

- **Online presence** — knowing who is in-game vs. on the home screen
- **Friend list** — fetching friends and managing requests
- **Game invites** — sending and receiving match invitations between friends
- **Report/block** — player safety actions (`src/safety.js`)

The Lobby WebSocket connection is established on login. Friend data is fetched via REST; real-time notifications (friend requests, invitations, presence changes) arrive over the WebSocket.

See `src/main.js` for the full implementation — search for `renderFriendsListOnlineFirst` and the lobby event handlers.

---

## iOS App

The web app ships to iOS via [Capacitor](https://capacitorjs.com/), reusing the same codebase with a native shell:

```bash
npm run ios:build   # builds the web bundle and syncs it into ios/App
```

`src/native-auth-bounce.js` handles the OAuth redirect back into the native app (`io.github.junaili.chess:/oauth2redirect`), and `capacitor.config.json` configures the app id and native HTTP plugin. See `TESTING.md` for the iOS test target and `scripts/test-ios.sh`.

---

## Testing

```bash
npm run test:unit   # node:test — pure logic in src/*.mjs
npm run test:e2e    # Playwright — offline/mocked AGS, chromium + webkit-ipad
npm run test:live   # Playwright — live AGS namespace, requires .env.test (see .env.test.example)
npm run test        # unit + e2e
```

See `TESTING.md` for the full breakdown of what each suite covers and the pre-commit gate.

---

## Deploying to GitHub Pages

### 1. Set `base` in `vite.config.js`

GitHub Pages serves your app at `/your-repo/`. Without this, asset paths will be wrong.

```js
// vite.config.js
export default defineConfig(({ command }) => ({
  base: '/your-repo/',
  server: {
    // Only load SSL certs in dev — they don't exist in CI
    ...(command === 'serve'
      ? { https: { key: readFileSync('./key.pem'), cert: readFileSync('./cert.pem') } }
      : {}),
  },
}))
```

### 2. Use an exact HTTPS OAuth redirect URI

Set `VITE_ACCELBYTE_REDIRECT_URI` to the exact deployed application URL, including its repository subpath and trailing slash. Register that same value on the public AGS IAM client.

### 3. Commit `.env.production`

Vite reads `.env.production` automatically during `npm run build`. Put non-secret production values here and commit it.

```env
VITE_ACCELBYTE_BASE_URL=https://your-namespace.prod.gamingservices.accelbyte.io
VITE_ACCELBYTE_CLIENT_ID=your_client_id
VITE_ACCELBYTE_NAMESPACE=your-namespace
VITE_ACCELBYTE_REDIRECT_URI=https://yourusername.github.io/your-repo/
```

Only place public client configuration in `.env.production`. Server client secrets belong in the Extend deployment secret store and must never use a `VITE_` prefix.

### Version and publish legal agreements in AGS

Privacy Policy, Terms of Use, and Community Standards are stored in `legal-documents/` and provisioned as mandatory, versioned AGS Legal policies. The manifest display version is immutable after publication: when wording changes, update the source document and bump `displayVersion`.

```bash
ags auth login
npm run legal:provision             # read-only plan
npm run legal:provision -- --apply  # create/upload/commit/publish
```

The app checks AGS eligibility after login, displays each AGS-hosted localized attachment, and records acceptance with `POST /agreement/public/agreements/policies`. Do not treat the public website mirror as an acceptance record.

### 4. GitHub Actions workflow

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: write
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run build
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
```

### 5. Enable GitHub Pages

**Settings → Pages → Source: Deploy from a branch → Branch: `gh-pages` / root**

### 6. Register your application redirect URI

Add `https://yourusername.github.io/your-repo/` to **AGS Admin Portal → IAM → OAuth Clients → Redirect URIs**. Configure Google's separate AGS provider callback in the Google Cloud Console as directed by the AGS Admin Portal.

---

## Tech Stack

- Vanilla JavaScript (no frameworks) on the frontend, Go on the backend (AGS Extend)
- [Vite](https://vitejs.dev/) — dev server and build tool
- [Capacitor](https://capacitorjs.com/) — iOS app shell
- [PeerJS](https://peerjs.com/) — WebRTC peer-to-peer chess moves and video
- [AccelByte Gaming Services SDK](https://docs.accelbyte.io/) — auth, stats, leaderboard, matchmaking, chat, CloudSave, friends, achievements, legal, game telemetry
- [Playwright](https://playwright.dev/) + `node:test` — e2e and unit testing
- Web Audio API — sound effects
- WebRTC `getUserMedia` — video chat

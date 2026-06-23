# Ethan's Chess

A fully-featured browser chess game built with vanilla HTML, CSS, and JavaScript — integrated with [AccelByte Gaming Services (AGS)](https://docs.accelbyte.io/) for authentication, player stats, leaderboards, matchmaking, friends, and live spectating.

This project is intended to serve as a practical reference for integrating a browser-based game with AGS using the TypeScript Web SDK.

## Features

- **Play vs Computer** — three difficulty levels powered by a minimax AI
- **Invite Friend** — share a link and play peer-to-peer via WebRTC (PeerJS)
- **Play vs Random** — AGS Matchmaking pairs you with a random online player
- **Sign in with Google** — tracks wins/losses and shows a global leaderboard
- **Video Chat** — built-in video/voice during online games (requires HTTPS)
- **Live Spectating** — watch a friend's match in real time; replay moves after it ends
- **Move Hints** — on-demand hint, or post-move AI feedback

---

## Project Structure

```
chess-ethan/
├── index.html            # App shell and all UI screens
├── style.css             # All styles
├── app.js                # UI, game flow, online multiplayer, video chat
├── chess-engine.js       # Chess logic (moves, rules, board state)
├── ai-engine.js          # Minimax AI with piece-square tables
├── vite.config.js        # Dev server (HTTPS + reverse proxy to AGS)
├── src/
│   ├── ags-client.js     # AGS SDK initialisation
│   ├── auth.js           # Google login → AGS IAM (id_token flow)
│   ├── stats.js          # Win/loss stats + CloudSave match history
│   ├── leaderboard.js    # Global leaderboard (LeaderboardDataV3Api)
│   ├── matchmaking.js    # Random matchmaking (MatchTicketsApi + GameSessionApi)
│   ├── spectator.js      # Live match publishing/watching via CloudSave
│   └── telemetry.js      # Match telemetry stored in CloudSave
├── .env.example          # Environment variable template
└── .env.production       # Production env vars (committed; no secrets)
```

---

## Setting Up for Local Development

### 1. Prerequisites

- **Node.js 18+**
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
VITE_ACCELBYTE_GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
```

Set `VITE_ACCELBYTE_REDIRECT_URI` to your machine's local IP (not `localhost` unless you're only testing from the same machine):

```bash
ipconfig getifaddr en0        # Mac
ipconfig | findstr "IPv4"     # Windows
```

### 4. Trust the self-signed certificate

The dev server runs over HTTPS using the included `cert.pem` / `key.pem`. Your browser will warn on first load — click **Advanced → Proceed** to continue.

### 5. Start the dev server

```bash
npm run dev
```

---

## Integrating with AccelByte Gaming Services

This section explains what AGS does in this game and how each service was integrated, so you can apply the same patterns to your own browser game.

### Overview of AGS services used

| Service | AGS Module | What it does in this game |
|---|---|---|
| Authentication | IAM | Google Sign-In and session management |
| Player Stats | Social Stats | Tracks wins and losses per player |
| Match History | CloudSave | Stores per-player match records |
| Leaderboard | Leaderboard | Global win rankings |
| Matchmaking | Matchmaking v2 | Queues players and pairs them |
| Friends & Presence | Lobby | Friend list and online status |
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
            @accelbyte/sdk-session @accelbyte/sdk-cloudsave @accelbyte/sdk-lobby
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
  '/iam':         { target: agsTarget, changeOrigin: true },
  '/cloudsave':   { target: agsTarget, changeOrigin: true },
  '/social':      { target: agsTarget, changeOrigin: true },
  '/leaderboard': { target: agsTarget, changeOrigin: true },
  '/match2':      { target: agsTarget, changeOrigin: true },
  '/session':     { target: agsTarget, changeOrigin: true },
  '/lobby':       { target: agsTarget, changeOrigin: true, ws: true },
}
```

In **production**, the SDK calls AGS directly. AGS must have your domain in its CORS allowed origins.

---

### Step 5 — Authentication (Google Sign-In via AGS IAM)

**How it works:**

1. User clicks "Sign in with Google"
2. Browser redirects to Google's OAuth endpoint requesting an **ID token**
3. Google redirects back to your app with `#id_token=...` in the URL hash
4. Your app POSTs the ID token to AGS's platform token endpoint
5. AGS verifies the token using Google's public keys and returns an AGS access token

```js
// src/auth.js — step 2: redirect to Google
export async function loginWithGoogle() {
  const nonce = Math.random().toString(36).slice(2, 18)
  sessionStorage.setItem('ags_google_nonce', nonce)

  const params = new URLSearchParams({
    client_id:     import.meta.env.VITE_ACCELBYTE_GOOGLE_CLIENT_ID,
    redirect_uri:  getGoogleRedirectUri(),
    response_type: 'id_token',
    scope:         'openid email profile',
    nonce,
    prompt:        'select_account',
  })
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

// steps 3–5: called when the page reloads after Google redirects back
export async function handleCallback() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1))
  const idToken = hashParams.get('id_token')
  if (!idToken) return null

  const { coreConfig } = sdk.assembly()
  const resp = await fetch(`${coreConfig.baseURL}/iam/v3/oauth/platforms/google/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(coreConfig.clientId + ':')}`,
    },
    body: new URLSearchParams({ platform_token: idToken }).toString(),
    credentials: 'include',
  })
  const tokenData = await resp.json()
  sdk.setToken({ accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token })
  return tokenData
}
```

> **Why `id_token` and not an authorization `code`?**
> Authorization codes require a server-side client secret to exchange. Browser apps are public clients — they cannot safely hold secrets. The ID token implicit flow lets AGS verify the token directly using Google's published public keys, with no server-side exchange needed.

**Required setup:**
- In **Google Cloud Console → Credentials**: add your redirect URI(s) to *Authorized redirect URIs*
- In **AGS Admin Portal → IAM → OAuth Clients**: add the same redirect URI(s)
- Set your Google Client ID in `.env` as `VITE_ACCELBYTE_GOOGLE_CLIENT_ID`

**Detecting the callback in your app:**
Google returns the ID token in the URL **hash** (`#id_token=...`), not the query string. Make sure your page-load auth check looks at both:

```js
// src/main.js — on page load
const params     = new URLSearchParams(window.location.search)
const hashParams = new URLSearchParams(window.location.hash.slice(1))
const hasCallback = params.has('code') || params.has('error') ||
                    hashParams.has('id_token') || hashParams.has('error')

if (hasCallback) {
  await handleCallback()
}
```

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

---

### Step 10 — Friends & Presence (Lobby)

The AGS Lobby service provides a WebSocket connection for real-time events. This game uses it for:

- **Online presence** — knowing who is in-game vs. on the home screen
- **Friend list** — fetching friends and managing requests
- **Game invites** — sending and receiving match invitations between friends

The Lobby WebSocket connection is established on login. Friend data is fetched via REST; real-time notifications (friend requests, invitations, presence changes) arrive over the WebSocket.

See `src/main.js` for the full implementation — search for `renderFriendsListOnlineFirst` and the lobby event handlers.

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

### 2. Use `BASE_URL` for the OAuth redirect URI

`window.location.origin + '/'` produces the wrong URI on a subpath deployment. Use `import.meta.env.BASE_URL` instead — Vite sets it to the configured base path at build time.

```js
// src/auth.js
function getGoogleRedirectUri() {
  if (isPrivateIp(window.location.hostname)) {
    return import.meta.env.VITE_ACCELBYTE_REDIRECT_URI  // dev: use explicit .env value
  }
  return window.location.origin + import.meta.env.BASE_URL  // e.g. https://user.github.io/chess/
}
```

### 3. Commit `.env.production`

Vite reads `.env.production` automatically during `npm run build`. Put non-secret production values here and commit it.

```env
VITE_ACCELBYTE_BASE_URL=https://your-namespace.prod.gamingservices.accelbyte.io
VITE_ACCELBYTE_CLIENT_ID=your_client_id
VITE_ACCELBYTE_NAMESPACE=your-namespace
VITE_ACCELBYTE_REDIRECT_URI=https://yourusername.github.io/your-repo/
```

Keep secrets (like `VITE_ACCELBYTE_GOOGLE_CLIENT_ID`) out of `.env.production` and inject them at build time via GitHub Secrets.

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
      - name: Inject secrets
        run: echo "VITE_ACCELBYTE_GOOGLE_CLIENT_ID=${{ secrets.VITE_ACCELBYTE_GOOGLE_CLIENT_ID }}" >> .env.production
      - run: npm run build
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
```

Add `VITE_ACCELBYTE_GOOGLE_CLIENT_ID` as a repository secret in **Settings → Secrets and variables → Actions**.

### 5. Enable GitHub Pages

**Settings → Pages → Source: Deploy from a branch → Branch: `gh-pages` / root**

### 6. Register your redirect URI everywhere

Add `https://yourusername.github.io/your-repo/` to:
- **Google Cloud Console → Credentials → Authorized redirect URIs**
- **AGS Admin Portal → IAM → OAuth Clients → Redirect URIs**

---

## Tech Stack

- Vanilla JavaScript (no frameworks)
- [Vite](https://vitejs.dev/) — dev server and build tool
- [PeerJS](https://peerjs.com/) — WebRTC peer-to-peer connections
- [AccelByte Gaming Services SDK](https://docs.accelbyte.io/) — auth, stats, leaderboard, matchmaking, CloudSave, friends
- Web Audio API — sound effects
- WebRTC `getUserMedia` — video chat

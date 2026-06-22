# Ethan's Chess

A fully-featured chess game built with vanilla HTML, CSS, and JavaScript. Play against an AI, invite a friend, or be matched against a random online opponent.

## Features

- **Play vs Computer** — three difficulty levels powered by a minimax AI
- **Invite Friend** — share a link and play peer-to-peer via WebRTC (PeerJS)
- **Play vs Random** — AGS Matchmaking pairs you with a random online player
- **Sign in with Google** — tracks your wins/losses and shows a global leaderboard
- **Video Chat** — built-in video/voice call during online games (requires HTTPS)
- **Move Hints** — hint on demand, or post-move feedback vs the AI's suggestion
- **Customizable Piece Colors**, castling, en passant, promotion, move history, captured pieces

---

## Setting Up for Local Development

### 1. Prerequisites

- **Node.js 18+** — download from https://nodejs.org
- A terminal (Terminal on Mac, PowerShell or Git Bash on Windows)

### 2. Install dependencies

```bash
npm install
```

### 3. Create your `.env` file

Copy the example and fill in your machine's local IP address:

```bash
cp .env.example .env
```

Open `.env` and change the `VITE_ACCELBYTE_REDIRECT_URI` line to:

```
VITE_ACCELBYTE_REDIRECT_URI=https://<YOUR_LOCAL_IP>:8808/
```

To find your local IP:
- **Mac**: `ipconfig getifaddr en0`
- **Windows**: run `ipconfig` and look for "IPv4 Address"

Example:
```
VITE_ACCELBYTE_REDIRECT_URI=https://192.168.1.42:8808/
```

> **Why?** Google Sign-In redirects back to this URL after login. It must match your machine's address exactly. Using `localhost` works if you only test from that machine.

### 4. Trust the self-signed certificate

The server runs on HTTPS using the included `cert.pem` / `key.pem`. Your browser will show a security warning on first load.

- **Chrome / Edge**: click **Advanced** → **Proceed to localhost (unsafe)**
- **Firefox**: click **Advanced** → **Accept the Risk and Continue**

This is normal for local development — the certificate is self-signed.

### 5. Start the dev server

```bash
npm run dev
```

Open the URL printed in the terminal — usually `https://localhost:8808/` or `https://<YOUR_IP>:8808/`.

---

## Playing Online

### Invite Friend
1. Sign in with Google
2. Click **Invite Friend**
3. Share the generated link — the game starts when they open it

### Play vs Random
1. Sign in with Google (required)
2. Click **Play vs Random** — the button appears after sign-in
3. Wait to be matched with another player in the queue
4. The game starts automatically when a match is found

---

## Project Structure

```
chess-ethan/
├── index.html            # App shell and all UI screens
├── style.css             # Styles
├── app.js                # UI, game flow, online multiplayer, video chat
├── chess-engine.js       # Game logic (moves, rules, board state)
├── ai-engine.js          # Minimax AI with piece-square tables
├── vite.config.js        # Dev server + HTTPS proxy to AccelByte backend
├── src/
│   ├── ags-client.js     # AccelByte SDK initialisation
│   ├── auth.js           # Google login via AccelByte IAM
│   ├── stats.js          # Win/loss stat tracking
│   ├── leaderboard.js    # Global leaderboard
│   └── matchmaking.js    # Random matchmaking (AGS Matchmaking v2)
├── cert.pem / key.pem    # Self-signed TLS cert for local HTTPS
└── .env.example          # Environment variable template
```

## Tech Stack

- Vanilla JavaScript (no frameworks)
- [Vite](https://vitejs.dev/) — dev server and build tool
- [PeerJS](https://peerjs.com/) — WebRTC peer-to-peer connections
- [AccelByte Gaming Services SDK](https://docs.accelbyte.io/) — auth, stats, leaderboard, matchmaking
- Web Audio API — capture sound effects
- WebRTC `getUserMedia` — video chat

# Ethan's Chess

A fully-featured chess game built with vanilla HTML, CSS, and JavaScript. Play against an AI or challenge a friend online — no accounts, no installs.

## Features

- **Play vs Computer** — three difficulty levels (Easy, Medium, Hard) powered by a minimax AI with piece-square table evaluation
- **Online Multiplayer** — invite a friend via a shareable link using peer-to-peer WebRTC (PeerJS); no server required
- **Video Chat** — built-in video/voice call with your opponent during online games (requires HTTPS)
- **Move Hints** — ask for a hint at any time, or get post-move feedback comparing your move to the AI's suggestion
- **Customizable Piece Colors** — choose from preset color themes or pick any custom color
- **Full Chess Rules** — castling, en passant, pawn promotion, check/checkmate/stalemate detection
- **Move History** — scrollable sidebar with standard algebraic notation
- **Captured Pieces & Score** — material advantage tracked live
- **Rematch** — request a rematch at the end of an online game (colors swap each round)
- **Connection Recovery** — automatic reconnect with full board resync if the online connection drops

## Getting Started

### Prerequisites

- Node.js (for the local HTTPS server)

### Run

Double-click `start_server.command` or run it from the terminal:

```bash
./start_server.command
```

This starts a local HTTPS server. Open the URL printed in the terminal (e.g. `https://localhost:8000`).

> **Note:** The server uses a self-signed certificate (`cert.pem` / `key.pem`). Your browser will show a security warning — click **Advanced → Proceed** to continue. HTTPS is required for video chat and the Web Audio API.

## Project Structure

```
chess/
├── index.html          # App shell and all UI screens
├── style.css           # Styles
├── chess-engine.js     # Game logic (moves, rules, board state)
├── ai-engine.js        # Minimax AI with piece-square tables
├── app.js              # UI, online multiplayer, video chat
└── start_server.command  # Local HTTPS server launcher
```

## Online Multiplayer

1. Click **Invite Friend** on the home screen
2. Share the generated link with your opponent
3. The game starts automatically when they open it

Both players connect directly via WebRTC — no external game server is involved beyond PeerJS's signalling service.

## Tech Stack

- Vanilla JavaScript (no frameworks)
- [PeerJS](https://peerjs.com/) for WebRTC peer-to-peer connections
- Web Audio API for capture sound effects
- WebRTC `getUserMedia` for video chat

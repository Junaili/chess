# PeerJS bot spike

De-risks the **make-or-break** piece of the cold-start matchmaking bot: can a
**Node `peerjs` + `wrtc` peer** interoperate with the **unmodified** Ethan's Chess
web client's P2P protocol and play a full game?

It reuses the real `chess-engine.js` + `ai-engine.js` (loaded into Node via
`engine.mjs`) so move legality matches the client exactly, and speaks the same
wire protocol as `app.js`: the `game_start` handshake, `{type:'move',fr,fc,toR,toC,promType}`
messages, `player_info`, and `ping`/`pong` keepalive.

## Setup
```bash
cd peerjs-bot-spike
npm install            # pulls @roamhq/wrtc (native, prebuilt for macOS arm64), peerjs, ws
```

## Test it against the live web client (bot = joiner — easiest)
1. Open the web game (e.g. https://junaili.github.io/chess/), sign in, and click
   **Invite Friend**. Copy the **peer id** from the invite link — it's the value
   of the `?peer=` query param (e.g. https://junaili.github.io/chess/?peer=<hostPeerId>).
2. Run the bot as the joiner:
   ```bash
   node bot.mjs --connect <hostPeerId>
   ```
3. The web client is **host (White)**; the bot joins as **Black**. Make a move in
   the browser → the bot replies. Play a full game.

## Test with the bot as host
```bash
node bot.mjs --host gambitgus-test
```
Then open the web game with an invite link whose peer id is `gambitgus-test`
(i.e. `...?peer=gambitgus-test`). The bot is **White** and moves first.

## Flags
- `--connect <peerId>` — join an existing host (bot plays the non-host color).
- `--host <peerId>` — host under a fixed peer id (bot plays White, moves first).
- `--think <ms>` — "thinking" delay before the bot moves (default 1200).

## What success looks like
The bot logs `✓ data connection OPEN`, the `game_start` handshake, and alternating
moves (`opponent played …` / `bot played …`) with no `ILLEGAL move` / desync, and
the browser shows the bot's moves appearing like a real opponent's.

## If it doesn't connect
- **Custom PeerServer:** this spike uses PeerJS's default cloud (`0.peerjs.com`).
  If the web app is configured with a custom PeerServer host, the bot must use the
  same — tell me and I'll add the `host`/`port`/`path` options to `new Peer(...)`.
- **wrtc install issues:** `@roamhq/wrtc` is the maintained fork with prebuilt
  binaries; if install fails, paste the error.
- Paste the bot's console output (it runs `peerjs` with `debug: 2`) and I'll
  diagnose.

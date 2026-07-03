# Solving Matchmaking Cold Start with an AI Bot on AccelByte AGS

**Architecture & design reference — Ethan's Chess "Gambit Gus" bot**

This document describes, end to end, how a self-learning AI bot solves the
matchmaking cold-start problem on AccelByte Gaming Services (AGS): an Extend
service watches the match pool, and when a real player has waited too long, it
claims a dedicated server from AMS that logs in as a *real player account*,
queues a *real matchmaking ticket*, gets paired by AGS matchmaking itself, and
plays the human over the game's own P2P transport — indistinguishable from a
human opponent, with **zero changes to the game client**.

It is written for completeness: another game team should be able to build the
same system from this document, reusing the architecture, the operational
knowledge, and much of the code verbatim.

> Code referenced throughout (github.com/junaili/chess, branch `main`):
> - Extend service (Go): [`custom-extend-app/ethan-chess-service/`](https://github.com/junaili/chess/tree/main/custom-extend-app/ethan-chess-service)
> - Bot dedicated server (Node.js): [`peerjs-bot-spike/`](https://github.com/junaili/chess/tree/main/peerjs-bot-spike)
> - Game client fixes (JS): [`src/matchmaking.js`](https://github.com/junaili/chess/blob/main/src/matchmaking.js), [`src/stats.js`](https://github.com/junaili/chess/blob/main/src/stats.js)

---

## 1. The problem

Early-stage multiplayer games have few concurrent players. A player who taps
"Play Online" and finds nobody within ~30 seconds usually leaves — and often
doesn't come back. This is the **cold-start death spiral**: no players → no
matches → no players.

The fix is a bot opponent, but with three hard requirements:

1. **Humans first.** The bot must never take a match two humans could have had.
   It enters the queue *only after* a human has already waited a threshold
   (we use 20 seconds).
2. **Indistinguishable.** The bot must be a real AGS account, matched by the
   real matchmaking service, connecting over the same transport, with
   human-like play (variable think time, sane openings, believable strength).
3. **Zero client changes.** The game client must not know bots exist. Any
   client-side "bot fallback" code path is detectable and doubles maintenance.

## 2. Design principles

| Principle | Consequence |
|---|---|
| Bot is a real player | Real IAM account, password-grant login, real match ticket, real game session. AGS pairs it like anyone else. |
| Server-authoritative gate | Only a backend (Extend) can see the match pool queue; the 20s gate lives there, not in any client. |
| Ephemeral bot instances | One AMS dedicated server = one game, then it exits ("drain") and the fleet replaces it. No long-lived state to corrupt; crash recovery is "the next server". |
| Everything self-heals | Every step has a timeout and a retry at a *different layer* (see §9). A wedged component drains itself; the watcher re-triggers. |
| Learn from real games only | The bot records its own games and trains nightly on them — openings, difficulty calibration, pacing. |

## 3. System overview

```
                        ┌────────────────────────────────────────────┐
                        │  AGS (AccelByte Gaming Services)           │
                        │  IAM · Matchmaking v2 · Session · CloudSave│
                        └────┬───────────────▲───────────────▲───────┘
                             │ poll pool     │ login/ticket/ │ game records,
                             │ tickets       │ session       │ brain (admin
                             │ (admin API)   │ (player API)  │ records)
┌────────────┐  20s wait  ┌──┴───────────────┴──┐            │
│ Game client│──ticket──▶ │ EXTEND SERVICE      │◀───gRPC────┤ Task Scheduler
│ (unmodified│            │ ethan-chess-service │  daily     │ (portal cron)
│  web/iPad) │            │ · match-watcher     │  RunScheduledTask
└─────▲──────┘            │ · /bot/games intake │
      │                   │ · /bot/train runner │
      │  P2P game         │ · /bot/brain server │
      │  (PeerJS/WebRTC)  └──┬──────────▲───────┘
      │                claim │          │ POST /trigger · GET /bot/brain
      │                (AMS  │          │ POST /bot/games
      │                fleet)│          │
┌─────┴──────────────────────▼──────────┴───────┐
│ AMS FLEET (warm buffer of bot dedicated       │
│ servers; each = Node.js process, one game)    │
│ ds.mjs · watchdog.mjs · play.mjs · ags.mjs    │
└───────────────────────────────────────────────┘
```

**The cold-start flow in one paragraph:** the Extend service polls the match
pool every 3s with an admin token; when a human ticket is ≥20s old, it resolves
the bot fleet by claim key, claims one dedicated server from AMS, and POSTs
`/trigger` to that server's public TCP port. The server logs in as the bot
account, creates a match ticket, and AGS matchmaking pairs it with the waiting
human. Both sides learn the session members; the lexicographically-smallest
userId hosts. The bot connects over the game's own P2P protocol and plays. When
the game ends, the bot POSTs the full game record back to Extend (for nightly
training) and exits; AMS launches a fresh replacement into the buffer.

---

## 4. Component: the match watcher (Extend service)

File: [`pkg/handler/matchwatcher.go`](https://github.com/junaili/chess/blob/main/custom-extend-app/ethan-chess-service/pkg/handler/matchwatcher.go).
Started from [`cmd/main.go`](https://github.com/junaili/chess/blob/main/custom-extend-app/ethan-chess-service/cmd/main.go)
as a goroutine (`go w.Start(ctx)`) inside the existing Extend Service Extension
app — no new deployable.

### 4.1 Watching the pool

- Poll `GET /match2/v1/namespaces/{ns}/match-pools/{pool}/tickets` every
  `MATCH_WATCHER_POLL_SECONDS` (3s) using the service's client-credentials
  token. Requires `ADMIN:NAMESPACE:{ns}:MATCHMAKING:POOL:TICKETS [READ]`.
- **The live ticket shape is PascalCase and nested** — not what the public
  models suggest. The owner lives at `Ticket.Players[].PlayerID`:

  ```json
  {"data":[{"TicketID":"…","Ticket":{"CreatedAt":"…","MatchPool":"…",
    "Players":[{"PlayerID":"<userId>"}]}}]}
  ```

  Go's case-insensitive unmarshal handles the flat fields, but the nested
  `Ticket` needs its own struct. Parse defensively and **log the first raw
  response** — this one habit shortened every integration in this project.

### 4.2 The 20s gate

For each non-bot ticket older than `BOT_WAIT_SECONDS` (20):

- **Trigger once, then re-trigger after a cooldown** (`MATCH_WATCHER_RETRIGGER_SECONDS`,
  30s) while the ticket still waits. Re-triggers are harmless (see 5.4) and
  rescue humans whose first bot got lost.
- **Recognize the bot's own tickets** (`BOT_USER_ID` vs `Ticket.Players[].PlayerID`)
  or the watcher will feed on its own bots forever — this exact feedback loop
  happened; the belt-and-suspenders fix is §5.4's 10s ticket self-cancel.

### 4.3 Claiming a bot server from AMS

Fleet IDs **change on every image rollout**, so never configure a fleet ID.
The watcher resolves it at runtime:

1. `GET /ams/v1/admin/namespaces/{ns}/fleets` (list has no claim keys), then
   `GET …/fleets/{id}` per fleet (details do) — match an **active** fleet whose
   `claimKeys` contain `AMS_CLAIM_KEYS`. Cache 5 minutes; invalidate on any
   claim 404 (covers mid-rollout replacement).
   Requires `ADMIN:NAMESPACE:{ns}:ARMADA:FLEET [READ]`.
2. Claim **by fleet ID**: `PUT /ams/v1/namespaces/{ns}/fleets/{id}/claim` with
   camelCase body `{"region":"…","sessionId":"<unique>"}` (region required).
   Requires `NAMESPACE:{ns}:AMS:SERVER:CLAIM [UPDATE]`.
   Response: `{"serverId","ip","ports":{"default":20000,"trigger":20001},"region"}`.

   > Why not claim-by-keys (`PUT …/servers/claim`)? In our environment it
   > persistently returned "no matching DS available" even against a ready,
   > correctly-keyed server, while claim-by-ID always worked. The resolve-then-
   > claim-by-ID pattern gets key-stability *and* reliability.
3. Retry the claim every 2s for `AMS_CLAIM_RETRY_SECONDS` (20s) on 404 — the
   buffer may be refilling.
4. `POST http://{ip}:{ports[AMS_TRIGGER_PORT_NAME]}/trigger` with the shared
   secret header, **retrying 4×**: a claimed server that never receives its
   trigger has no other way to learn it was claimed and would idle forever.

### 4.4 Observability

`GET {basePath}/debug/watcher?key=<secret>` returns the watcher's config plus
rolling activity: last poll status, ticket counts (human vs bot), max human
wait, last trigger/claim/POST results and errors, resolved fleet. This endpoint
turned every production mystery in this project into a five-minute diagnosis.
Build it on day one.

---

## 5. Component: the bot dedicated server (AMS)

Files: [`ds.mjs`](https://github.com/junaili/chess/blob/main/peerjs-bot-spike/ds.mjs) (lifecycle),
[`watchdog.mjs`](https://github.com/junaili/chess/blob/main/peerjs-bot-spike/watchdog.mjs) (AMS protocol),
[`ags.mjs`](https://github.com/junaili/chess/blob/main/peerjs-bot-spike/ags.mjs) (AGS REST),
[`play.mjs`](https://github.com/junaili/chess/blob/main/peerjs-bot-spike/play.mjs) (transport + gameplay),
[`engine.mjs`](https://github.com/junaili/chess/blob/main/peerjs-bot-spike/engine.mjs) (loads
the game's own rules/AI code).

### 5.1 Packaging for AMS

AMS uploads are a **directory + executable** (`ams upload -p <dir> -e run.sh
-a linux-x86_64 --skip-script-validation`); AMS containerizes them on its own
base image (Ubuntu 22.04 / glibc 2.35 at time of writing — you don't control
it). For a Node.js server, ship a self-contained bundle
([`build-bundle.sh`](https://github.com/junaili/chess/blob/main/peerjs-bot-spike/build-bundle.sh)):

- the app + `node_modules` (extracted from a `--platform linux/amd64` Docker
  build, so native addons are the right binaries),
- a **`node` binary built for old glibc** — use Node's *unofficial
  `glibc-217` build*. The official binary needs glibc 2.28+ and the native
  WebRTC addon needs 2.34+; if the host is older, the process dies **before
  any logging**, which AMS reports as `StartError exit code -999` with zero
  output. The glibc-217 node makes startup host-independent; risky native
  addons are lazy-imported (§9) so their failure is a logged event, not a
  silent crash,
- `run.sh` that prints diagnostics (`uname`, `ldd --version`,
  `node --version`, `ldd` missing libs) before `exec`ing node — these lines
  appear in the AMS DS log and are your only eyes on the host,
- a `.env` baked into the bundle for bot credentials/config (dev build-configs
  have no env-var UI; the bundle is the trust boundary — never in git).

### 5.2 AMS lifecycle & the watchdog protocol

AMS runs a watchdog (WebSocket, `ws://localhost:5555/watchdog`) that the DS
must speak to (`watchdog.mjs`):

- **Connect with header `ams-dsid: <dsid>`** — the dsid arrives via the
  command line (`-dsid=${dsid}`).
- Send `{"ready":{"dsid":"<dsid>"}}` — the dsid **must repeat inside the ready
  payload** or the watchdog rejects it ("unexpected DSID") and the server dies
  at `CreationTimeout`. Heartbeat is `{"heartbeat":{}}` every ≤15s. Inbound
  `{"drain":…}` means finish up and exit.
- The exact message schema is `DStoWatchdogMessage` protojson; the **AMS
  Simulator (`amssim`)** speaks the identical protocol and its session log
  prints precise decode errors — iterate locally against it instead of
  shipping cloud guesses.
- **Order matters:** bind the trigger HTTP port *before* sending `ready` —
  the claim + trigger can arrive within milliseconds of readiness.

### 5.3 Ports

Every fleet has an immutable auto-created port named `default` (UDP). Your
HTTP trigger needs a **named TCP port** (we call it `trigger`). Port numbers
are assigned dynamically per server and injected via command-line placeholders
— fleet command line:

```
-dsid=${dsid} -port=${default_port} -trigger_port=${trigger_port}
```

(`${<portname>_port}` is the pattern.) Bind exactly what you're given.

### 5.4 One game, then gone

`ds.mjs` lifecycle on `/trigger` (secret-checked):

1. Fetch the learned play-tuning from Extend (`GET /bot/brain`, §7.3) —
   parallel with login, non-fatal.
2. Log in as the bot account (IAM password grant — a public game-client ID).
3. Create **one** match ticket. Poll it every 500ms. **Self-cancel after 10s**
   if unmatched — a genuinely-waiting human matches in one or two polls, so an
   unmatched ticket means a spurious trigger, and cancelling it keeps bot
   tickets from ever aging past the watcher's 20s gate (kills the feedback
   loop at the source).
4. On match, read the session members. **Host = lexicographically smallest
   userId** (the game client's own convention — mirror yours).
5. Register the P2P identity **after** the match, by role:
   - **Joiner → random peer id.** Nobody dials the bot, so the account-derived
     id is unnecessary — and this is what lets multiple bot instances share
     one account concurrently (a fixed id collides: second registration gets
     `unavailable-id`).
   - **Host → the account-derived id**, registered fast: the human client
     dials it *once*, ~2.2s after it learns of the match (hence the 500ms
     ticket poll — the bot must learn first). A rare double-host collision
     just drains.
6. Play (§6). On completion: POST the game record to Extend (§7.1), then
   `process.exit(0)`. AMS marks the session finished and launches a fresh
   buffer server.
7. Safety nets: 60-min idle self-recycle (claimed-but-never-triggered), 60s
   host-connect timeout, 45s no-game-start timeout, 5-min in-game idle
   timeout. An ephemeral DS must **never** be able to wedge (a wedged server
   poisons the fleet buffer).

### 5.5 Fleet configuration

- Regular (non-development) fleet; **claim key** = the stable name the watcher
  resolves (e.g. `ethan-chess-bot`). Don't let a *development server
  configuration* share that name — claim-by-key matching gets confused.
- **`bufferSize ≥ 1`** — the buffer is what's claimable; `minServerCount`
  alone is NOT claimable. `maxServerCount ≥ 2` so the buffer refills while a
  game runs.
- Packing: on a 2 vCPU / 1.6 GiB instance one Node bot uses ~68 MB idle /
  ~155 MB in-game → `serversPerVm: 4` is comfortable (4–6 max). The code needs
  nothing special: every per-server value (dsid, ports) arrives via argv.
- One bot **account** allows concurrent logins and unlimited sessions, but
  only one *active matchmaking ticket* (error 520324) — concurrent triggers
  serialize over the ~10s queue window; the watcher's 30s retrigger absorbs
  it. For true parallel activations and persona variety, use a bot-account
  pool (pick per claim, e.g. by dsid hash).

---

## 6. Component: playing the game (transport + protocol)

File: [`play.mjs`](https://github.com/junaili/chess/blob/main/peerjs-bot-spike/play.mjs).
This is the game-specific layer — the part you replace for
your own game. For Ethan's Chess the client uses **PeerJS** (WebRTC data
channels via the public PeerJS cloud broker), so the bot is a Node PeerJS peer:

- Polyfill the browser surface for the PeerJS lib: `RTCPeerConnection` etc.
  from `@roamhq/wrtc`, `WebSocket` from `ws`, a stub `navigator`.
- **Reuse the game's own rules/AI code verbatim** (`engine.mjs` loads the
  client's `chess-engine.js`/`ai-engine.js` into Node with
  `vm.runInThisContext`). Guaranteed move-legality agreement with the client;
  zero reimplementation.
- Speak the client's exact message protocol (learned by reading the client):
  `game_start` (host→joiner: color assignment), `player_info` (identity),
  `move`, `ping`/`pong` heartbeat.
- **Joiner connect retry**: the human host's peer registration can land
  *after* the bot's first dial → `peer-unavailable`. The client dials once
  and gives up; the bot retries 8× at 2s intervals.
- Human-ness: per-move think time sampled from the learned mean±jitter;
  difficulty from the learned calibration; opening book moves while the game
  matches a known-good line (§7.3).
- Record every move (both sides), opponent identity, timestamps, and result —
  the training corpus (§7.1).

**Porting note:** if your game uses AGS Session + a server-authoritative or
relay transport instead of P2P, this layer shrinks: the DS *is* the server the
client connects to. The cold-start machinery (§4, §5) is unchanged.

---

## 7. Component: the self-learning loop

All endpoints live in the same Extend app, authenticated by one shared secret
(`x-trigger-secret` header or `?key=`). Storage is CloudSave **admin game
records** (server-owned, namespace-level) — requires
`ADMIN:NAMESPACE:{ns}:CLOUDSAVE:RECORD [CREATE,READ,UPDATE]`.

### 7.1 Game capture

`POST {basePath}/bot/games` ([`pkg/handler/botgames.go`](https://github.com/junaili/chess/blob/main/custom-extend-app/ethan-chess-service/pkg/handler/botgames.go)): the DS posts each
finished game (same `MatchEntry` shape the game client itself records — id,
opponent, result from the bot's perspective, timestamps, full coordinate move
list). Appended to record `chess-bot-{botId}-history` with per-id dedup and a
500-game cap.

### 7.2 Daily training — via the Extend Task Scheduler

The **Extend Task Scheduler** (Admin Portal → the app → Task Scheduler tab)
invokes the app **over gRPC** on the schedule you configure (name + cron +
date range; no URL — routing is implicit):

- Proto: `accelbyte.extend.task_scheduler.v1.ScheduledTaskHandler /
  RunScheduledTask(ScheduledTaskRequest) → ScheduledTaskResponse` — fetch
  `task_scheduler.proto` verbatim from `AccelByte/accelbyte-api-proto`, put it
  at `pkg/proto/generic/task_scheduler/v1`, `make proto`.
- The platform sidecar calls your app's own gRPC server (localhost in-pod) —
  if you gate gRPC with an auth interceptor, **exempt this method**.
- Run the training synchronously on a context *detached* from the caller's
  (a sidecar timeout must not abort an LLM call mid-flight); respond
  `success`/`409`/`500` and honor `run_id`/`attempt_number` idempotency.
- Keep an HTTP twin (`POST /bot/train`) as the manual/debug trigger, and
  `GET /debug/trainer` for status.

The scheduler handler is [`pkg/handler/taskscheduler.go`](https://github.com/junaili/chess/blob/main/custom-extend-app/ethan-chess-service/pkg/handler/taskscheduler.go);
the run ([`pkg/handler/trainjob.go`](https://github.com/junaili/chess/blob/main/custom-extend-app/ethan-chess-service/pkg/handler/trainjob.go)
→ [`pkg/trainer`](https://github.com/junaili/chess/tree/main/custom-extend-app/ethan-chess-service/pkg/trainer)):

1. Load the brain from admin record `chess-bot-{botId}-brain` (first run seeds
   from a `brain.json` baked into the image — remember to `COPY` it into the
   **final** Docker stage).
2. Fetch the last 24h of games; drop already-processed ids (idempotent).
3. Replay each game (coordinate moves → SAN/PGN/outcome,
   [`pkg/chessreplay`](https://github.com/junaili/chess/tree/main/custom-extend-app/ethan-chess-service/pkg/chessreplay)).
4. **LLM reflection** ([`pkg/llm`](https://github.com/junaili/chess/tree/main/custom-extend-app/ethan-chess-service/pkg/llm): provider-agnostic — Anthropic, OpenAI, or
   any OpenAI-compatible local model via `LLM_BASE_URL`): persona + games in,
   JSON lessons/journal out. On any LLM failure, **continue** — deterministic
   learning must never depend on the LLM.
5. Deterministic **play tuning** ([`pkg/trainer/tuning.go`](https://github.com/junaili/chess/blob/main/custom-extend-app/ethan-chess-service/pkg/trainer/tuning.go)):
   - *Opening book*: first 8 plies of games that scored, weighted, top 12
     lines, stored as coordinate moves (so the bot prefix-matches without SAN).
   - *Difficulty calibration*: nudge one step per day along
     easy→medium→hard toward a ~50% trailing win rate (needs ≥5 games).
   - *Think time*: mean±jitter from observed pace, clamped 700–2600ms.
6. Save brain + a journal entry back to CloudSave; expose the summary via
   `/debug/trainer`.

### 7.3 Feedback into play

`GET {basePath}/bot/brain` serves the play-relevant subset (version,
difficulty, think-time, book) with a 60s cache. The DS fetches it at trigger
time and plays accordingly. Net effect: every real game makes tomorrow's bot
slightly more human and better-calibrated.

### 7.4 Client-side hygiene (the one client change that *is* justified)

Abandoned matchmaking tickets ("zombies") poison the loop: a player refreshes
mid-queue, the ticket lives to its TTL (~2 min), the bot matches it, and
connects to a browser that no longer exists. Two fixes:

- The client cancels its ticket on `pagehide`/`beforeunload` via a
  `keepalive` DELETE ([`src/matchmaking.js`](https://github.com/junaili/chess/blob/main/src/matchmaking.js)
  — SDK calls don't survive unload).
- Pool ticket TTL ≤ 60s (but > gate + claim + queue ≈ 35s).

This is a bug fix that helps human-vs-human matchmaking too, not bot logic in
the client.

---

## 8. End-to-end sequence

```
Human                Client            AGS MM           Extend watcher      AMS            Bot DS
 │ Play Random         │                  │                  │               │               │
 │────────────────────▶│──create ticket──▶│                  │               │               │
 │        (waiting…)   │                  │◀──poll (3s)──────│               │               │
 │                     │                  │   ticket 20s old │               │               │
 │                     │                  │                  │─resolve fleet▶│               │
 │                     │                  │                  │─claim by ID──▶│               │
 │                     │                  │                  │◀─ip:port──────│               │
 │                     │                  │                  │─POST /trigger (secret)───────▶│
 │                     │                  │                  │               │   login (IAM) │
 │                     │                  │◀─────────────────┼───────────────┼──create ticket│
 │                     │                  │──match found: session {human, bot}──────────────▶│
 │                     │◀─match found─────│                  │               │               │
 │                     │  host = min(userId) ──── P2P connect (retry) ──────────────────────▶│
 │                     │◀─────────── game_start / moves / ping-pong ────────────────────────▶│
 │  plays Gus 🎉       │                  │                  │               │               │
 │                     │                  │                  │  POST /bot/games (record)◀────│
 │                     │                  │                  │               │◀─exit(0)──────│
 │                     │                  │                  │               │ buffer refills│
              …nightly: Task Scheduler ──gRPC──▶ Extend: train on 24h of games ──▶ brain vN+1
```

Timeline for the human: ~20s gate + ~2s claim + ~2s trigger/login/queue +
~2s match + ~3s connect ≈ **30 seconds** from queueing to playing a "person".

## 9. Failure modes & mitigations (all field-tested)

| Failure | Symptom | Mitigation |
|---|---|---|
| Watcher triggers on bot's own tickets | Endless trigger loop | Owner check on `Ticket.Players[].PlayerID` **and** bot ticket self-cancels at 10s |
| Human's first bot lost | Human waits forever | Watcher re-triggers every 30s while the ticket waits |
| Fleet ID churn on rollout | Claims 404 after every release | Resolve fleet by claim key at runtime; invalidate cache on 404 |
| Buffer empty (refilling) | Claim 404 | Claim retry 2s×20s; retrigger later |
| Trigger POST lost | Server claimed forever, buffer starved | POST retried 4×; DS idle self-recycle (60 min); AMS relaunch on exit |
| Node/addon vs host glibc | `StartError -999`, no logs | glibc-217 node; lazy-import native addons; `run.sh` prints ldd diagnostics |
| Watchdog protocol mismatch | `CreationTimeout` despite healthy process | `ams-dsid` header + dsid in ready payload; iterate against `amssim` locally |
| Wrong port protocol | Trigger unreachable | Named TCP port + `${<name>_port}` placeholder; bind what argv gives you |
| Host peer registers late | `peer-unavailable` on first dial | Joiner retries 8×2s |
| Opponent never sends game start | Bot wedged in a "game" | 45s no-game-start + 5-min idle timeouts → drain |
| Zombie human tickets | Bot matched to a dead browser | Client unload-cancel; short pool TTL; bot timeouts + retrigger recover |
| Same-account concurrency | 2nd peer id `unavailable-id`; 2nd ticket 520324 | Role-based peer ids (random as joiner); serialized queue window; account pool for scale |
| LLM outage/quota | Training run fails | Reflection optional: deterministic learning always completes |
| Scheduler double-fire / manual overlap | Duplicate training | In-process run guard (409) + per-game processed-id idempotency |

## 10. Configuration reference

### Extend service (vars; secrets marked ✱)

```
MATCH_WATCHER_ENABLED=true        MATCH_POOL=chess-quickmatch
BOT_WAIT_SECONDS=20               MATCH_WATCHER_POLL_SECONDS=3
MATCH_WATCHER_RETRIGGER_SECONDS=30
BOT_USER_ID=<bot account userId>  BOT_ID=gambit-gus
AMS_CLAIM_ENABLED=true            AMS_CLAIM_KEYS=ethan-chess-bot
AMS_REGION=us-east-2              AMS_TRIGGER_PORT_NAME=trigger
AMS_BASE_URL=<game-namespace host>          # NOT the publisher host
BOT_TRIGGER_SECRET=✱<shared secret>
LLM_PROVIDER=openai|anthropic     LLM_MODEL=<model>
OPENAI_API_KEY / ANTHROPIC_API_KEY=✱        # optional; LLM_BASE_URL for local
BOT_TRIGGER_URL=http://…/trigger            # legacy/local-dev direct mode
```

### Bot DS bundle (`.env.ams`, baked; never in git)

```
AB_BASE_URL=<game-namespace host>  AB_CLIENT_ID=<public game client>
AB_NAMESPACE=<ns>                  MATCH_POOL=chess-quickmatch
BOT_EMAIL=✱  BOT_PASSWORD=✱        BOT_TRIGGER_SECRET=✱ (same as Extend)
EXTEND_BASE_URL=<Extend public URL incl. base path>
BOT_IDLE_MAX_MINUTES=60
```

### IAM permissions (on the Extend service's confidential client)

| Permission | Action | For |
|---|---|---|
| `ADMIN:NAMESPACE:{ns}:MATCHMAKING:POOL:TICKETS` | READ | pool polling |
| `ADMIN:NAMESPACE:{ns}:ARMADA:FLEET` | READ | fleet resolution |
| `NAMESPACE:{ns}:AMS:SERVER:CLAIM` | UPDATE | claiming servers |
| `ADMIN:NAMESPACE:{ns}:CLOUDSAVE:RECORD` | CREATE+READ+UPDATE | game history, brain, journal |

(Exact strings verified by reading `requiredPermission` from live 403 bodies —
do the same in your environment.)

### Portal setup checklist

1. Create the bot's player account (a normal user).
2. Upload the DS bundle (`ams upload … -e run.sh -a linux-x86_64`).
3. Create the fleet: image, claim key, region, named TCP `trigger` port,
   command line `-dsid=${dsid} -port=${default_port} -trigger_port=${trigger_port}`,
   buffer ≥1, max ≥2, serversPerVm per §5.5. **Repoint the image after every
   upload** (uploads don't switch fleets).
4. Grant the IAM permissions above; set Extend vars/secrets; deploy.
5. Task Scheduler tab → create the daily training task (cron).
6. Matchmaking pool: ticket TTL ~60s.

## 11. Porting guide — what to reuse vs. replace

**Reusable nearly verbatim (game-agnostic):**
- `matchwatcher.go` — pool gate, fleet resolution, claim, trigger (rename the
  pool/env).
- `watchdog.mjs`, `ds.mjs` lifecycle — AMS protocol, trigger server, role
  logic, all timeouts/self-recycle (swap the game-start call).
- `build-bundle.sh` — glibc-safe Node packaging for AMS.
- `botgames.go`, `trainjob.go`, `taskscheduler.go`, `pkg/llm` — capture,
  daily training frame, Task Scheduler contract, provider-agnostic LLM.
- The `/debug/watcher`, `/debug/trainer` observability pattern.

**Replace per game:**
- `play.mjs` — your client's transport (PeerJS here; could be AGS Session +
  UDP, a relay, or websockets) and message protocol.
- `engine.mjs` — load *your* game's rules/AI (reusing the client's own code
  is strongly recommended).
- `pkg/chessreplay` + `tuning.go` internals — what "replay" and "learn" mean
  for your game (win-rate calibration and pacing transfer as-is).

**Design invariants to keep:** humans-first gate in the backend; bot as real
player through real matchmaking; one ephemeral server per game; timeouts at
every layer; deterministic learning independent of the LLM; secrets in exactly
two places (Extend secrets, DS bundle).

## 12. Known limitations / future work

- **Single account = one game at a time in the worst case** (host-role id +
  one active ticket). Account pool solves both and enables multiple personas.
- Endgame play quality (long shuffling draws) — engine-side polish; the
  max-shuffle-plies tuning field is plumbed but not yet acted on.
- No resign: the client protocol has no bot-usable resign message; adding one
  would touch the client.
- Claim-by-keys unreliability is worked around, not explained — revisit with
  the AMS team.
- Extend Task Scheduler docs: https://docs.accelbyte.io/gaming-services/modules/foundations/extend/data-and-messaging/extend-task-scheduler/

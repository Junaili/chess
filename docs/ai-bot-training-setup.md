# AI Bot Training — Setup & Testing Guide

How to set up, run, and verify **Gambit Gus's daily self-learning loop**: the
bot records every game it plays, an AGS **Extend Task Scheduler** task trains it
daily (deterministic learning + optional LLM reflection), and the learned
"brain" steers the bot's play (opening book, think time, difficulty).

For the full architecture see
[`ai-bot-cold-start-architecture.md`](./ai-bot-cold-start-architecture.md) (§7).
Code: [`pkg/handler/trainjob.go`](https://github.com/junaili/chess/blob/main/custom-extend-app/ethan-chess-service/pkg/handler/trainjob.go),
[`pkg/trainer`](https://github.com/junaili/chess/tree/main/custom-extend-app/ethan-chess-service/pkg/trainer),
[`cmd/train-bot`](https://github.com/junaili/chess/tree/main/custom-extend-app/ethan-chess-service/cmd/train-bot).

## How the loop works (30-second version)

```
bot DS plays a game ──POST /bot/games──▶ CloudSave admin record (history)
Task Scheduler (daily cron) ──gRPC RunScheduledTask──▶ training run:
    load brain → fetch 24h games → replay → LLM reflect (optional)
    → apply lessons → compute play tuning → save brain + journal
bot DS at next trigger ──GET /bot/brain──▶ plays with the learned tuning
```

Everything lives in the `ethan-chess-service` Extend app. Storage is CloudSave
**admin game records**: `chess-bot-gambit-gus-history` (games),
`…-brain` (the brain), `…-journal` (training journal).

All bot HTTP endpoints authenticate with one shared secret, sent as the
`x-trigger-secret` header or `?key=` query — the value of the app's
`BOT_TRIGGER_SECRET` secret (referred to as `$SECRET` below).

---

## 1. One-time setup

### 1.1 IAM permission (service client)

The Extend app's runtime client (its `AB_CLIENT_ID`) needs:

```
ADMIN:NAMESPACE:{namespace}:CLOUDSAVE:RECORD   [CREATE, READ, UPDATE]
```

Without it, `/bot/games` returns 502 and training fails with
`admin record … returned 403`.

### 1.2 Extend app configuration

```bash
# vars
extend-helper-cli update-var --force -n <ns> -a ethan-chess-service --key BOT_ID       --value gambit-gus
extend-helper-cli update-var --force -n <ns> -a ethan-chess-service --key LLM_PROVIDER --value openai      # or anthropic
extend-helper-cli update-var --force -n <ns> -a ethan-chess-service --key LLM_MODEL    --value <model>

# secrets
extend-helper-cli update-secret --force -n <ns> -a ethan-chess-service --key BOT_TRIGGER_SECRET --value <shared secret>
extend-helper-cli update-secret --force -n <ns> -a ethan-chess-service --key OPENAI_API_KEY     --value <api key>
# (ANTHROPIC_API_KEY for provider=anthropic; LLM_BASE_URL for OpenAI-compatible local models)
```

Env changes apply on the **next deployment** — redeploy the current tag after
changing them. The LLM is optional: without a key, training still runs the
deterministic parts (opening book, difficulty calibration, think-time) and logs
`"llm": "not configured"`.

### 1.3 The daily schedule (Extend Task Scheduler)

Admin Portal → Extend → `ethan-chess-service` → **Task Scheduler** tab →
Create Task:

- **Name**: `gus-daily-training`
- **Schedule** (cron): `0 9 * * *` (daily 09:00 UTC)
- **Date range**: start today, no end

No URL/target is configured — the platform sidecar invokes the app's gRPC
handler (`ScheduledTaskHandler/RunScheduledTask`) directly. The app must be
deployed and running for the task to fire.

### 1.4 Bot DS bundle

The AMS bot bundle's `.env.ams` must contain (see `.env.ams.example`):

```
EXTEND_BASE_URL=<Extend public URL incl. base path>
BOT_TRIGGER_SECRET=<same shared secret>
```

`EXTEND_BASE_URL` is where the DS reports finished games (`POST /bot/games`)
and fetches tuning (`GET /bot/brain`). Rebuild + upload the bundle
(`peerjs-bot-spike/build-bundle.sh`, then `ams upload …`) and point the fleet
at the new image.

---

## 2. Testing the pipeline (no real game needed)

Set once:

```bash
B=https://<env-host>/<extend-base-path>   # e.g. …accelbyte.io/ext-<ns>-ethan-chess-service
SECRET=<BOT_TRIGGER_SECRET value>
```

### 2.1 Feed a synthetic game

```bash
curl -s -XPOST -H "x-trigger-secret: $SECRET" -H "Content-Type: application/json" \
  "$B/bot/games" -d '{
  "id":"synthetic-test-1","mode":"online","opponentUserId":"testopp1",
  "opponentName":"Test Opponent","result":"win",
  "startedAt":"'"$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"'",
  "endedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","durationMs":300000,
  "whiteName":"Gambit Gus","blackName":"Test Opponent",
  "moves":[{"fr":6,"fc":4,"toR":4,"toC":4,"promType":"queen"},
           {"fr":1,"fc":4,"toR":3,"toC":4,"promType":"queen"},
           {"fr":7,"fc":5,"toR":4,"toC":2,"promType":"queen"},
           {"fr":0,"fc":1,"toR":2,"toC":2,"promType":"queen"},
           {"fr":7,"fc":3,"toR":3,"toC":7,"promType":"queen"},
           {"fr":0,"fc":6,"toR":2,"toC":5,"promType":"queen"},
           {"fr":3,"fc":7,"toR":1,"toC":5,"promType":"queen"}]}'
# → {"ok":true}          (re-POSTing the same id → {"ok":true,"duplicate":true})
```

Moves are board coordinates (`fr/fc` = from row/col, 0–7, row 0 = black's back
rank) — the same shape the web client records. The example is a scholar's-mate
win for white.

### 2.2 Run a training pass now

```bash
curl -XPOST "$B/bot/train?key=$SECRET"     # → 202 {"ok":true,"started":true}
sleep 10
curl "$B/debug/trainer?key=$SECRET"
```

Expected `lastRun` on success:

```json
{ "result":"trained", "brainVersion":N, "newGames":1, "gamesLearned":1,
  "openingsTouched":1, "lessonsAdded":…, "llm":"openai/<model>",
  "difficulty":"medium", "winRate":…, "bookLines":… }
```

- `"llm":"not configured"` → no API key set; deterministic learning still ran.
- `"llmError": …429…` → provider quota/billing; run still completes.
- Re-running immediately → `"result":"no_new_games"` (per-game idempotency).
- A second concurrent run → HTTP 409 (guard).

### 2.3 Inspect what the bot will play with

```bash
curl "$B/bot/brain?key=$SECRET"
# → {"version":N,"difficulty":"…","thinkMsMean":…,"thinkMsJitter":…,
#    "maxShufflePlies":…,"book":[{"moves":[…],"weight":…}]}
```

(60s cache — a just-finished training run can take up to a minute to appear.)

### 2.4 Verify the feedback loop in a live game

Trigger a bot game (Play Random solo and wait ~20s, or claim + POST `/trigger`
on a fleet server directly). In the AMS DS log look for:

```
brain vN applied (difficulty=…, thinkMs=…±…, book=… lines)
bot played (book) e4
game record reported ( win 34 moves )
```

That's the full circle: tuning applied → book move played → game fed back for
tomorrow's training.

### 2.5 Verify the scheduler fires

Set the task's cron to the next few minutes (portal), wait, then check
`GET $B/debug/trainer?key=$SECRET` — `lastRun.startedAt` updates and the app
log shows `task-scheduler: run=… task="gus-daily-training"`. Restore the real
cron afterwards.

---

## 3. Local training runs (CLI)

The same pipeline runs from a workstation against the same CloudSave data:

```bash
cd custom-extend-app/ethan-chess-service
# .env        → AGS creds (AB_BASE_URL/AB_CLIENT_ID/AB_CLIENT_SECRET/AB_NAMESPACE)
# .env.local  → LLM config (LLM_PROVIDER, LLM_MODEL, API key; never committed)
go run ./cmd/train-bot --bot-dir bots/gambit-gus            # train on last 24h
go run ./cmd/train-bot --bot-dir bots/gambit-gus --dry-run  # reflect only
go run ./cmd/train-bot --bot-dir bots/gambit-gus --print-prompt --since-hours 72
```

Note: the CLI writes `brain.json`/journal to **disk** (`bots/gambit-gus/`),
while the Extend job persists to CloudSave — use the CLI for prompt iteration
and dry runs, the Extend job as the source of truth.

## 4. What training actually changes

| Knob | How it's learned | Effect on play |
|---|---|---|
| Opening book | First 8 plies of games that scored (win=1, draw=0.5), top 12 lines | Bot plays book continuations while the game matches a line |
| Difficulty | Nudged one step/day along easy→medium→hard toward ~50% trailing win rate (needs ≥5 games) | `ai.getBestMove(game, difficulty)` |
| Think time | Mean ± jitter from observed pace, clamped 700–2600ms | Human-feeling per-move delay |
| Lessons / journal | LLM reflection over replayed games (persona-voiced) | Stored in the brain; surfaced in the journal record |

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/bot/games` → 502 "storage error" | Service client lacks `ADMIN:…:CLOUDSAVE:RECORD` (grant CREATE+READ+UPDATE), or grant went to the wrong client |
| `lastRun.error: "load bot dir: read persona.md"` | `bots/` missing from the runtime image — Dockerfile's **final** stage must `COPY bots bots` |
| `llmError: 429` | LLM provider quota/billing (API billing is separate from chat subscriptions) |
| `lastRun` never changes at cron time | App not running, task date-range lapsed, or the gRPC interceptor doesn't exempt `ScheduledTaskHandler` |
| `result: no_new_games` daily | The bot isn't reporting games: check `EXTEND_BASE_URL` + secret in the DS bundle, and the DS log for `game record reported` |
| Brain changes don't affect play | Fleet still on an old bundle image; or check the DS log for `brain fetch failed` |

# Chess stats: current inventory + proposal

## Part 1 — What's tracked in AGS today

### AGS Statistics (`UserStatisticApi`, `src/stats.js`)

| Stat code | Trigger | Update |
|---|---|---|
| `chess-wins` | Player wins a game | `+1`, carries `additionalData.displayName` (feeds the leaderboard) |
| `chess-losses` | Player loses | `+1` |
| `chess-draws` | Game ends in a draw | `+1` |
| `chess-games-played` | Any game ends | `+1` |
| `chess-online-games` | Any online (non-bot, non-local) game ends | `+1` |
| `chess-current-streak` | Daily play detected | `OVERRIDE`, UTC-day based |
| `chess-longest-streak` | New personal best streak | `MAX` |
| `chess-last-play-day` | Every streak check | `OVERRIDE`, UTC day index |

All initialized at login (`initStats`), all client-authoritative — no server-side validation of increments.

### AGS Leaderboard (`LeaderboardDataV3Api`, `src/leaderboard.js`)

- `chess-wins-lb` — ranks players by raw `chess-wins`. Display names sourced from the stat's own `additionalData`, backfilled via IAM lookup for players never interacted with.

### AGS Achievements (`AchievementsApi` / `UserAchievementsApi`, `src/achievements.js`)

- **Stat-backed** (configured in the AGS Admin Portal against a stat + goal value, auto-unlock — no codes hardcoded client-side, so this list isn't fully enumerable from the repo).
- **Event-triggered** (explicit unlock calls): `chess-first-friend`, `chess-social-5`, `chess-recruiter` (server-side, via the Extend referral endpoint).

### AGS CloudSave (`PublicPlayerRecordApi`, `src/stats.js` + `src/spectator.js`)

- `chess-match-history` — **the richest untapped source**: last 50 matches per player, each with `mode`, `result` (`win`/`loss`/`draw` only), `opponentUserId`/`opponentName`, `startedAt`/`endedAt`, `durationMs`, and the **full move list** (`{fr, fc, toR, toC, promType}` per ply), `whiteName`/`blackName`.
- `chess-live` — ephemeral, current-game board state for spectating (not a stat).
- `chess-streak` — deprecated, migrated into the Statistics stats above.

### Key gap found while investigating

`chess-engine.js` already computes a detailed end-of-game status (`checkmate`, `stalemate`, `draw-insufficient`, `draw-fifty-move`, `draw-repetition`) — but `recordMatchHistoryOnce()` in `app.js` collapses all of it down to just `win`/`loss`/`draw` before saving. That detail is sitting right there in memory and currently gets thrown away. (Resignation also isn't distinguished — `resignGame()` currently reuses the `checkmate` status.)

---

## Part 2 — Proposed new stats

Grouped by what it costs to add, since the match-history record already holds full move lists — several of the most interesting chess stats are pure computation, not new tracking.

### Tier 1 — Free: derivable from data already stored (`chess-match-history`)

No new AGS writes needed; compute client-side from the existing move lists + existing fields.

- **Win rate as White vs. Black** — chess is asymmetric (White's first-move edge is real, even at casual level); `whiteName`/`blackName` are already recorded per match.
- **Win rate vs. bot vs. vs. humans** — separates "beating Gambit Gus" from "beating Grandma," which mean very different things; `mode`/`opponentUserId` already distinguish this.
- **Head-to-head record per friend** — "3–1 vs. Dad" is exactly the kind of stat that fits this app's stated purpose (playing with family across the world). Pure aggregation over `opponentUserId` + `result`.
- **Favorite opening / opening win rate** — first 2-3 plies of `moves[]` already captured; group and count. Ties in nicely with the bot's own opening-book training work already planned.
- **Total time played, average game length, longest/shortest game** — `durationMs` is already stored per match; just sum/aggregate.
- **Fastest checkmate / most moves in a game** — from move-count already in each record.

### Tier 2 — Cheap: needs one field added to the existing match-history write, not a new system

- **Checkmate rate / stalemate rate / draw-reason breakdown** — just persist `game.status` (already computed, currently discarded) alongside `result` in `recordMatchHistoryOnce()`.
- **Resignation rate** — requires `resignGame()` to set its own distinguishable status instead of reusing `'checkmate'` (small engine fix, then falls out of the same field).
- **Castling rate (kingside / queenside / never)** — one boolean check against the existing move list when a king moves two squares; cheap to compute at write time or read time.

### Tier 3 — New instrumentation, moderate effort

- **Skill rating (Elo-style), not just raw win count** — the single highest-value addition. Ten wins against weaker opponents means something very different from ten wins against strong ones; a rating captures that, raw win/loss counts can't. Store as a new stat (e.g. `chess-rating`, seeded at 1200), updated via a standard Elo formula after each online match. This would also make the leaderboard far more meaningful than sorting by raw win count.
- **Capture stats** (total pieces captured, most valuable piece captured, captures per game) — moves currently store `{fr, fc, toR, toC, promType}` with no capture flag. Needs either a capture flag added at record time, or a replay pass — and the bot side already has a `pkg/chessreplay` package in the Extend service that reconstructs games from stored moves, which could be reused/ported instead of building this twice.
- **"Nemesis" / toughest opponent** — the friend you have your worst record against; needs the head-to-head aggregation (Tier 1) plus a bit of ranking logic.
- **Comeback wins** (won after being materially behind) — needs a position-evaluation pass, i.e. reusing the AI engine's own evaluation function against the stored move list.

### Why this grouping matters

The Tier 1 stats are the best place to start — real chess-specific insight (color bias, opponent-specific rivalry, opening habits, time invested) for close to zero engineering cost, since the data to compute them is already sitting in `chess-match-history`. Elo rating (Tier 3) is the one item worth prioritizing despite being more work, since it's the single change that would make "how good am I" and the leaderboard itself meaningfully more accurate than a raw win counter.

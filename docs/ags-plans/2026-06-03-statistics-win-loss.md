# AGS Plan — Statistics: Win/Loss

**Date:** 2026-06-03
**Approved feature:** Record win and loss counts as AGS stats; display them on the home screen for logged-in players.

---

## Confirmed Context

- **Project:** Vanilla HTML/JS chess game, `/Users/junaililie/personal-project/chess-ethan`
- **SDK:** `@accelbyte/sdk@4.3.1`, `@accelbyte/sdk-iam@6.3.4`, `@accelbyte/sdk-social@6.3.4` *(to install)*
- **AGS namespace:** `seal-chessags`
- **Auth:** Google login via AGS IAM PKCE (in progress)
- **Stat codes:** `chess-wins`, `chess-losses` *(must be created in Admin Portal)*

---

## Goal

Increment `chess-wins` or `chess-losses` in AGS when a game ends, and display the logged-in player's current win/loss counts on the home screen.

---

## Non-Goals

- Server-authoritative stat writes (no dedicated server)
- Stat-backed leaderboard (separate slice)
- Stat-backed achievements (separate slice)
- Guest stat tracking (guests use localStorage only)

---

## Affected Areas

| File | Change |
|------|--------|
| `package.json` | Add `@accelbyte/sdk-social@6.3.4` |
| `src/stats.js` *(new)* | `incrementWin()`, `incrementLoss()`, `fetchStats()` |
| `src/main.js` | Fetch stats after login; expose `window.agsIncrementWin/Loss`; update stats UI |
| `index.html` | Add wins/losses display to `screen-home` signed-in section |
| `app.js` | Call `window.agsIncrementWin()` on win, `window.agsIncrementLoss()` on loss in `showGameOver()` |

---

## AGS Modules

- **Statistics** — client-authoritative stat increment + readback, `@accelbyte/sdk-social`

---

## Implementation Steps

### Step 0 (Prereq — Admin Portal)
Create stat codes in Admin Portal → `seal-chessags` → Social → Statistics:

| Stat code | Default | Min | Max | Increment only |
|---|---|---|---|---|
| `chess-wins` | 0 | 0 | 999999 | ✓ |
| `chess-losses` | 0 | 0 | 999999 | ✓ |

Also add `http://127.0.0.1:8080` to IAM client `4d98466a671d4172aa98f9a3f1fa29d1` redirect URIs.

### Step 1: Install `@accelbyte/sdk-social`
### Step 2: Create `src/stats.js`
### Step 3: Update `src/main.js`
### Step 4: Update `index.html`
### Step 5: Update `app.js`

---

## Verification

1. Log in with Google → home screen shows `Wins: 0  Losses: 0`
2. Play a game vs computer and win → home screen shows `Wins: 1  Losses: 0`
3. Play a game vs computer and lose → home screen shows `Wins: 1  Losses: 1`

---

## Risks and Open Questions

1. **Stat not initialised**: AGS stat items must be created for a user before they can be incremented. The SDK's `createUserStatItem` call initialises the item to its default value (0) if it doesn't exist — this must be called before the first increment.
2. **Client authority**: P2P game — no server to validate results. Cheating is possible but acceptable for a casual game.

---

## Deferred Requested Integrations

- [ ] Stat-backed leaderboard (`chess-wins` as leaderboard source)
- [ ] Stat-backed achievements (e.g. "Win 10 games")

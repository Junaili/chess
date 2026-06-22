# AGS Plan — IAM: Google Login

**Date:** 2026-06-03
**Approved feature:** Optional Google login on the home screen via AGS IAM (PKCE flow)

---

## Confirmed Context

- **Project:** Vanilla HTML/JS chess game, `/Users/junaililie/personal-project/chess-ethan`
- **SDK:** `@accelbyte/sdk@4.3.1`, `@accelbyte/sdk-iam@6.3.4`, Vite `8.0.16`
- **AGS namespace:** `seal-chessags`
- **Base URL:** `https://seal-chessags.prod.gamingservices.accelbyte.io`
- **IAM client:** `4d98466a671d4172aa98f9a3f1fa29d1` (public)
- **Google IdP:** Not yet configured — must be added before any login code works
- **Existing auth:** None — `playerName` typed manually, stored in `localStorage`

---

## Goal

Add an optional "Sign in with Google" button to the existing home screen (`screen-home`). After login, `playerName` is populated from the AGS profile and the name input is hidden. Guest play (no login) continues to work unchanged. Logging in is non-destructive to the existing game flow.

---

## Non-Goals

- Mandatory login (guest play is preserved)
- Leaderboard migration from localStorage to AGS backend
- Lobby, Sessions, Matchmaking, or any other AGS module
- Showing AGS profile info anywhere except the home screen name

---

## Affected Areas

| File | Change |
|------|--------|
| `index.html` | Add `Sign in with Google` button + signed-in name display + sign-out link to `screen-home`; add Vite entry `<script type="module">` |
| `app.js` | Wire auth state: show/hide name input, populate `playerName` from AGS profile on login |
| `src/ags-client.js` *(new)* | AGS SDK initialisation from `.env` values |
| `src/auth.js` *(new)* | Google PKCE login, logout, token restore, PKCE callback handler |

---

## AGS Modules

- **IAM** — OAuth 2.0 PKCE flow, Google as platform IdP, `@accelbyte/sdk-iam`

---

## Implementation Steps

### Step 0 (Prereq — Admin Portal): Configure Google IdP

Before any code runs, Google must be added as a platform credential in AGS:

1. **Google Cloud Console** — create or select an OAuth 2.0 web app:
   - Authorized JavaScript origin: `https://<your-app-url>` (e.g. `https://192.168.4.81:8808`)
   - Authorized redirect URI: `https://<your-app-url>/` (the page AGS redirects back to after login)
   - Note the **Client ID** and **Client secret**

2. **AGS Admin Portal** → `seal-chessags` namespace → Game Setup → 3rd Party Configuration → Auth & Account Linking → Add New → **Google** → fill in:
   - App ID / Client ID: *(from Google Cloud Console)*
   - Client Secret: *(from Google Cloud Console)*
   - Redirect URI: `https://<your-app-url>/`
   - Status: Active → Save

3. **AGS IAM Client** → Admin Portal → IAM → OAuth Clients → edit `4d98466a671d4172aa98f9a3f1fa29d1` → add redirect URI: `https://<your-app-url>/`

> **Open question:** What is the deployment URL of the chess app? For local testing it's `https://192.168.4.81:8808/`. For a GitHub Pages deployment it would be `https://ethanlie.github.io/chess/`. The redirect URI must match exactly in all three places (Google Cloud Console, AGS 3rd Party Config, AGS IAM client).

### Step 1: Create `src/ags-client.js`

Initialise the AGS SDK using values from `.env` (loaded at build time by Vite):
- `ACCELBYTE_BASE_URL`
- `ACCELBYTE_NAMESPACE`
- `ACCELBYTE_CLIENT_ID`

### Step 2: Create `src/auth.js`

Implement the PKCE auth module:
- `loginWithGoogle()` — starts PKCE redirect to Google via AGS IAM
- `handleCallback()` — detects `?code=` in URL on page load, exchanges for token, fetches profile
- `restoreSession()` — checks stored token on load; refreshes if valid
- `logout()` — revokes token, clears storage
- `getPlayerName()` — returns display name or email from AGS profile

### Step 3: Wire `index.html`

Add to `screen-home`:
- "Sign in with Google" button (hidden when logged in)
- Signed-in state: avatar/name + "Sign out" link (hidden when guest)
- Change `<script src="app.js">` to a Vite module entry

### Step 4: Wire `app.js`

On page load:
1. Call `restoreSession()` / `handleCallback()`
2. If logged in: set `playerName` from AGS profile, hide name input, show sign-out
3. If guest: keep name input visible

On login event: update `playerName` and UI.
On logout event: clear `playerName`, show name input.

---

## Verification

**Service evidence:**
1. Click "Sign in with Google" → redirected to Google consent screen
2. Complete Google login → redirected back to app with `?code=...`
3. `handleCallback()` exchanges code → AGS access token returned
4. `getPlayerName()` returns Google display name from AGS profile

**Game-flow evidence:**
1. Home screen shows "Sign in with Google" for guests
2. After login: name input hidden, Google display name shown, game playable
3. After sign-out: name input restored, guest play works

---

## Risks and Open Questions

1. **Redirect URI**: Must match exactly across Google Cloud Console, AGS 3rd Party Config, and the IAM client. Local `https://192.168.4.81:8808/` won't work for friends on a different network.
2. **Google IdP not configured**: Step 0 must be completed before testing. Without it, login returns HTTP 400.
3. **Vite entry migration**: `app.js` currently uses `'use strict'` global scope and `onclick=""` handlers. The new `src/auth.js` must be wired carefully to not break the existing globals.
4. **PKCE state loss on redirect**: If the user has an active invite link in the URL when they click "Sign in with Google", the redirect will clear the URL params. Consider storing invite state in `sessionStorage` before redirect.

---

## Deferred Requested Integrations

*(none — this was a single-slice request)*

---

## Next Step

Approve this plan → implementation begins at Step 1 (`src/ags-client.js`).
After Step 0 (Google IdP) is configured in the Admin Portal, smoke testing can run end-to-end.

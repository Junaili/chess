# AGS Game Flow Plan: Friends Presence And Profile UI

## Approved Feature

Clarify when no friends are online, move offline friends into a scrollable
overlay, and make friend names open their player profile and statistics.

Status: approved and implemented.

## Confirmed Context

- The Friends panel already loads accepted friends with resolved display names
  and Lobby presence.
- Online and in-match friends are currently rendered first.
- When the online count is zero, the online section is omitted entirely.
- Every offline friend is appended to the main dashboard list, making the
  Friends card unnecessarily long.
- `openPublicProfile(userId, displayName)` already loads the selected player's
  statistics, rank, relationship state, and match history.
- No additional AGS API or configuration is required.

## Goal

- Always show an explicit online count, including `0 online`.
- Show a useful empty state when nobody is online.
- Replace the inline offline list with a compact summary button.
- Open offline friends in an accessible modal overlay with an internally
  scrollable list.
- Make accepted friend names clearly clickable and open their existing profile
  page.
- Preserve Invite and Watch actions for online friends.

## Non-Goals

- Changing AGS presence semantics or polling.
- Adding a new profile/statistics endpoint.
- Changing friend request, acceptance, blocking, or invite behavior.
- Showing private information not already exposed by the current profile flow.

## Affected Areas

- `index.html`: offline-friends dialog structure.
- `style.css`: count/empty state, profile-link rows, and responsive overlay.
- `src/main.js`: friend grouping, modal lifecycle, profile navigation, focus
  restoration, and event binding.
- `tests/e2e`: deterministic online-zero, modal scrolling, and profile-link
  behavior coverage.

## AGS Modules

- Lobby Friends: existing accepted-friends list.
- Lobby Presence: existing online, in-match, and offline status.
- Statistics and Leaderboards: existing profile screen reads only.
- IAM: existing authenticated player access token.

## Authorization Plan

| Item | Decision |
| --- | --- |
| Caller | Browser game client |
| Environment | AGS Shared Cloud, namespace `seal-chessags` |
| Token | Existing authenticated player access token |
| IAM client | Existing public web client |
| Secret | None |
| AGS calls | Existing friend list/presence and profile statistics/rank calls |
| Permission discovery | Lobby Friends public list catalogue declares no operation permission |
| Verified access | Existing integrated flows work; operator CLI currently has no access token |
| Permission changes | None |

## Implementation Steps

1. Render a persistent Friends availability header such as `0 online` and
   `5 total`.
2. When no accepted friends are online, show “No friends online right now”
   without treating the Friends list as empty.
3. Replace inline offline rows with an “Offline friends (N)” button.
4. Add an accessible modal overlay with:
   - Title and offline count.
   - Internally scrollable friend list.
   - Close button, backdrop close, Escape handling, focus trap, and focus
     restoration.
5. Render friend display names as profile buttons with an explicit accessible
   label.
6. On profile selection, close the offline modal and call the existing
   `openPublicProfile(userId, displayName)` flow.
7. Keep Invite and Watch controls independent from the profile button so
   selecting an action does not navigate.
8. Apply profile links to accepted online and offline friends; pending request
   rows remain action-focused.
9. Add deterministic browser tests for zero-online feedback, modal open/close,
   long-list internal scrolling, and profile navigation.

## Verification

- Run focused Friends UI tests in Chromium and iPad WebKit.
- Run the complete UI smoke suite.
- Run the production and Capacitor builds.
- Verify the dashboard itself does not grow when many friends are offline.
- Verify keyboard focus and Escape behavior.
- Verify Invite, Watch, and profile navigation remain separate actions.

## Risks And Open Questions

- Presence can change while the modal is open. The next existing presence
  refresh will rerender both the summary and modal list.
- A player may become online immediately after opening the offline list; this is
  harmless and self-corrects on refresh.
- The profile screen can make existing statistics and leaderboard requests;
  this change does not add new cross-player data.

## Next Step

Implementation and verification are complete.

## Deferred Requested Integrations

- None.

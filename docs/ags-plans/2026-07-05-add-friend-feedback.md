# Add Friend Feedback Game Flow Plan

## Approved Feature

Improve the Add Friend experience so a successful request is unmistakable and
unsuccessful attempts show a specific, actionable message instead of a raw AGS
or transport error.

Status: approved and implemented.

## Confirmed Context

- The web client looks up an account by email through the existing authenticated
  Extend `/lookup/email` endpoint.
- It sends the request with the AGS Lobby Friends public operation
  `POST /friends/namespaces/{namespace}/me/request`.
- The Friends panel already loads current friends, incoming requests, and
  outgoing requests.
- The current result is rendered as a small inline message. Successful refreshes
  can clear feedback, and backend error strings can be shown directly.
- No AGS configuration change is required.

## Goal

- Make searching, success, pending, not-found, and failure states visually clear.
- Explain what happened and what the player can do next.
- Preserve action feedback when the friend lists refresh.
- Translate known AGS and network failures into stable player-facing messages.
- Prevent duplicate submissions while a request is running.

## Non-Goals

- Changing how accounts are discovered by email.
- Automatically adding friends without confirmation.
- Changing AGS Lobby, IAM, or Extend configuration.
- Adding a new notification system outside the Friends panel.

## Affected Areas

- `index.html`: semantic Add Friend form, submit control, and accessible status
  region.
- `style.css`: intentional idle, loading, success, warning, and error states.
- `src/main.js`: form state management, relationship-aware outcomes, durable
  feedback, and action handling.
- `src/friends.js`: normalized errors that do not expose backend internals.
- `tests/e2e`: deterministic Add Friend outcome coverage.

## AGS Modules

- Lobby Friends:
  - Send the current user's friend request.
  - Read friends, incoming requests, and outgoing requests.
- IAM:
  - Existing authenticated player access token only.
- Extend:
  - Existing authenticated email lookup endpoint only.

## Authorization Plan

| Item | Decision |
| --- | --- |
| Caller | Browser game client |
| Environment | AGS Shared Cloud, namespace `seal-chessags` |
| Token | Authenticated player access token |
| IAM client | Existing public web client |
| Client secret | None; secrets must not be placed in the browser |
| Friend request operation | Public Lobby Friends `send-my-request` |
| Required operation permissions | None declared by the AGS operation catalogue |
| Email lookup | Existing Extend endpoint, called with the same player token |
| Permission changes | None |

The local AGS operator session currently has no access token, so tenant-level
role assignment cannot be reverified from the CLI. This does not block the
feature: the public operation declares no extra permission and the existing
authenticated friend flow is already integrated. No elevated credentials will
be added.

## Implementation Steps

1. Replace the ambiguous inline result with an accessible status card using
   `role="status"` or `role="alert"` as appropriate.
2. Add explicit busy behavior: disable the email input and submit button, show
   "Searching...", and prevent duplicate submission.
3. Validate and normalize the email before making a request.
4. After lookup, compare the user ID with the loaded Friends state and show:
   - Already friends: explain that the player is already in the Friends list.
   - Outgoing pending: explain that the request was already sent.
   - Incoming pending: explain that this player has already sent a request and
     provide an Accept action.
   - Self: explain that the signed-in account cannot be added.
5. On success, show the matched display name, a clear "Request sent" heading,
   and explain that the player will appear as a friend after acceptance.
6. On no account match, show a clear "No player found" result and retain the
   existing invite/share path.
7. Map known failures to stable messages:
   - Invalid email.
   - Authentication expired.
   - Rate limited.
   - Request rejected or blocked.
   - Service unavailable or offline.
   - Unexpected failure with a safe retry message.
8. Keep action feedback separate from list-loading feedback so
   `refreshFriendsUI()` cannot erase the result.
9. Apply the same normalized feedback behavior to Accept, Reject, Cancel, and
   profile-originated friend requests where they share the same helpers.
10. Add deterministic browser tests with mocked lookup and Friends responses for
    success, no account, existing relationship, invalid input, and service
    failure.

## Verification

- Run unit tests for Friends error normalization if the current test setup
  supports module-level tests.
- Run focused Playwright UI tests for every Add Friend outcome.
- Run the existing UI smoke suite to detect Friends panel regressions.
- Manually verify keyboard submission, focus behavior, screen-reader status
  announcements, narrow viewport layout, and repeated submissions.
- Confirm no access token, email address, or raw AGS response is logged or
  rendered.

## Risks And Open Questions

- AGS error codes can vary by deployment version. HTTP status and known codes
  will be mapped explicitly, with a safe fallback.
- Relationship state may change between lookup and request. A server response
  remains authoritative and will be translated to the same user-facing state.
- The existing no-account invite URL behavior will be retained, but visually
  separated from an actual friend-request success.

## Next Step

Implementation and verification are complete.

## Deferred Requested Integrations

- None.

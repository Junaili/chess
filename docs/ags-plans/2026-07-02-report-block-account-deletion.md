# AGS player safety and account deletion implementation plan

Status: Approved on 2026-07-02

## Goal

Complete the two remaining Apple submission features:

1. In-game reporting and blocking backed by AGS Reporting and AGS Lobby.
2. In-app account deletion backed by an existing AGS Extend service and the AGS GDPR service.

## Scope

### Player safety

- Load reporting reasons from the AGS `Player Safety` reason group.
- Report an individual AGS Chat message with its chat ID, topic ID, sender, and creation time.
- Report the current opponent as a user.
- Block, list, and unblock players through AGS Lobby.
- Immediately suppress chat and social/rematch actions for a blocked current opponent without interrupting the game.
- Add blocked-player management to the signed-in user's profile.

### Account deletion

- Add an Account & Safety section to the signed-in user's profile.
- Require a confirmation dialog and the exact text `DELETE`.
- Add Extend endpoints:
  - `GET /account/deletion-requirements`
  - `POST /account/deletion`
- Derive the target user from the introspected bearer token.
- Detect Sign in with Apple through IAM linked platform accounts.
- For Apple-linked users, obtain a fresh native Apple authorization code, exchange it, and revoke the resulting Apple token on the server.
- Submit deletion to the native AGS GDPR S2S endpoint.
- Clear the local session and player data only after AGS accepts the deletion request.

## Security and authorization

- The browser never receives the Extend confidential client secret or Apple private key.
- Extend obtains its own client-credentials token.
- Required Extend client permissions:
  - `ADMIN:NAMESPACE:{namespace}:USER:{userId}` with `READ`
  - `ADMIN:NAMESPACE:{namespace}:S2S:INFORMATION:USER` with `CREATE`
- Apple server environment:
  - `APPLE_TEAM_ID`
  - `APPLE_KEY_ID`
  - `APPLE_CLIENT_ID`
  - `APPLE_PRIVATE_KEY_B64`
- A deletion failure retains the account and session and presents a retryable error.

## Implementation modules

- `src/safety.js`: AGS Reporting and Lobby block APIs.
- `src/account-deletion.js`: browser-to-Extend deletion flow.
- `src/auth.js`: native Apple deletion reauthorization and local-account cleanup.
- `src/main.js`, `app.js`, `index.html`, `style.css`: safety and account UI integration.
- `custom-extend-app/ethan-chess-service/cmd/account_deletion.go`: linked-platform lookup, Apple revocation, and AGS GDPR submission.

## Verification

- Unit tests for report payloads, blocked-user normalization, deletion validation, and Apple JWT/token handling.
- Browser tests for report/block controls and delete-account confirmation.
- Go handler tests against local fake IAM, Apple, and GDPR endpoints.
- Existing unit, build, browser, and iPad test suites.

## Release prerequisites

- Configure the AGS reporting reason group and reasons.
- Enable reporting rate limits appropriate for chat and user reports.
- Enable `blockedPlayerCannotMatch`.
- Confirm with AccelByte that AGS Chat uses Lobby block data for message delivery.
- Verify the AGS GDPR S2S endpoint is available in the deployment environment. Shared Cloud environments without this endpoint are release-blocked for native deletion.
- Configure the Extend permissions and Apple secrets before deployment.

## Deferred

Other App Store submission tasks are outside this approved implementation and remain tracked separately.

<!--
audience: Tier 1 — Engineering: Individual Practitioners
tags: AGS, Apple, App Store, IAM, Sign in with Apple, Chat, moderation, compliance
type: case-study
word-count-target: deep-dive (1,500–2,500)
-->

# How Ethan’s Chess Uses AGS to Prepare an iPad Game for App Store Review

By Junaili Lie

A multiplayer chess game becomes a user-generated-content product as soon as players can name themselves and send a message. For Ethan’s Chess, preparing the iPad build for App Store review therefore changed backend architecture, not just App Store Connect metadata.

The project uses AccelByte Gaming Services (AGS) for identity, legal agreement tracking, matchmaking, social features, and moderated text chat. That foundation covers a large part of the submission path, but it does not make the app compliant by itself. Reporting, blocking, account deletion, support operations, and reviewer access still have to work through the player-facing UI.

This article maps the implementation to Apple’s requirements, names the AGS APIs involved, and calls out the remaining blockers before submission.

## The Apple requirements that shaped the backend

Four App Review rules directly affect this project:

- Guideline 4.8 requires an appropriate privacy-oriented login alternative when an app uses third-party or social login for the primary account.
- Guideline 1.2 requires apps with user-generated content to filter objectionable material, accept reports, respond to reports, block abusive users, and publish contact information.
- Guideline 5.1.1 requires an in-app account deletion path when the app supports account creation, plus an accessible privacy policy describing collection, sharing, retention, and deletion.
- Guideline 2.1 requires a working build, active backend services, and either a demo account or a fully featured demo mode for App Review.

These are current requirements, so teams should verify them against Apple’s live [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) before every submission.

The resulting AGS capability map for Ethan’s Chess looks like this:

| Apple-facing concern | AGS capability | Project status |
|---|---|---|
| Apple and Google authentication | IAM and third-party platform token exchange | Client flow integrated; Apple entitlement and live provider setup still require release verification |
| Account registration and profile identity | IAM Users APIs and input validation | Implemented |
| Terms and privacy acceptance | Agreement eligibility and acceptance APIs | Implemented for mandatory policies; published policy content still needs final review |
| Objectionable display names | IAM input validation plus client-side filtering | Implemented as defense in depth |
| Objectionable chat messages | AGS Chat profanity filtering plus client-side filtering | Integrated; live two-account verification remains blocked by test credentials |
| Persistent, reviewable chat evidence | AGS Chat topics, history, message IDs, and timestamps | Integrated; live two-account verification remains blocked by test credentials |
| Report offensive chat or players | AGS Reporting | Designed, not yet implemented |
| Block abusive users | AGS Lobby/Friends blocking | Designed, not yet implemented |
| Delete an account in-app | AGS GDPR deletion APIs or an approved server-side alternative | Blocked by Shared Cloud availability and Apple-token revocation design |
| Reviewer access | IAM test accounts and live AGS services | Not ready; current live test credentials must be replaced |

The distinction between implemented and planned matters. App Review evaluates the behavior available in the submitted binary, not the services listed in an architecture diagram.

## Sign in with Apple becomes an AGS identity

Ethan’s Chess is a Capacitor application, so its native Apple login starts with Apple’s AuthenticationServices through `@capacitor-community/apple-sign-in`. The plugin returns an Apple identity token to the app.

The game then exchanges that platform token for an AGS player session:

```text
Apple AuthenticationServices
  -> Apple identity token
  -> POST /iam/v3/oauth/platforms/apple/token
  -> AGS access and refresh tokens
  -> UsersApi.getUsersMe_v3()
```

The exchange uses the game’s public IAM client. No client secret is embedded in the iPad application. Once IAM returns an AGS user token, the same identity authorizes Chat, Matchmaking, Lobby, Statistics, CloudSave, Leaderboards, Achievements, and Game Telemetry.

AGS documents the required Apple-side and Admin Portal setup in [Set up Apple as an identity provider](https://docs.accelbyte.io/gaming-services/modules/foundations/identity-access/authentication/apple-identity/). The production checklist still has to verify:

- The App ID and provisioning profile include the Sign in with Apple capability.
- Apple Service ID, Team ID, Key ID, and private key are configured and active in the AGS game namespace.
- The bundle identifier and registered return URLs match the shipping build.
- Login succeeds on a physical iPad and is followed by an authenticated profile request.

The app also supports Google and email/password login. IAM normalizes all of those entry points into one AGS player identity. That makes the Apple login an equivalent account path rather than a separate account silo.

The relevant client APIs are:

- `POST /iam/v3/oauth/platforms/apple/token`
- `POST /iam/v3/oauth/platforms/google/token`
- `POST /iam/v3/oauth/token`
- `UsersApi.getUsersMe_v3()`
- `OAuth20ExtensionApi.createLogout_v3()`
- `UsersApi.patchUserMe_v3()`
- `UsersApi.createUserInputValidation_v3()`

This extends AccelByte’s earlier discussion of [cross-platform authentication](https://accelbyte.io/blog/cross-platform-authentication-for-games-should-you-build-it-or-plug-it-in) with a concrete browser-to-iPad implementation.

## Legal acceptance is enforced before online play

After login, the game checks whether the player has unaccepted mandatory documents:

```text
GET /agreement/public/eligibilities/namespaces/{namespace}
POST /agreement/public/agreements/policies
```

If a required policy is pending, Ethan’s Chess shows a legal-document screen and blocks the signed-in game flow until the player accepts or signs out. The acceptance request records the selected localized policy version, policy version, and policy ID.

That gives the application versioned consent state rather than a local checkbox that disappears when the app is reinstalled. It follows the same general model described in AccelByte’s [legal agreement tracking article](https://accelbyte.io/blog/legal-agreement-tracking-solution).

Agreement tracking does not write the privacy policy for the studio. Before submission, the app still needs an easily accessible privacy-policy link, a support contact, retention and deletion language, and accurate App Store privacy disclosures for IAM data, gameplay telemetry, chat, camera, and microphone use.

## Display names are filtered at two boundaries

The player’s display name appears in matchmaking, profiles, leaderboards, friend lists, game invitations, and chat. Treating it as trusted profile data would create multiple paths for objectionable text to reach another player.

Ethan’s Chess applies a local Unicode-normalizing profanity matcher before registration or profile edits. It also calls `UsersApi.createUserInputValidation_v3()` so AGS can reject a value according to namespace input-validation policy. Incoming names are filtered again before rendering.

The local matcher is not the authority. It provides immediate feedback and an offline fallback. IAM remains the source of the persisted display name, while every display surface escapes HTML before rendering.

## Why text chat moved off PeerJS

The original multiplayer path used PeerJS for chess moves, rematches, reconnect state, video, and text chat. Peer-to-peer text was easy to add, but it had no service-side history, message identifiers, namespace profanity policy, mute enforcement, or moderator evidence.

That was incompatible with the moderation flow required for an App Store submission. The migration moved only text chat to AGS Chat:

```text
Random match
  -> AGS Matchmaking ticket
  -> AGS game session
  -> session Chat topic

Friend match
  -> two authenticated AGS user IDs
  -> personal Chat topic
```

PeerJS still transports board moves and optional video. It no longer carries chat messages or chat history.

The browser client uses the AGS Chat JSON-RPC protocol over `/chat/` for:

- `actionCreateTopic`
- `sendChat`
- `queryChat`
- `actionRefreshToken`
- connection and new-message events

The TypeScript Chat SDK supplies the REST side:

- `ConfigApi.getConfig_ByNamespace()`
- `TopicApi.getChats_ByTopic()`

Random matches use the topic associated with their AGS game session. Direct friend matches resolve a personal topic. Messages are deduplicated by AGS chat ID, restored from history, and tied to an authenticated sender ID.

This implementation is a practical extension of the earlier [Chat V2 product update](https://accelbyte.io/blog/product-update-chat-v2): the important change for Apple review is not the transport protocol itself, but the shift from ephemeral peer traffic to a moderated service boundary.

## Profanity filtering uses defense in depth

The chat composer rejects known profanity locally before making a network call. Incoming messages are checked again so an older or modified client cannot force raw objectionable text into the UI.

AGS Chat remains the authoritative layer. The namespace enables Chat profanity filtering, dictionary groups, message limits, spam controls, mute behavior, and session chat. The `chess-quickmatch` session template enables `textChat` with game-session mode.

AGS exposes administrative profanity operations for querying, importing, exporting, creating, updating, and deleting dictionary entries. Those operations let a moderation team change policy without shipping another iPad binary.

This addresses the filtering portion of Apple Guideline 1.2. It does not address reporting, human response, blocking, or published support contact information.

## Reporting must preserve the message evidence

The next implementation slice uses the AGS Reporting service. Players will be able to report an individual opponent message or the opponent generally.

The game will load configured reasons through:

```text
GET /reporting/v1/public/namespaces/{namespace}/reasons
```

It will submit reports through:

```text
POST /reporting/v1/public/namespaces/{namespace}/reports
```

For a chat report, the request must include:

- `category: "CHAT"`
- The reported player’s AGS user ID
- The AGS chat ID as `objectId`
- `objectType: "chat"`
- The reason and optional comment
- `additionalInfo.topicId`
- `additionalInfo.chatCreatedAt`

That payload gives moderators the identifiers needed to retrieve the corresponding chat snapshot and review the surrounding conversation. AGS Reporting also supports `USER` reports for behavior not tied to one message. AccelByte documents the payload and moderation workflow in [View and take action on reports](https://docs.accelbyte.io/gaming-services/tutorials/reporting-telemetry/view-take-action-reports/).

Submitting a report is only the ingestion side. The studio must configure reasons, report limits, moderation ownership, response targets, and escalation actions in the Admin Portal. Apple explicitly requires timely responses, so an unmonitored ticket queue is not sufficient.

## Blocking is separate from reporting

After a successful report, the UI will offer a separate Block action. The game will use the Lobby player-block APIs exposed by `PlayerApi`:

- `createPlayerUserMeBlock({ blockedUserId })`
- `getPlayerUsersMeBlocked()`
- `createPlayerUserMeUnblock({ userId })`

Blocking will immediately hide the opponent’s existing messages, disable further chat, remove friend and rematch actions, and keep the current chess game running. Keeping the game active prevents blocking from becoming a way to escape a recorded loss.

AGS blocking also removes the social relationship and can prevent blocked players from meeting in later matches. The `chess-quickmatch` rule set should explicitly use `blockedPlayerCannotMatch`.

Chat and Lobby block behavior must be connected at the service level. AccelByte’s [player-blocking documentation](https://docs.accelbyte.io/gaming-services/modules/online/friends/managing-player-blocks/) currently directs studios to contact AccelByte to configure Chat to consume Lobby block data. Client-side hiding remains useful for immediate response, but service-side enforcement is the real boundary.

## Account deletion is still a release blocker

Apple requires users who create an account to initiate deletion inside the app. Apple also provides additional token-revocation guidance for apps using Sign in with Apple in [TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple).

AGS exposes player-facing deletion operations:

```text
POST   /gdpr/public/users/me/deletions
GET    /gdpr/public/users/me/deletions/status
DELETE /gdpr/public/users/me/deletions
```

The submission call requires the current third-party platform identifier and platform token. The status and cancellation calls use the authenticated AGS player session.

However, AccelByte’s current [data portability and erasure documentation](https://docs.accelbyte.io/gaming-services/modules/foundations/legal/manage-user-data-portability-and-erasure/) says the GDPR service is not supported in AGS Shared Cloud. Ethan’s Chess currently runs on Shared Cloud.

That means the project cannot claim deletion compliance from the existence of the API schema. Before submission, the team needs an AccelByte-supported Shared Cloud deletion route or an approved confidential server workflow that erases data across IAM and every game service. Deleting only the IAM profile would leave CloudSave, Statistics, Chat, and telemetry data behind.

The deletion workflow must also revoke the user’s Sign in with Apple authorization using a server-held Apple credential. That secret cannot live in the iPad client.

## The rest of the AGS stack supports review completeness

Several AGS capabilities are not Apple compliance controls, but they make the account-based game demonstrably complete:

| Capability | APIs used in Ethan’s Chess |
|---|---|
| Matchmaking and Session | `MatchTicketsApi.createMatchTicket()`, ticket status/cancel APIs, `GameSessionApi.getGamesession_BySessionId()` |
| Friends and Presence | `FriendsApi` request/accept/reject/cancel methods and Lobby WebSocket presence/invite events |
| Statistics | `UserStatisticApi` create, read, and update methods for wins, losses, draws, games, and streaks |
| Leaderboards | `LeaderboardDataV3Api.getAlltime_ByLeaderboardCode_v3()` and per-user rank lookup |
| Achievements | `AchievementsApi` catalog reads and `UserAchievementsApi` progress/unlock operations |
| CloudSave | `PublicPlayerRecordApi` for match history and live spectator state |
| Game Telemetry | `GametelemetryOperationsApi.createProtectedEvent()` |
| Extend service | Confidential IAM-backed email lookup, invitations, referrals, and bot-related server operations |

These features also give App Review meaningful account functionality to test. They are why the app needs authentication rather than forcing every chess mode behind an unnecessary login. Guest and computer play remain available without an account.

## Reviewer access is part of the implementation

Apple’s pre-submission guidance requires full reviewer access, a live backend, and explanations for non-obvious features. Ethan’s Chess therefore needs two stable review accounts so App Review can exercise matchmaking and two-player Chat, plus clear notes covering:

- How to sign in with Apple and with the demo account
- How to start a random match
- Where the profanity, report, and block controls appear
- How to reach account deletion, privacy policy, and support
- Why camera and microphone permissions are requested only for optional video chat
- Which features require a second account

The automated test suite already covers browser gameplay, WebKit’s iPad profile, the iOS simulator, and AGS protocol behavior. The live two-account test is currently blocked by an invalid configured password. That is a submission blocker, not a test-suite footnote.

## What AGS handles, and what the studio still owns

AGS supplies identity, moderated chat transport, report ingestion, block relationships, legal agreement state, and deletion interfaces where supported. The studio still owns policy text, App Store privacy answers, support contact information, moderation staffing, escalation decisions, Apple token revocation, reviewer credentials, and proof that every flow works in the submitted build.

That division is the main engineering lesson from this project. Backend capability reduces the amount of infrastructure a team must build, but Apple approves a working player experience and an operating process.

Use the [AGS documentation](https://docs.accelbyte.io/) to map these service boundaries before adding social features to an iOS or iPadOS game.

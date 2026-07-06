# AGS Game Flow Plan: In-App Legal Review Overlay

## Approved Feature

Replace the external browser-tab legal review with an in-app overlay where
players can read each required document and return to the acceptance gate.

Status: approved and implemented.

## Confirmed Context

- AGS Legal eligibility determines which mandatory documents require acceptance.
- Each eligibility is hydrated with its published AGS attachment URL.
- The current Review action opens that attachment in a new browser tab or the
  Capacitor browser, then immediately marks the document reviewed.
- The published version `1.0` attachments are generated from Markdown files in
  `legal-documents/`.
- Acceptance remains `POST /agreement/public/agreements/policies`.

## Goal

- Open legal content in a modal overlay inside the game.
- Keep the player on the legal acceptance screen.
- Show document title, version, locale, readable content, reading progress, and
  a clear close/return action.
- Mark a document reviewed only after the player reaches the end and explicitly
  confirms they finished reviewing it.
- Preserve keyboard, screen-reader, mobile, and iPad usability.

## Non-Goals

- Changing legal wording or AGS policy versions.
- Changing the AGS acceptance payload or eligibility logic.
- Adding a custom acceptance database.
- Removing external links from the separate Privacy & Legal history screen.

## Affected Areas

- `index.html`: accessible legal-review dialog markup.
- `style.css`: responsive overlay, document typography, progress, and sticky
  actions.
- `src/legal.js`: authenticated attachment-content loading and safe response
  classification.
- `src/main.js`: dialog lifecycle, safe Markdown rendering, review completion,
  focus restoration, and error states.
- `tests/unit` and `tests/e2e`: content safety and overlay interaction coverage.

## AGS Modules

- IAM: existing authenticated player access token.
- Legal: existing eligibility, localized-policy-version, attachment, and
  agreement acceptance paths.

## Authorization Plan

| Item | Decision |
| --- | --- |
| Caller | Browser game client |
| Environment | AGS Shared Cloud, namespace `seal-chessags` |
| Token | Authenticated player access token |
| IAM client | Existing public web client |
| Client secret | None |
| AGS calls | Existing eligibility and localized-policy-version GET requests; existing agreement POST |
| Attachment read | Published attachment URL returned by AGS |
| Permission discovery | Current CLI does not catalogue the Agreement service; existing plan and working integration report no additional permission for public endpoints |
| Verified access | Existing eligibility and acceptance integration is working; operator CLI session currently lacks an access token |
| Permission changes | None |

## Implementation Steps

1. Add a native `dialog`-style legal reader with labelled title, metadata,
   scrollable body, progress indicator, loading/error state, and sticky footer.
2. Add a legal attachment loader that:
   - accepts only the normalized AGS-provided `https` attachment URL;
   - fetches text/Markdown without evaluating HTML or scripts;
   - returns a specific CORS/content-type error;
   - never logs or renders access tokens.
3. Render the supported Markdown subset with DOM APIs: headings, paragraphs,
   lists, emphasis, and safe `https` links. Do not use raw `innerHTML` from the
   attachment.
4. Open the overlay from each Review button, trap focus while open, close on
   Escape, restore focus to the originating button, and prevent background
   scrolling.
5. Track scroll progress. Enable “Finished reviewing” only when the document end
   is reached; short documents count as reaching the end immediately.
6. On completion, update the existing reviewed card/progress state. Closing
   early leaves the document unreviewed.
7. Show an in-overlay retry state when content cannot load. Provide a clearly
   labelled external fallback only for unsupported document formats or an
   attachment host that blocks in-app retrieval.
8. Add unit tests for safe Markdown rendering inputs and browser tests for open,
   scroll-to-end, close-without-completion, completion, focus restoration, and
   mobile layout.

## Verification

- Run legal and content-rendering unit tests.
- Run focused Chromium and iPad WebKit overlay tests.
- Run the existing privacy and UI smoke suites.
- Run a production build.
- Manually verify no new tab opens, background interaction is blocked, Escape
  works, focus returns, and acceptance remains disabled until every required
  document is completed.

## Risks And Open Questions

- The AGS attachment host may not permit browser `fetch` through CORS even
  though direct navigation works. If observed, the overlay will use an embedded
  document fallback where framing is allowed, or show an explicit external
  fallback rather than falsely marking the document reviewed.
- Future non-text attachments such as PDF require embedded viewing rather than
  Markdown rendering.
- Reaching the end demonstrates presentation, not comprehension; the existing
  final agreement checkbox remains the explicit consent action.

## Next Step

Implementation and verification are complete.

## Deferred Requested Integrations

- [ ] Optional in-app review overlay for already accepted documents in Privacy
  & Legal history.

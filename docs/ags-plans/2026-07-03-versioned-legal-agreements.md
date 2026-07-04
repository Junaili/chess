# AGS Game Flow Plan: Versioned Legal Agreements

## Approved Feature

Use AGS Legal as the source of truth for the legal documents players accept and for each player's acceptance record.

## Confirmed Context

- The web/iPad client already authenticates players through AGS IAM.
- The login flow already calls the AGS eligibility endpoint and blocks entry when mandatory documents are pending.
- Acceptance already uses `POST /agreement/public/agreements/policies`.
- Static Privacy Policy, Terms of Use, and Community Standards content was added locally but was not provisioned as AGS policy versions.
- Production base URL: `https://seal-chessags.prod.gamingservices.accelbyte.io`
- Namespace: `seal-chessags`

## Goal

- Store Privacy Policy, Terms of Use, and Community Standards as separate versioned AGS Legal policies.
- Publish an English attachment for each version.
- Require players to open each AGS-hosted attachment before accepting.
- Save acceptance through AGS Agreements with the policy ID, policy version ID, and localized policy version ID.
- Show accepted document/version metadata in the in-app Privacy & Support center.

## Non-Goals

- Support contact information is not an agreement and is not included in bulk acceptance.
- This change does not provide legal advice or replace legal review of the document text.
- No custom acceptance database will be added.

## Affected Areas

- `legal-documents/`
- `scripts/provision-ags-legal.mjs`
- `src/legal.js`
- `src/main.js`
- `index.html`
- legal/privacy tests

## AGS Modules

- IAM: authenticated player access token.
- Legal: policies, policy versions, localized attachments, eligibility, and acceptance records.

## Authorization Plan

- Caller: game client for player reads/acceptance; trusted developer CLI for provisioning.
- Environment: AGS Shared Cloud production.
- Client calls: authenticated user access token with the existing public IAM client.
- Provisioning calls: developer token from `ags auth login`; no secret is stored in the repository.
- Player endpoints:
  - `GET /agreement/public/eligibilities/namespaces/{namespace}`
  - `GET /agreement/public/localized-policy-versions/{localizedPolicyVersionId}`
  - `GET /agreement/public/agreements/policies`
  - `POST /agreement/public/agreements/policies`
- Permission discovery: `ags describe` reports no additional resource permission for the public endpoints.

## Implementation Steps

1. Add canonical legal document source files and a manifest with stable names and display versions.
2. Add an idempotent provisioning command that discovers the Legal Document policy type, creates missing resources, uploads attachments, commits versions, and publishes them.
3. Keep the login gate driven only by AGS eligibility and AGS-hosted attachments.
4. Read AGS acceptance history in the Privacy & Support center and display accepted document/version/signing date.
5. Add unit and browser coverage.
6. Provision production and verify all published versions by read-back.

## Verification

- Unit tests validate document mapping and acceptance metadata.
- Browser tests validate the privacy center and acceptance status UI.
- Production build succeeds.
- AGS read-back shows all three policies, version `1.0`, English attachments, and published state.
- A test player acceptance appears in `GET /agreement/public/agreements/policies`.

## Risks And Open Questions

- The legal wording still requires owner/legal review before submission.
- Publishing a new mandatory version will intentionally require players to accept again.
- AGS CLI authentication is required before production provisioning.

## Deferred Requested Integrations

- [ ] Additional locales beyond `en-US`.
- [ ] Additional country-specific policy variants when legal review requires them.

## Next Step

Provision version `1.0` in `seal-chessags`, then test acceptance with a dedicated reviewer account.

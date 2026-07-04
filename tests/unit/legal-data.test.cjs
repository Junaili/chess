const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.resolve(__dirname, '../../src/legal-data.mjs'),
))

test('maps the active default localized eligibility version', async () => {
  const { mapEligibilityToDocument } = await modulePromise
  const document = mapEligibilityToDocument({
    baseUrls: ['https://cdn.example/legal/'],
    countryCode: 'US',
    isMandatory: true,
    policyId: 'policy-1',
    policyName: 'Privacy Policy',
    tags: ['ethans-chess', 'privacy'],
    policyVersions: [{
      id: 'version-1',
      displayVersion: '1.0',
      isInEffect: true,
      localizedPolicyVersions: [{
        id: 'localized-1',
        localeCode: 'en-US',
        isDefaultSelection: true,
        attachmentLocation: 'privacy.md',
      }],
    }],
  })

  assert.equal(document.policyVersionId, 'version-1')
  assert.equal(document.localizedPolicyVersionId, 'localized-1')
  assert.equal(document.attachmentLocation, 'privacy.md')
  assert.deepEqual(document.baseUrls, ['https://cdn.example/legal/'])
  assert.deepEqual(document.tags, ['ethans-chess', 'privacy'])
})

test('maps the flat acceptance-history response used by AGS events and APIs', async () => {
  const { mapAcceptedAgreement } = await modulePromise
  const document = mapAcceptedAgreement({
    policyId: 'policy-1',
    policyVersionId: 'version-1',
    localizedPolicyVersionId: 'localized-1',
    policyName: 'Privacy Policy',
    displayVersion: '1.0',
    localizedDescription: 'Privacy details',
    signingDate: '2026-07-03T00:00:00Z',
    isAccepted: true,
  })

  assert.equal(document.localizedPolicyVersionId, 'localized-1')
  assert.equal(document.description, 'Privacy details')
  assert.equal(document.acceptedAt, '2026-07-03T00:00:00Z')
})

test('rejects unsafe attachment protocols', async () => {
  const { normalizeDocumentLocation } = await modulePromise
  assert.equal(
    normalizeDocumentLocation('javascript:alert(1)', 'https://example.accelbyte.io'),
    '',
  )
  assert.equal(
    normalizeDocumentLocation('/policy.md', 'https://example.accelbyte.io'),
    'https://example.accelbyte.io/policy.md',
  )
  assert.equal(
    normalizeDocumentLocation('policy.md', 'https://cdn.example/legal/'),
    'https://cdn.example/legal/policy.md',
  )
})

test('builds only complete bulk-acceptance records', async () => {
  const { buildAcceptedPolicies } = await modulePromise
  assert.deepEqual(buildAcceptedPolicies([
    {
      policyId: 'policy-1',
      policyVersionId: 'version-1',
      localizedPolicyVersionId: 'localized-1',
    },
    {
      policyId: 'incomplete',
    },
  ]), [{
    isAccepted: true,
    policyId: 'policy-1',
    policyVersionId: 'version-1',
    localizedPolicyVersionId: 'localized-1',
  }])
})

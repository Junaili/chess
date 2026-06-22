import { sdk } from './ags-client.js'

function getLegalConfig() {
  const { coreConfig } = sdk.assembly()
  return {
    baseURL: coreConfig.baseURL,
    namespace: coreConfig.namespace,
  }
}

function getAccessToken() {
  return sdk.getToken()?.accessToken || ''
}

function getAuthHeaders() {
  const accessToken = getAccessToken()
  if (!accessToken) return null
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
}

function pickLocalizedVersion(version) {
  const localizedVersions = Array.isArray(version?.localizedPolicyVersions) ? version.localizedPolicyVersions : []
  return localizedVersions.find(item => item?.isDefaultSelection) || localizedVersions[0] || null
}

function mapEligibilityToDocument(entry) {
  const versions = Array.isArray(entry?.policyVersions) ? entry.policyVersions : []
  const activeVersion = versions.find(version => version?.isInEffect) || versions[0] || null
  const localizedVersion = pickLocalizedVersion(activeVersion)
  if (!activeVersion || !localizedVersion?.id) return null

  return {
    countryCode: entry.countryCode || '',
    description: entry.description || '',
    isMandatory: !!entry.isMandatory,
    localeCode: localizedVersion.localeCode || '',
    localizedPolicyVersionId: localizedVersion.id,
    policyId: entry.policyId,
    policyName: entry.policyName || 'Legal document',
    policyType: entry.policyType || '',
    policyVersionDisplay: activeVersion.displayVersion || '',
    policyVersionId: activeVersion.id,
  }
}

export async function fetchPendingLegalDocuments() {
  const headers = getAuthHeaders()
  if (!headers) return { ok: true, documents: [] }

  const { baseURL, namespace } = getLegalConfig()

  try {
    const resp = await fetch(`${baseURL}/agreement/public/eligibilities/namespaces/${namespace}`, {
      method: 'GET',
      headers: {
        Authorization: headers.Authorization,
      },
      credentials: 'include',
    })

    const payload = await resp.json().catch(() => [])
    if (!resp.ok) {
      return { ok: false, error: payload?.errorMessage || payload?.message || 'Could not load legal documents.', documents: [] }
    }

    const documents = Array.isArray(payload)
      ? payload
          .filter(entry => entry && entry.isAccepted === false && entry.isMandatory === true)
          .map(mapEligibilityToDocument)
          .filter(Boolean)
      : []

    return { ok: true, documents }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not load legal documents.', documents: [] }
  }
}

export async function acceptLegalDocuments(documents) {
  const headers = getAuthHeaders()
  if (!headers) {
    return { ok: false, error: 'Your session expired before the legal documents could be accepted.' }
  }

  const acceptedPolicies = Array.isArray(documents)
    ? documents.map(doc => ({
        isAccepted: true,
        localizedPolicyVersionId: doc.localizedPolicyVersionId,
        policyId: doc.policyId,
        policyVersionId: doc.policyVersionId,
      }))
    : []

  if (acceptedPolicies.length === 0) {
    return { ok: true, comply: true }
  }

  const { baseURL } = getLegalConfig()

  try {
    const resp = await fetch(`${baseURL}/agreement/public/agreements/policies`, {
      method: 'POST',
      headers,
      body: JSON.stringify(acceptedPolicies),
      credentials: 'include',
    })

    const payload = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return { ok: false, error: payload?.errorMessage || payload?.message || 'Could not accept the legal documents.' }
    }

    return { ok: true, comply: payload?.comply !== false }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not accept the legal documents.' }
  }
}

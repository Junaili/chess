export function pickLocalizedVersion(version) {
  const localizedVersions = Array.isArray(version?.localizedPolicyVersions)
    ? version.localizedPolicyVersions
    : []
  return localizedVersions.find(item => item?.isDefaultSelection) || localizedVersions[0] || null
}

export function mapEligibilityToDocument(entry) {
  const versions = Array.isArray(entry?.policyVersions) ? entry.policyVersions : []
  const activeVersion = versions.find(version => version?.isInEffect) || versions[0] || null
  const localizedVersion = pickLocalizedVersion(activeVersion)
  if (!activeVersion?.id || !localizedVersion?.id || !entry?.policyId) return null

  return {
    baseUrls: Array.isArray(entry.baseUrls) ? entry.baseUrls : [],
    countryCode: entry.countryCode || '',
    description: entry.description || '',
    isMandatory: entry.isMandatory === true,
    localeCode: localizedVersion.localeCode || '',
    localizedPolicyVersionId: localizedVersion.id,
    contentType: localizedVersion.contentType || '',
    attachmentLocation: localizedVersion.attachmentLocation || '',
    policyId: entry.policyId,
    policyName: entry.policyName || 'Legal document',
    policyType: entry.policyType || '',
    policyVersionDisplay: activeVersion.displayVersion || '',
    policyVersionId: activeVersion.id,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
  }
}

export function mapAcceptedAgreement(entry) {
  if (!entry || entry.isAccepted === false) return null
  const localized = entry.localizedPolicyVersion || {}
  const localizedPolicyVersionId = localized.id || entry.localizedPolicyVersionId || ''
  if (!localizedPolicyVersionId) return null

  return {
    acceptedAt: entry.signingDate || entry.updatedAt || entry.createdAt || '',
    attachmentLocation: localized.attachmentLocation || entry.attachmentLocation || '',
    contentType: localized.contentType || entry.contentType || '',
    description:
      localized.description ||
      entry.localizedDescription ||
      entry.description ||
      '',
    localeCode: localized.localeCode || entry.localeCode || '',
    localizedPolicyVersionId,
    policyId: entry.policyId || '',
    policyName: entry.policyName || 'Legal document',
    policyType: entry.policyType || '',
    policyVersionDisplay: entry.displayVersion || entry.policyVersionDisplay || '',
    policyVersionId: entry.policyVersionId || '',
    tags: Array.isArray(entry.tags) ? entry.tags : [],
  }
}

export function normalizeDocumentLocation(location, baseURL) {
  if (!location || typeof location !== 'string') return ''
  try {
    const url = new URL(location, baseURL
      ? `${String(baseURL).replace(/\/+$/, '')}/`
      : undefined)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch {
    return ''
  }
}

export function rowsFromLegalPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

export function buildAcceptedPolicies(documents) {
  if (!Array.isArray(documents)) return []
  return documents
    .map(document => ({
      isAccepted: true,
      localizedPolicyVersionId: String(document?.localizedPolicyVersionId || '').trim(),
      policyId: String(document?.policyId || '').trim(),
      policyVersionId: String(document?.policyVersionId || '').trim(),
    }))
    .filter(document =>
      document.localizedPolicyVersionId &&
      document.policyId &&
      document.policyVersionId,
    )
}

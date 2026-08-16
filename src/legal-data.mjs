function normalizedLocale(value) {
  return String(value || '').trim().replace(/_/g, '-').toLowerCase()
}

export function pickLocalizedVersion(version, preferredLocale = '') {
  const localizedVersions = Array.isArray(version?.localizedPolicyVersions)
    ? version.localizedPolicyVersions
    : []
  const preferred = normalizedLocale(preferredLocale)
  if (preferred) {
    const exact = localizedVersions.find(item => normalizedLocale(item?.localeCode) === preferred)
    if (exact) return exact
    const preferredLanguage = preferred.split('-')[0]
    const languageMatch = localizedVersions.find(item =>
      normalizedLocale(item?.localeCode).split('-')[0] === preferredLanguage,
    )
    if (languageMatch) return languageMatch
  }
  return localizedVersions.find(item => item?.isDefaultSelection) || localizedVersions[0] || null
}

export function mapEligibilityToDocument(entry, preferredLocale = '') {
  const versions = Array.isArray(entry?.policyVersions) ? entry.policyVersions : []
  const activeVersion = versions.find(version => version?.isInEffect) || versions[0] || null
  const localizedVersion = pickLocalizedVersion(activeVersion, preferredLocale)
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

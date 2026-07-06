import { sdk } from './ags-client.js'
import {
  buildAcceptedPolicies,
  mapAcceptedAgreement,
  mapEligibilityToDocument,
  normalizeDocumentLocation,
  rowsFromLegalPayload,
} from './legal-data.mjs'

const ACCEPT_RETRY_DELAYS_MS = [0, 750, 1500]

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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function hydrateLegalDocument(document, baseURL, namespace, authorization) {
  if (document.attachmentLocation) {
    const attachmentLocation = normalizeDocumentLocation(
      document.attachmentLocation,
      document.baseUrls?.[0],
    )
    if (attachmentLocation) {
      return {
        ...document,
        attachmentLocation,
        loadError: '',
      }
    }
  }

  try {
    const resp = await fetch(
      `${baseURL}/agreement/public/namespaces/${encodeURIComponent(namespace)}/localized-policy-versions/${encodeURIComponent(document.localizedPolicyVersionId)}`,
      {
        method: 'GET',
        headers: authorization ? { Authorization: authorization } : {},
        credentials: 'include',
      },
    )
    const payload = await resp.json().catch(() => ({}))
    if (!resp.ok) throw new Error(payload?.errorMessage || payload?.message || 'Document unavailable.')
    const localized = payload?.localizedPolicyVersion || payload
    const attachmentLocation = normalizeDocumentLocation(
      localized?.attachmentLocation,
      localized?.baseUrls?.[0] || document.baseUrls?.[0] || baseURL,
    )
    return {
      ...document,
      description: localized?.description || document.description,
      localeCode: localized?.localeCode || document.localeCode,
      contentType: localized?.contentType || document.contentType,
      attachmentLocation,
      loadError: attachmentLocation ? '' : 'This document has no published attachment.',
    }
  } catch (error) {
    return {
      ...document,
      loadError: error?.message || 'This document could not be loaded.',
    }
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

    const documents = rowsFromLegalPayload(payload)
      .filter(entry => entry && entry.isAccepted === false && entry.isMandatory === true)
      .map(mapEligibilityToDocument)
      .filter(Boolean)

    const hydrated = await Promise.all(
      documents.map(document =>
        hydrateLegalDocument(document, baseURL, namespace, headers.Authorization),
      ),
    )
    return { ok: true, documents: hydrated }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not load legal documents.', documents: [] }
  }
}

export async function fetchAcceptedLegalDocuments() {
  const headers = getAuthHeaders()
  if (!headers) return { ok: true, documents: [] }

  const { baseURL, namespace } = getLegalConfig()
  try {
    const resp = await fetch(`${baseURL}/agreement/public/agreements/policies`, {
      method: 'GET',
      headers: {
        Authorization: headers.Authorization,
      },
      credentials: 'include',
    })
    const payload = await resp.json().catch(() => [])
    if (!resp.ok) {
      return {
        ok: false,
        error: payload?.errorMessage || payload?.message || 'Could not load accepted legal documents.',
        documents: [],
      }
    }

    const documents = rowsFromLegalPayload(payload)
      .map(mapAcceptedAgreement)
      .filter(Boolean)
    const hydrated = await Promise.all(
      documents.map(document =>
        hydrateLegalDocument(document, baseURL, namespace, headers.Authorization),
      ),
    )
    return { ok: true, documents: hydrated }
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Could not load accepted legal documents.',
      documents: [],
    }
  }
}

export async function fetchLegalAttachment(document) {
  const location = normalizeDocumentLocation(document?.attachmentLocation)
  if (!location) {
    return { ok: false, error: 'This document does not have a valid published attachment.' }
  }

  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      const { CapacitorHttp } = await import('@capacitor/core')
      const response = await CapacitorHttp.get({
        url: location,
        headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5' },
        responseType: 'text',
      })
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: 'The document could not be loaded. Check your connection and try again.' }
      }
      const text = typeof response.data === 'string' ? response.data : String(response.data || '')
      if (!text.trim()) return { ok: false, error: 'The published document is empty.' }
      return { ok: true, text }
    }

    const response = await fetch(location, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5' },
    })
    if (!response.ok) {
      return { ok: false, error: 'The document could not be loaded. Check your connection and try again.' }
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || ''
    if (contentType.includes('application/pdf')) {
      return { ok: false, reason: 'unsupported', error: 'This document format cannot be displayed in the in-app reader.' }
    }

    const text = await response.text()
    if (!text.trim()) return { ok: false, error: 'The published document is empty.' }
    return { ok: true, text }
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      error: 'The document could not be loaded in the app. Check your connection and try again.',
    }
  }
}

export async function acceptLegalDocuments(documents) {
  const headers = getAuthHeaders()
  if (!headers) {
    return { ok: false, error: 'Your session expired before the legal documents could be accepted.' }
  }

  const acceptedPolicies = buildAcceptedPolicies(documents)

  if (acceptedPolicies.length === 0) {
    return { ok: true, comply: true }
  }

  const { baseURL } = getLegalConfig()

  let lastError = 'Could not accept the legal documents.'
  for (let attempt = 0; attempt < ACCEPT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (ACCEPT_RETRY_DELAYS_MS[attempt]) {
      await wait(ACCEPT_RETRY_DELAYS_MS[attempt])
    }
    try {
      const resp = await fetch(`${baseURL}/agreement/public/agreements/policies`, {
        method: 'POST',
        headers,
        body: JSON.stringify(acceptedPolicies),
        credentials: 'include',
      })
      const payload = await resp.json().catch(() => ({}))
      if (resp.ok) {
        return { ok: true, comply: payload?.comply !== false }
      }
      lastError =
        payload?.errorMessage ||
        payload?.message ||
        'Could not accept the legal documents.'
      if (resp.status !== 429 && resp.status < 500) break
    } catch (error) {
      lastError = error?.message || lastError
    }
  }
  return { ok: false, error: lastError }
}

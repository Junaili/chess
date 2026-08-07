import { extendFetch } from './extend-client.js'
import { reauthorizeAppleForDeletion } from './auth.js'
import {
  buildDeletionRequest,
  validateDeletionConfirmation,
} from './account-deletion-contract.mjs'

export { validateDeletionConfirmation }

async function parseResponse(response, fallback) {
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || fallback)
    error.code = payload?.error || ''
    error.status = response.status
    throw error
  }
  return payload
}

export async function fetchDeletionRequirements() {
  const response = await extendFetch('/account/deletion-requirements', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  return parseResponse(response, 'Could not check account deletion requirements.')
}

export async function submitAccountDeletion({
  confirmation, appleAuthorizationCode = '', password = '', platformId = '', platformToken = '',
}) {
  const payload = buildDeletionRequest({
    confirmation, appleAuthorizationCode, password, platformId, platformToken,
  })
  const response = await extendFetch('/account/deletion', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  return parseResponse(response, 'Account deletion was not accepted. Your account was not deleted.')
}

// A submitted deletion sits in an AGS grace period before anything is erased.
// These let the profile show "deletion scheduled" and offer a way back, instead
// of going silent after the request.
export async function fetchDeletionStatus() {
  const response = await extendFetch('/account/deletion', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  return parseResponse(response, 'Could not check your account status.')
}

export async function cancelAccountDeletion() {
  const response = await extendFetch('/account/deletion', {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  })
  return parseResponse(response, 'Could not cancel the deletion. Try again.')
}

// Returns { appleAuthorizationCode, platformToken } — the code is spent on
// revoking the Apple grant, the identity token authenticates the deletion
// itself (Apple accounts have no password).
export async function authorizeAppleDeletionIfRequired(requirements) {
  if (!requirements?.appleReauthorizationRequired) return {}
  const result = await reauthorizeAppleForDeletion()
  if (!result.ok) throw new Error(result.error || 'Apple reauthorization failed.')
  return {
    appleAuthorizationCode: result.authorizationCode,
    platformId: 'apple',
    platformToken: result.identityToken || '',
  }
}

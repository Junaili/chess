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

export async function submitAccountDeletion({ confirmation, appleAuthorizationCode = '' }) {
  const payload = buildDeletionRequest({ confirmation, appleAuthorizationCode })
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

export async function authorizeAppleDeletionIfRequired(requirements) {
  if (!requirements?.appleReauthorizationRequired) return ''
  const result = await reauthorizeAppleForDeletion()
  if (!result.ok) throw new Error(result.error || 'Apple reauthorization failed.')
  return result.authorizationCode
}

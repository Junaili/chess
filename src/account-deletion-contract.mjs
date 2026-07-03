export function validateDeletionConfirmation(value) {
  return String(value || '') === 'DELETE'
}

export function buildDeletionRequest({ confirmation, appleAuthorizationCode = '' }) {
  if (!validateDeletionConfirmation(confirmation)) {
    throw new Error('Type DELETE to confirm account deletion.')
  }
  return {
    confirmation,
    ...(appleAuthorizationCode ? { appleAuthorizationCode } : {}),
  }
}

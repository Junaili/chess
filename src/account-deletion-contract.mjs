export function validateDeletionConfirmation(value) {
  return String(value || '') === 'DELETE'
}

// AGS returns the zero time for "no date recorded" rather than omitting it, so
// a naive render would tell the player their account is being deleted in year 1.
const ZERO_TIMESTAMP_YEAR = '0001'

// describePendingDeletion turns the deletion-status payload into the copy the
// profile shows. Returns null when nothing is scheduled.
export function describePendingDeletion(status, now = new Date()) {
  if (!status?.pending) return null

  const raw = String(status.executionDate || '')
  const parsed = raw && !raw.startsWith(ZERO_TIMESTAMP_YEAR) ? new Date(raw) : null
  const valid = parsed && !Number.isNaN(parsed.getTime())
  if (!valid) {
    // Still tell them it is scheduled — an unparseable date is no reason to
    // hide a pending deletion.
    return { detail: 'Your account is scheduled for deletion.', executionDate: null, daysRemaining: null }
  }

  const days = Math.max(0, Math.ceil((parsed.getTime() - now.getTime()) / 86_400_000))
  const when = parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  const detail = days > 0
    ? `Your account and game data are scheduled for deletion on ${when} (${days} day${days === 1 ? '' : 's'} away). You can still keep your account until then.`
    : `Your account and game data are scheduled for deletion on ${when}.`
  return { detail, executionDate: parsed.toISOString(), daysRemaining: days }
}

// Player credentials travel with the request so AGS can authenticate the
// deletion as the player rather than as this service — the service's own admin
// grant is not something we can rely on.
export function buildDeletionRequest({
  confirmation, appleAuthorizationCode = '', password = '', platformId = '', platformToken = '',
}) {
  if (!validateDeletionConfirmation(confirmation)) {
    throw new Error('Type DELETE to confirm account deletion.')
  }
  return {
    confirmation,
    ...(appleAuthorizationCode ? { appleAuthorizationCode } : {}),
    ...(password ? { password } : {}),
    ...(platformId ? { platformId } : {}),
    ...(platformToken ? { platformToken } : {}),
  }
}

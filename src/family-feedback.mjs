// Pure helpers for the Family (AGS Group v2) flows — no network, no DOM, so
// they're unit-testable in isolation. Mirrors friend-feedback.mjs's role for
// the Friends flows: translate raw AGS responses into stable, player-facing
// messages instead of leaking backend internals.

// family.js uses raw fetch (no SDK package exists for the Group service), so
// errors arrive as { status, data } rather than axios error objects.
export function normalizeFamilyError(status, data, fallback = 'Something went wrong. Please try again.') {
  const code = data?.errorCode
  if (status === 401) {
    return { reason: 'authentication', error: 'Your session expired. Sign in again to manage your family.' }
  }
  if (status === 403) {
    // 73036: insufficient member role permission — e.g. a child trying to invite.
    return {
      reason: 'not_allowed',
      error: code === 73036
        ? 'Only a guardian can do that.'
        : 'You do not have permission to do that.',
    }
  }
  if (status === 404) {
    return { reason: 'not_found', error: 'That family or invitation no longer exists.' }
  }
  if (status === 409) {
    // 73342: user already joined group.
    return {
      reason: 'already_in_family',
      error: code === 73342
        ? 'This player is already in a family.'
        : 'That request conflicts with an existing family membership.',
    }
  }
  if (status === 429) {
    return { reason: 'rate_limited', error: 'Too many requests. Wait a moment and try again.' }
  }
  if (status >= 500) {
    return { reason: 'unavailable', error: 'The family service is unavailable right now. Try again shortly.' }
  }
  return { reason: 'unknown', error: fallback }
}

// AGS reports "not in any group" as an error (404/403 with code 73034) on
// several read endpoints — for us that's a normal empty state, not a failure.
export function isNotInGroupResponse(status, data) {
  return (status === 404 || status === 403) && data?.errorCode === 73034
}

// A member's roles arrive as an array of role IDs; resolve to our two known
// role names via the public roles catalog. Guardian wins if somehow both are
// present; unknown IDs fall back to 'child' (least privilege for display).
export function resolveMemberRole(memberRoleIds, rolesById) {
  const names = (memberRoleIds || []).map(id => rolesById[id]).filter(Boolean)
  if (names.includes('guardian')) return 'guardian'
  if (names.includes('child')) return 'child'
  return 'child'
}

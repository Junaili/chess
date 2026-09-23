export function buildUsername(displayName, emailAddress, randomBytes = null) {
  const source = (displayName || String(emailAddress || '').split('@')[0] || 'player').toLowerCase()
  let base = source.replace(/[^a-z0-9]+/g, '')
  if (!base) base = 'player'
  if (!/^[a-z]/.test(base)) base = `player${base}`

  const bytes = randomBytes || crypto.getRandomValues(new Uint8Array(4))
  const suffix = Array.from(bytes, byte => byte.toString(36).padStart(2, '0')).join('').slice(0, 6)
  return `${base.slice(0, 26)}${suffix}`.slice(0, 32)
}

// Apple's Sign in with Apple errors arrive from
// @capacitor-community/apple-sign-in as a raw NSError. The ASAuthorizationError
// number is usually only present inside its description, so fall back to reading
// it from there when the plugin gives us no structured code.
//
// 1001 is `canceled` - the player backed out of Apple's sheet. Callers must
// treat that as a choice rather than a failure: App Review rejected build 1
// under guideline 2.1(a) for showing "error message displayed when we attempted
// to Sign in with Apple", which is what an alert on cancellation looks like.
export const APPLE_ERROR_CANCELED = 1001

export function appleAuthorizationCode(error) {
  const code = Number(error?.code)
  if (Number.isInteger(code)) return code
  const match = /AuthorizationError error (\d+)/i.exec(String(error?.message || ''))
  return match ? Number(match[1]) : null
}

export function isAppleCancellation(error) {
  return appleAuthorizationCode(error) === APPLE_ERROR_CANCELED
}

// AGS refuses sign-in once an account deletion has been submitted, but the two
// login endpoints word it differently and neither is fit to show a player.
// /iam/v3/oauth/token returns "Admin deactivate user account cause request
// deletion account"; the platform route returns a bare "Forbidden" with
// error "access_denied". Both are 403.
//
// Showing raw upstream text here is the same fault App Review reported under
// guideline 2.1(a), and this is the exact flow a reviewer exercises when
// checking that account deletion worked (5.1.1(v)).
export const SIGN_IN_BLOCKED_MESSAGE =
  'This account can no longer sign in. If you deleted your account, that is expected.'

export function isSignInBlocked(status, payload) {
  if (status === 403) return true
  // Belt and braces: catch the deletion wording whatever status carries it.
  const text = [payload?.error_description, payload?.message, payload?.error]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return /deactivat|deletion|deleted/.test(text)
}

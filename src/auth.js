import { IamUserAuthorizationClient, OAuth20ExtensionApi, UsersApi } from '@accelbyte/sdk-iam'
import { sdk } from './ags-client.js'
import { isQueueTicket, runLoginQueue } from './login-queue.js'
import { getDeviceId } from './anon-id.js'
import { moderateIncomingDisplayName, validateDisplayNameLocally } from './content-moderation.mjs'
import { buildUsername } from './auth-data.mjs'
import { buildChildEmailAlias, childDateOfBirth } from './family-safety.mjs'

// True when running inside the Capacitor native shell (iOS app), where the
// app is served from capacitor://localhost and in-WebView OAuth redirects are
// blocked. Login must go through the system browser + custom URL scheme.
function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
}

// Custom URL scheme the iOS app is registered for (see Info.plist). The system
// browser bounces the OAuth result here, which iOS routes back to the app.
const NATIVE_RETURN_PATH = '__native__'
const DEVICE_NAME_KEY = 'ags_device_name'
const SESSION_FLAG = 'ags_session'
const REFRESH_TOKEN_KEY = 'ags_refresh_token'

function getAuthConfig() {
  const { coreConfig } = sdk.assembly()
  return {
    baseURL: coreConfig.baseURL,
    clientId: coreConfig.clientId,
    namespace: coreConfig.namespace,
  }
}

function clearTransientSessionState() {
  sessionStorage.removeItem('ags_pre_login_search')
  sessionStorage.removeItem(SESSION_FLAG)
  sessionStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(SESSION_FLAG)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  sdk.setToken({ accessToken: '', refreshToken: '' })
}

function clearAuthCallbackUrl(preSearch = '') {
  window.history.replaceState({}, '', window.location.pathname + (preSearch || ''))
}

function setSession(tokenData) {
  sdk.setToken({
    accessToken: tokenData.access_token || '',
    refreshToken: tokenData.refresh_token || '',
  })
  if (tokenData.access_token) {
    // Keep refresh tokens out of localStorage. Browser sessions can refresh
    // during the current tab/app session, but a full browser/app restart must
    // reauthenticate unless the platform supplies HttpOnly auth cookies.
    sessionStorage.setItem(SESSION_FLAG, '1')
    if (tokenData.refresh_token) {
      sessionStorage.setItem(REFRESH_TOKEN_KEY, tokenData.refresh_token)
    }
    localStorage.removeItem(SESSION_FLAG)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
  }
}

export function hasStoredSession() {
  // Remove legacy persisted session markers opportunistically. Their presence
  // should not keep a user signed in after this hardening change.
  localStorage.removeItem(SESSION_FLAG)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  return !!sessionStorage.getItem(SESSION_FLAG)
}

export function clearStoredSession() {
  sessionStorage.removeItem(SESSION_FLAG)
  sessionStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(SESSION_FLAG)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

function getRefreshToken() {
  return sdk.getToken()?.refreshToken || sessionStorage.getItem(REFRESH_TOKEN_KEY) || ''
}

function extractErrorMessage(payload, fallback) {
  if (!payload) return fallback
  return payload.errorMessage || payload.error_description || payload.message || payload.error || fallback
}

// If a login response was held by the AGS login queue (HTTP 401 + queue ticket
// body), wait out the queue and return the resulting token. Returns:
//   { queued: false }                — not a queue response; handle normally
//   { token }                        — admitted; caller should setSession(token)
//   { cancelled: true } | { error }  — queue ended without a token
async function resolveLoginQueue(resp, payload) {
  if (resp.status !== 401 || !isQueueTicket(payload)) return { queued: false }
  const { baseURL, clientId } = getAuthConfig()
  return runLoginQueue(payload, { baseURL, authHeader: `Basic ${btoa(clientId + ':')}` })
}

function getDeviceName() {
  let name = localStorage.getItem(DEVICE_NAME_KEY)
  if (!name) {
    const platform = navigator.platform || 'browser'
    const agent = navigator.userAgentData?.platform || platform
    name = `Ethan Chess on ${agent}`.slice(0, 64)
    localStorage.setItem(DEVICE_NAME_KEY, name)
  }
  return name
}

function inferCountryCode() {
  const locale = navigator.language || 'en-US'
  const region = locale.split('-')[1]
  return /^[A-Za-z]{2}$/.test(region || '') ? region.toUpperCase() : 'US'
}

// "Sign in with Google" goes straight to Google (id_token implicit flow) on both
// web and native — the button promises Google, and AGS's hosted login page can't
// be skipped without an existing session. Native marks its state so the redirect
// page (native-auth-bounce.js) forwards the id_token to the app's custom scheme;
// web uses a distinct state so the bounce ignores it and the page handles it.
const GOOGLE_NATIVE_STATE = 'ethanschess_native_google'
const GOOGLE_WEB_STATE = 'ethanschess_web_google'
const GOOGLE_NONCE_KEY = 'ags_google_nonce'

function buildGoogleLoginUrl(state) {
  const nonce = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('')
  sessionStorage.setItem(GOOGLE_NONCE_KEY, nonce)
  const params = new URLSearchParams({
    client_id: import.meta.env.VITE_ACCELBYTE_GOOGLE_CLIENT_ID,
    redirect_uri: import.meta.env.VITE_ACCELBYTE_REDIRECT_URI || (window.location.origin + import.meta.env.BASE_URL),
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce,
    state,
    prompt: 'select_account',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export async function loginWithGoogle() {
  if (window.location.search) {
    sessionStorage.setItem('ags_pre_login_search', window.location.search)
  }

  if (isNativeApp()) {
    const { Browser } = await import('@capacitor/browser')
    await Browser.open({ url: buildGoogleLoginUrl(GOOGLE_NATIVE_STATE) })
    return
  }

  window.location.assign(buildGoogleLoginUrl(GOOGLE_WEB_STATE))
}

export async function handleCallback(callbackUrl = null) {
  let parsed
  try {
    parsed = new URL(callbackUrl || window.location.href)
  } catch {
    return null
  }
  if (callbackUrl && (parsed.protocol !== 'io.github.junaili.chess:' || parsed.pathname !== '/oauth2redirect')) {
    return null
  }

  // Google login returns an id_token (implicit flow). Native forwards it as a
  // query param via the bounce page; web receives it in the URL fragment.
  const hashParams = new URLSearchParams((parsed.hash || '').replace(/^#/, ''))
  const idToken = parsed.searchParams.get('id_token') || hashParams.get('id_token')
  const googleState = parsed.searchParams.get('state') || hashParams.get('state')
  if (idToken || googleState === GOOGLE_NATIVE_STATE || googleState === GOOGLE_WEB_STATE) {
    const pre = sessionStorage.getItem('ags_pre_login_search')
    sessionStorage.removeItem('ags_pre_login_search')
    const result = await exchangeGoogleIdToken(idToken)
    if (!callbackUrl) clearAuthCallbackUrl(pre || '')
    return result
  }

  const code = parsed.searchParams.get('code')
  const error = parsed.searchParams.get('error')
  const state = parsed.searchParams.get('state')
  if (!code && !error) return null
  const pre = sessionStorage.getItem('ags_pre_login_search')
  sessionStorage.removeItem('ags_pre_login_search')

  try {
    const auth = new IamUserAuthorizationClient(sdk)
    const result = await auth.exchangeAuthorizationCode({ code, error, state })
    const tokenData = result?.response?.data
    if (!tokenData?.access_token) throw new Error('Authorization code exchange returned no access token.')
    setSession(tokenData)
    if (!callbackUrl) clearAuthCallbackUrl(pre || '')
    return { response: { data: tokenData } }
  } catch (e) {
    console.error('[AGS] authorization code exchange failed:', e?.message || e)
    clearTransientSessionState()
    if (!callbackUrl) clearAuthCallbackUrl(pre || '')
    return null
  }
}

function decodeJwtPayload(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64))
  } catch {
    return null
  }
}

// Verifies the Google id_token nonce, then exchanges it for an AGS token via
// the platform-token endpoint (AGS validates the id_token against Google).
async function exchangeGoogleIdToken(idToken) {
  const storedNonce = sessionStorage.getItem(GOOGLE_NONCE_KEY)
  sessionStorage.removeItem(GOOGLE_NONCE_KEY)
  if (!idToken) {
    clearTransientSessionState()
    return null
  }
  const payload = decodeJwtPayload(idToken)
  if (!payload || !storedNonce || payload.nonce !== storedNonce) {
    console.error('[AGS] Google id_token nonce mismatch — ignoring')
    clearTransientSessionState()
    return null
  }
  const { baseURL, clientId } = getAuthConfig()
  try {
    const resp = await fetch(`${baseURL}/iam/v3/oauth/platforms/google/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(clientId + ':')}`,
      },
      body: new URLSearchParams({ platform_token: idToken }).toString(),
      credentials: 'include',
    })
    const tokenData = await resp.json().catch(() => ({}))
    if (!resp.ok || !tokenData?.access_token) {
      const queued = await resolveLoginQueue(resp, tokenData)
      if (queued.token) {
        setSession(queued.token)
        return { response: { data: queued.token } }
      }
      if (!queued.cancelled) {
        console.error('[AGS] Google platform-token exchange failed:', resp.status, tokenData)
      }
      clearTransientSessionState()
      return null
    }
    setSession(tokenData)
    return { response: { data: tokenData } }
  } catch (e) {
    console.error('[AGS] Google platform-token exchange threw:', e?.message || e)
    clearTransientSessionState()
    return null
  }
}

// Native "Sign in with Apple" (iOS). Uses Apple's AuthenticationServices via the
// Capacitor plugin to get an identity token, then exchanges it for an AGS token.
// REQUIRES (App Store): the "Sign in with Apple" capability in Xcode, an Apple
// Services ID/key in the Apple Developer portal, and Apple configured as a 3rd-
// party platform in AGS IAM. Web Sign in with Apple needs a server endpoint
// (Apple uses form_post), so it's offered on iOS only.
export async function loginWithApple() {
  if (!isNativeApp()) {
    return { ok: false, error: 'Sign in with Apple is available in the iOS app.' }
  }
  try {
    const { SignInWithApple } = await import('@capacitor-community/apple-sign-in')
    const result = await SignInWithApple.authorize({
      clientId: import.meta.env.VITE_ACCELBYTE_APPLE_CLIENT_ID || 'io.github.junaili.chess',
      redirectURI: import.meta.env.VITE_ACCELBYTE_REDIRECT_URI || 'https://junaili.github.io/chess/',
      scopes: 'email name',
    })
    const identityToken = result?.response?.identityToken
    if (!identityToken) return { ok: false, error: 'Apple sign-in returned no token.' }

    const { baseURL, clientId } = getAuthConfig()
    const resp = await fetch(`${baseURL}/iam/v3/oauth/platforms/apple/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(clientId + ':')}`,
      },
      body: new URLSearchParams({ platform_token: identityToken }).toString(),
      credentials: 'include',
    })
    const tokenData = await resp.json().catch(() => ({}))
    if (!resp.ok || !tokenData?.access_token) {
      const queued = await resolveLoginQueue(resp, tokenData)
      if (queued.token) {
        setSession(queued.token)
        return { ok: true, data: queued.token }
      }
      if (queued.cancelled) return { ok: false, error: 'Sign-in cancelled.' }
      if (queued.error) return { ok: false, error: queued.error }
      console.error('[AGS] Apple platform-token exchange failed:', resp.status, tokenData)
      return { ok: false, error: extractErrorMessage(tokenData, 'Could not complete Apple sign-in.') }
    }
    setSession(tokenData)
    return { ok: true, data: tokenData }
  } catch (e) {
    // Plugin throws on user cancel and when the capability isn't configured yet.
    return { ok: false, error: e?.message || 'Apple sign-in was cancelled.' }
  }
}

// Account deletion for an Apple-linked user must revoke the Apple grant before
// AGS deletion is submitted. This obtains a fresh, one-time authorization code
// from AuthenticationServices but deliberately does not exchange it in the
// browser. The code is sent directly to the authenticated Extend endpoint.
export async function reauthorizeAppleForDeletion() {
  if (!isNativeApp()) {
    return { ok: false, error: 'Apple reauthorization is only available in the iOS app.' }
  }
  try {
    const { SignInWithApple } = await import('@capacitor-community/apple-sign-in')
    const result = await SignInWithApple.authorize({
      clientId: import.meta.env.VITE_ACCELBYTE_APPLE_CLIENT_ID || 'io.github.junaili.chess',
      redirectURI: import.meta.env.VITE_ACCELBYTE_REDIRECT_URI || 'https://junaili.github.io/chess/',
      scopes: 'email name',
    })
    const authorizationCode = result?.response?.authorizationCode
    if (!authorizationCode) {
      return { ok: false, error: 'Apple returned no authorization code. Your account was not deleted.' }
    }
    return { ok: true, authorizationCode }
  } catch (error) {
    return { ok: false, error: error?.message || 'Apple reauthorization was cancelled.' }
  }
}

export async function loginWithPassword(identifier, password) {
  const { baseURL, clientId } = getAuthConfig()
  try {
    const resp = await fetch(`${baseURL}/iam/v3/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(clientId + ':')}`,
        'Device-Id': getDeviceId(),
      },
      body: new URLSearchParams({
        grant_type: 'password',
        username: identifier,
        password,
      }).toString(),
      credentials: 'include',
    })

    const payload = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      const queued = await resolveLoginQueue(resp, payload)
      if (queued.token) {
        setSession(queued.token)
        return { ok: true, data: queued.token }
      }
      if (queued.cancelled) return { ok: false, error: 'Sign-in cancelled.' }
      if (queued.error) return { ok: false, error: queued.error }
      return { ok: false, error: extractErrorMessage(payload, 'Could not sign in with username and password.') }
    }

    setSession(payload)
    return { ok: true, data: payload }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not sign in with username and password.' }
  }
}

export async function requestPasswordReset(emailAddress) {
  const { baseURL, namespace } = getAuthConfig()
  try {
    const resp = await fetch(`${baseURL}/iam/v3/public/namespaces/${encodeURIComponent(namespace)}/users/forgot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        emailAddress,
        languageTag: navigator.language || 'en-US',
      }),
      credentials: 'include',
    })
    const payload = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return { ok: false, error: extractErrorMessage(payload, 'Could not send the reset code. Please try again.') }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not send the reset code. Please try again.' }
  }
}

export async function resetPassword({ emailAddress, code, newPassword }) {
  const { baseURL, clientId, namespace } = getAuthConfig()
  try {
    const resp = await fetch(`${baseURL}/iam/v3/public/namespaces/${encodeURIComponent(namespace)}/users/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId,
        code,
        emailAddress,
        languageTag: navigator.language || 'en-US',
        newPassword,
      }),
      credentials: 'include',
    })
    const payload = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return { ok: false, error: extractErrorMessage(payload, 'Could not reset your password. Check the code and try again.') }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not reset your password. Check the code and try again.' }
  }
}

export async function refreshSession() {
  const { baseURL, clientId } = getAuthConfig()
  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    return { ok: false, error: 'No refresh token available.' }
  }

  try {
    const resp = await fetch(`${baseURL}/iam/v3/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(clientId + ':')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      credentials: 'include',
    })

    const payload = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return { ok: false, error: extractErrorMessage(payload, 'Could not refresh your session.') }
    }

    setSession(payload)
    return { ok: true, data: payload }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not refresh your session.' }
  }
}

export async function registerWithPassword({ emailAddress, displayName, password, reachMinimumAge }) {
  if (reachMinimumAge !== true) {
    return { ok: false, error: 'Confirm that you meet the minimum age requirement.' }
  }
  const displayNameValidation = await validateDisplayName(displayName)
  if (!displayNameValidation.ok) return displayNameValidation
  displayName = displayNameValidation.value
  const { baseURL, namespace } = getAuthConfig()
  const payload = {
    authType: 'EMAILPASSWD',
    country: inferCountryCode(),
    emailAddress,
    displayName,
    uniqueDisplayName: displayName,
    password,
    reachMinimumAge,
    username: buildUsername(displayName, emailAddress),
  }

  try {
    const resp = await fetch(`${baseURL}/iam/v4/public/namespaces/${namespace}/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      credentials: 'include',
    })

    const body = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return { ok: false, error: extractErrorMessage(body, 'Could not create your account.') }
    }

    return { ok: true, data: body }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not create your account.' }
  }
}

// Parent-managed child account creation (COPPA flow). Called from the
// guardian's OWN signed-in session — registration is a plain unauthenticated
// POST, so the parent's session is untouched; the child signs in later on
// their own device. Three deliberate properties:
//  - the child's sign-in address is a plus-tag of the PARENT's mailbox, so
//    password resets and account mail always reach the consenting parent;
//  - dateOfBirth is Dec 31 of the birth year (family-safety.mjs), so any
//    age-based restriction lifts late, never early;
//  - the caller records a consent record on the parent's cloud record —
//    the parent performing this creation is the verifiable consent act.
export async function registerChildAccount({ parentEmail, nickname, birthYear, password }) {
  const emailAddress = buildChildEmailAlias(parentEmail, nickname)
  if (!emailAddress) {
    return { ok: false, error: 'Enter a valid parent email address for the child account.' }
  }
  const displayNameValidation = await validateDisplayName(nickname)
  if (!displayNameValidation.ok) return displayNameValidation
  const displayName = displayNameValidation.value
  const { baseURL, namespace } = getAuthConfig()
  const payload = {
    authType: 'EMAILPASSWD',
    country: inferCountryCode(),
    emailAddress,
    displayName,
    uniqueDisplayName: displayName,
    password,
    dateOfBirth: childDateOfBirth(birthYear),
    // Met through verifiable parental consent: the guardian creates the
    // account from their own session and holds the recovery mailbox.
    reachMinimumAge: true,
    username: buildUsername(displayName, emailAddress),
  }

  try {
    // No credentials on this request — it must not disturb the parent's
    // signed-in session cookies.
    const resp = await fetch(`${baseURL}/iam/v4/public/namespaces/${namespace}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return { ok: false, error: extractErrorMessage(body, 'Could not create the child account.') }
    }
    if (!body.userId) {
      return { ok: false, error: 'The child account was created but no player ID came back. Try refreshing.' }
    }
    return { ok: true, userId: body.userId, emailAddress, displayName }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not create the child account.' }
  }
}

export async function getProfile() {
  try {
    const res = await UsersApi(sdk).getUsersMe_v3()
    return res.data
  } catch {
    return null
  }
}

export function getDisplayName(profile) {
  const displayName = profile?.displayName || profile?.userName || profile?.emailAddress || ''
  return moderateIncomingDisplayName(displayName, 'Player')
}

export async function syncBasicProfile(displayName) {
  if (!displayName) return
  // Display names are sourced from IAM and the local leaderboard cache.
  // Avoid Basic profile writes here: AGS returns visible 404/409 responses for
  // profile upsert probes, which makes successful login look broken in DevTools.
}

export async function validateDisplayName(displayName) {
  const localResult = validateDisplayNameLocally(displayName)
  if (!localResult.ok) return localResult

  try {
    const response = await UsersApi(sdk).createUserInputValidation_v3({
      displayName: localResult.value,
      uniqueDisplayName: localResult.value,
    })
    if (response.data?.valid === false) {
      return {
        ok: false,
        error: response.data.message || 'Choose a display name without inappropriate language.',
      }
    }
  } catch (error) {
    // AGS validation is authoritative when available. Keep the local filter as
    // the offline fallback so temporary validation-service failures do not
    // prevent account creation or profile edits.
    console.warn('[AGS] display-name validation unavailable; using local filter:', error?.response?.status || error?.message)
  }

  return localResult
}

export async function updateDisplayName(displayName) {
  const validation = await validateDisplayName(displayName)
  if (!validation.ok) return validation

  try {
    const res = await UsersApi(sdk).patchUserMe_v3({ displayName: validation.value })
    return { ok: true, data: res.data }
  } catch (e) {
    console.error('[AGS] updateDisplayName:', e?.response?.data || e?.message)
    return {
      ok: false,
      error: extractErrorMessage(e?.response?.data, 'Could not update your display name.'),
    }
  }
}

export async function logout() {
  try {
    await OAuth20ExtensionApi(sdk).createLogout_v3()
  } catch (e) {
    console.warn('[AGS] logout:', e?.response?.data || e?.message)
  } finally {
    clearTransientSessionState()
    clearStoredSession()
    const cleanUrl = window.location.pathname + window.location.hash
    window.history.replaceState({}, '', cleanUrl)
    window.location.reload()
  }
}

export function clearLocalAccountData() {
  for (const storage of [localStorage, sessionStorage]) {
    const keys = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key && (key.startsWith('ags_') || key.startsWith('chess_') || key === 'authorized')) {
        keys.push(key)
      }
    }
    for (const key of keys) storage.removeItem(key)
  }
  sdk.setToken({ accessToken: '', refreshToken: '' })
}

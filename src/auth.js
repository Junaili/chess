import { IamUserAuthorizationClient, OAuth20ExtensionApi, UsersApi } from '@accelbyte/sdk-iam'
import { sdk } from './ags-client.js'

// True when running inside the Capacitor native shell (iOS app), where the
// app is served from capacitor://localhost and in-WebView OAuth redirects are
// blocked. Login must go through the system browser + custom URL scheme.
function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
}

// Custom URL scheme the iOS app is registered for (see Info.plist). The system
// browser bounces the OAuth result here, which iOS routes back to the app.
const NATIVE_RETURN_PATH = '__native__'
const DEVICE_ID_KEY = 'ags_device_id'
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
    // Persist across app restarts so the player stays logged in. The refresh
    // token lives in localStorage (app-sandboxed in the Capacitor WebView).
    localStorage.setItem(SESSION_FLAG, '1')
    if (tokenData.refresh_token) {
      localStorage.setItem(REFRESH_TOKEN_KEY, tokenData.refresh_token)
    }
  }
}

export function hasStoredSession() {
  return !!localStorage.getItem(SESSION_FLAG)
}

export function clearStoredSession() {
  sessionStorage.removeItem(SESSION_FLAG)
  sessionStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(SESSION_FLAG)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

function getRefreshToken() {
  return sdk.getToken()?.refreshToken || localStorage.getItem(REFRESH_TOKEN_KEY) || ''
}

function extractErrorMessage(payload, fallback) {
  if (!payload) return fallback
  return payload.errorMessage || payload.error_description || payload.message || payload.error || fallback
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID
      ? `chess-${crypto.randomUUID()}`
      : `chess-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
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

function buildUsername(displayName, emailAddress) {
  const source = (displayName || emailAddress.split('@')[0] || 'player').toLowerCase()
  let base = source.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!base) base = 'player'
  if (!/^[a-z]/.test(base)) base = 'player_' + base
  const randomBytes = crypto.getRandomValues(new Uint8Array(4))
  const suffix = Array.from(randomBytes, byte => byte.toString(36).padStart(2, '0')).join('').slice(0, 6)
  return (base.slice(0, 20) + '_' + suffix).slice(0, 32)
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
  const nonce = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
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
      console.error('[AGS] Google platform-token exchange failed:', resp.status, tokenData)
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
      return { ok: false, error: extractErrorMessage(payload, 'Could not sign in with username and password.') }
    }

    setSession(payload)
    return { ok: true, data: payload }
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not sign in with username and password.' }
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

export async function getProfile() {
  try {
    const res = await UsersApi(sdk).getUsersMe_v3()
    return res.data
  } catch {
    return null
  }
}

export function getDisplayName(profile) {
  return profile?.displayName || profile?.userName || profile?.emailAddress || ''
}

export async function syncBasicProfile(displayName) {
  if (!displayName) return
  // Display names are sourced from IAM and the local leaderboard cache.
  // Avoid Basic profile writes here: AGS returns visible 404/409 responses for
  // profile upsert probes, which makes successful login look broken in DevTools.
}

export async function updateDisplayName(displayName) {
  try {
    const res = await UsersApi(sdk).patchUserMe_v3({ displayName })
    return res.data
  } catch (e) {
    console.error('[AGS] updateDisplayName:', e?.response?.data || e?.message)
    return null
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

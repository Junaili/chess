import { OAuth20ExtensionApi, UsersApi } from '@accelbyte/sdk-iam'
import { sdk } from './ags-client.js'

const GOOGLE_FLAG = 'ags_google_login'
const DEVICE_ID_KEY = 'ags_device_id'
const DEVICE_NAME_KEY = 'ags_device_name'

function getAuthConfig() {
  const { coreConfig } = sdk.assembly()
  return {
    baseURL: coreConfig.baseURL,
    clientId: coreConfig.clientId,
    namespace: coreConfig.namespace,
  }
}

function clearTransientSessionState() {
  sessionStorage.removeItem(GOOGLE_FLAG)
  sessionStorage.removeItem('ags_pre_login_search')
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  sdk.setToken({ accessToken: '', refreshToken: '' })
}

function clearAuthCallbackUrl(preSearch = '') {
  window.history.replaceState({}, '', window.location.pathname + (preSearch || '') + window.location.hash)
}

function isPrivateIpHost(hostname) {
  if (!hostname) return false
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false
  if (/^10\./.test(hostname)) return true
  if (/^192\.168\./.test(hostname)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true
  return false
}

function getGoogleRedirectUri() {
  const currentOrigin = window.location.origin
  const currentHost = window.location.hostname
  if (currentOrigin && !isPrivateIpHost(currentHost)) {
    return currentOrigin + '/'
  }
  return import.meta.env.VITE_ACCELBYTE_REDIRECT_URI || 'https://localhost:8808/'
}

const SESSION_FLAG = 'ags_session'
const REFRESH_TOKEN_KEY = 'ags_refresh_token'

function setSession(tokenData) {
  sdk.setToken({
    accessToken: tokenData.access_token || '',
    refreshToken: tokenData.refresh_token || '',
  })
  if (tokenData.access_token) {
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
    id = 'chess-' + Math.random().toString(36).slice(2, 12)
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
  const suffix = Math.random().toString(36).slice(2, 6)
  return (base.slice(0, 20) + '_' + suffix).slice(0, 32)
}

export async function loginWithGoogle() {
  const redirectUri = getGoogleRedirectUri()
  const redirectHost = new URL(redirectUri).hostname
  if (isPrivateIpHost(redirectHost)) {
    alert('Google login cannot use a private IP redirect URI like ' + redirectUri + '. Use https://localhost:8808/ on this machine, or a public HTTPS domain/tunnel for shared-device testing.')
    return
  }

  if (window.location.search) {
    sessionStorage.setItem('ags_pre_login_search', window.location.search)
  }
  sessionStorage.setItem(GOOGLE_FLAG, '1')

  const params = new URLSearchParams({
    client_id: import.meta.env.VITE_ACCELBYTE_GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  })
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export async function handleCallback() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const error = params.get('error')

  if (!code && !error) return null

  const isGoogle = sessionStorage.getItem(GOOGLE_FLAG)
  sessionStorage.removeItem(GOOGLE_FLAG)

  const pre = sessionStorage.getItem('ags_pre_login_search')
  sessionStorage.removeItem('ags_pre_login_search')

  if (!isGoogle) {
    clearAuthCallbackUrl(pre || '')
    return null
  }

  const { coreConfig } = sdk.assembly()
  const redirectUri = getGoogleRedirectUri()
  let tokenData
  try {
    const resp = await fetch(
      `${coreConfig.baseURL}/iam/v3/oauth/platforms/google/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(coreConfig.clientId + ':')}`,
        },
        body: new URLSearchParams({
          platform_token: code,
          redirect_uri: redirectUri,
        }).toString(),
        credentials: 'include',
      }
    )
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      console.error('[AGS] platform exchange failed:', resp.status, err)
      clearTransientSessionState()
      clearAuthCallbackUrl(pre || '')
      return null
    }
    tokenData = await resp.json()
  } catch (e) {
    console.error('[AGS] platform exchange threw:', e)
    clearTransientSessionState()
    clearAuthCallbackUrl(pre || '')
    return null
  }

  clearAuthCallbackUrl(pre || '')
  setSession(tokenData)
  return { response: { data: tokenData } }
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

export async function registerWithPassword({ emailAddress, displayName, password }) {
  const { baseURL, namespace } = getAuthConfig()
  const payload = {
    authType: 'EMAILPASSWD',
    country: inferCountryCode(),
    emailAddress,
    displayName,
    uniqueDisplayName: displayName,
    password,
    reachMinimumAge: true,
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

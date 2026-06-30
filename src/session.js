import { sdk } from './ags-client.js'
import { refreshSession, hasStoredSession } from './auth.js'

// Keeps the AGS access token fresh so the player never sees a "token is expired"
// error — important on iOS/iPad, where the app is suspended in the background
// and the short-lived access token is long dead by the time the user returns.
//
// Three layers:
//   1. Reactive — an SDK response interceptor that, on any 401, refreshes the
//      session once and retries the original request transparently.
//   2. Proactive — a timer that refreshes shortly before the token expires.
//   3. Resume — refresh when the app/tab becomes active again (timers don't run
//      while a native app is suspended).

let refreshPromise = null
let refreshTimer = null
let installed = false

// Single-flight refresh: concurrent callers (interceptor, timer, resume) share
// one in-flight refresh instead of stampeding the token endpoint.
export function refreshOnce() {
  if (!refreshPromise) {
    refreshPromise = Promise.resolve(refreshSession()).finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

function accessTokenExpiryMs() {
  const token = sdk.getToken()?.accessToken
  if (!token) return 0
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

// (Re)schedule a proactive refresh ~60s before the access token expires.
export function scheduleProactiveRefresh() {
  clearTimeout(refreshTimer)
  if (!sdk.getToken()?.accessToken) return
  const expMs = accessTokenExpiryMs()
  // If we can't read exp, fall back to a conservative 10-minute cadence.
  const delay = expMs ? Math.max(5000, expMs - Date.now() - 60_000) : 600_000
  refreshTimer = setTimeout(async () => {
    if (sdk.getToken()?.accessToken || hasStoredSession()) await refreshOnce()
    scheduleProactiveRefresh()
  }, delay)
}

// Refresh immediately if the token is missing or expires within `withinMs`.
export async function refreshIfStale(withinMs = 120_000) {
  if (!sdk.getToken()?.accessToken && !hasStoredSession()) return
  const expMs = accessTokenExpiryMs()
  if (!expMs || expMs - Date.now() <= withinMs) {
    await refreshOnce()
    scheduleProactiveRefresh()
  }
}

// Install the reactive interceptor and resume/visibility hooks. Idempotent;
// call once, early, before any AGS SDK calls.
export function installSessionKeepAlive() {
  if (installed) return
  installed = true

  sdk.addInterceptors([{
    type: 'response',
    name: 'auth-refresh-retry',
    onError: async (error) => {
      const config = error?.config
      const status = error?.response?.status
      const url = (config && config.url) || ''
      // Only handle 401s, only retry once, and never recurse on the token
      // endpoint itself (refreshSession uses fetch, but stay safe regardless).
      if (status !== 401 || !config || config.__authRetried || url.includes('/iam/v3/oauth/token')) {
        throw error
      }
      const refreshed = await refreshOnce()
      if (!refreshed || !refreshed.ok) throw error
      config.__authRetried = true
      const token = sdk.getToken()?.accessToken
      if (token) {
        config.headers = config.headers || {}
        config.headers.Authorization = 'Bearer ' + token
      }
      scheduleProactiveRefresh()
      return sdk.assembly().axiosInstance.request(config)
    },
  }])

  // Web: refresh when the tab becomes visible / regains focus.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshIfStale()
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => refreshIfStale())
  }

  // Native iOS/iPad: refresh the moment the app comes back to the foreground,
  // before presence/friends/leaderboard calls fire against a dead token.
  if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
    import('@capacitor/app')
      .then(({ App }) => {
        App.addListener('appStateChange', ({ isActive }) => { if (isActive) refreshIfStale() })
        App.addListener('resume', () => refreshIfStale())
      })
      .catch(() => {})
  }
}

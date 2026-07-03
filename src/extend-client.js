import { sdk } from './ags-client.js'
import { refreshSession } from './auth.js'

const EXTEND_BASE = import.meta.env.VITE_EXTEND_EMAIL_URL || '/extend'

// Runs doRequest(); if it returns HTTP 401 (the AGS access token has expired),
// refreshes the session once and retries. Pure with respect to its injected
// deps so the retry behaviour is unit-testable without the SDK or network.
export async function withRefreshRetry(doRequest, refresh) {
  let res = await doRequest()
  if (res && res.status === 401) {
    const refreshed = await refresh()
    if (refreshed && refreshed.ok) {
      res = await doRequest()
    }
  }
  return res
}

// fetch() against the Extend service that attaches the current AGS access token
// and, on a 401, refreshes the session and retries once. The plain SDK calls
// auto-refresh on 401; these raw Extend calls didn't, so an expired token made
// friend lookup / invite / welcome / referral fail until a full reload.
export function extendFetch(path, options = {}) {
  const doRequest = () => {
    const token = sdk.getToken()?.accessToken
    const headers = { ...(options.headers || {}) }
    if (token) {
      const bearer = 'Bearer ' + token
      headers.Authorization = bearer
      // AGS ingress consumes the standard Authorization header before the
      // request reaches a Service Extension. Preserve the player token in an
      // app-specific header so the service can introspect and forward it.
      headers['X-Chess-Player-Authorization'] = bearer
    }
    return fetch(`${EXTEND_BASE}${path}`, { ...options, headers })
  }
  return withRefreshRetry(doRequest, refreshSession)
}

// Test seam: in dev / Playwright the dev server sets import.meta.env.DEV, so the
// pure retry helper is reachable for a deterministic regression test. Not
// exposed in production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__withRefreshRetry = withRefreshRetry
}

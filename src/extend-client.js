import { sdk } from './ags-client.js'
import { refreshSession } from './auth.js'
import { withRefreshRetry } from './http-retry.mjs'
import { fetchWithTimeout } from './network.mjs'

const EXTEND_BASE = import.meta.env.VITE_EXTEND_EMAIL_URL || '/extend'

export { withRefreshRetry }

// fetch() against the Extend service that attaches the current AGS access token
// and, on a 401, refreshes the session and retries once. The plain SDK calls
// auto-refresh on 401; these raw Extend calls didn't, so an expired token made
// friend lookup / invite / welcome / referral fail until a full reload.
export function extendFetch(path, options = {}) {
  const { timeoutMs = 50_000, ...fetchOptions } = options
  const doRequest = () => {
    const token = sdk.getToken()?.accessToken
    const headers = { ...(fetchOptions.headers || {}) }
    if (token) headers.Authorization = 'Bearer ' + token
    // AGS ingress consumes Authorization before forwarding to a deployed
    // Service Extension. IAM sets an HttpOnly access_token cookie during login,
    // which is the supported browser-auth fallback at the service boundary.
    return fetchWithTimeout(`${EXTEND_BASE}${path}`, {
      ...fetchOptions,
      credentials: 'include',
      headers,
    }, timeoutMs)
  }
  return withRefreshRetry(doRequest, refreshSession)
}

// Test seam: in dev / Playwright the dev server sets import.meta.env.DEV, so the
// pure retry helper is reachable for a deterministic regression test. Not
// exposed in production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__withRefreshRetry = withRefreshRetry
}

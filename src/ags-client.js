import { AccelByte } from '@accelbyte/sdk'

const baseURL = import.meta.env.DEV
  ? window.location.origin
  : import.meta.env.VITE_ACCELBYTE_BASE_URL

// For raw fetch calls that can't go through the SDK (e.g. keepalive requests
// during page unload). Auth rides on cookies, same as the SDK's axios config.
export const agsBaseURL = baseURL
export const agsNamespace = import.meta.env.VITE_ACCELBYTE_NAMESPACE

export const sdk = AccelByte.SDK({
  coreConfig: {
    baseURL,
    clientId: import.meta.env.VITE_ACCELBYTE_CLIENT_ID,
    redirectURI: import.meta.env.VITE_ACCELBYTE_REDIRECT_URI || window.location.origin + '/',
    namespace: import.meta.env.VITE_ACCELBYTE_NAMESPACE,
  },
  axiosConfig: {
    // Bound every generated REST call. In particular, a hung matchmaking poll
    // must not overlap forever with later polls on a degraded mobile network.
    request: { withCredentials: true, timeout: 15_000 },
  },
  // presence.js owns reconnect/backoff so there is exactly one socket state
  // machine. Running the SDK's reconnect loop alongside it can create two
  // competing connections after a close or token refresh.
  webSocketConfig: {
    allowReconnect: false,
  },
})

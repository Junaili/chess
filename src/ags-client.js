import { AccelByte } from '@accelbyte/sdk'

const baseURL = import.meta.env.DEV
  ? window.location.origin
  : import.meta.env.VITE_ACCELBYTE_BASE_URL

export const sdk = AccelByte.SDK({
  coreConfig: {
    baseURL,
    clientId: import.meta.env.VITE_ACCELBYTE_CLIENT_ID,
    redirectURI: import.meta.env.VITE_ACCELBYTE_REDIRECT_URI || window.location.origin + '/',
    namespace: import.meta.env.VITE_ACCELBYTE_NAMESPACE,
  },
  axiosConfig: {
    request: { withCredentials: true },
  },
})

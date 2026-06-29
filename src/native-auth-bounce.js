const NATIVE_CALLBACK_URL = 'io.github.junaili.chess:/oauth2redirect'
const NATIVE_RETURN_PATH = '__native__'

function isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.()
}

function isNativeAuthorizationState(rawState) {
  try {
    const state = JSON.parse(rawState)
    if (!state?.payload) return false
    const payload = JSON.parse(state.payload)
    return payload?.path === NATIVE_RETURN_PATH
  } catch {
    return false
  }
}

const GOOGLE_NATIVE_STATE = 'ethanschess_native_google'

if (!isNativeApp()) {
  const params = new URLSearchParams(window.location.search)
  const state = params.get('state') || ''
  if ((params.has('code') || params.has('error')) && isNativeAuthorizationState(state)) {
    // AGS hosted-login auth-code callback (?code in the query).
    const callback = new URL(NATIVE_CALLBACK_URL)
    callback.search = params.toString()
    window.location.replace(callback.toString())
  } else {
    // Direct Google login returns the id_token in the URL fragment; forward it
    // (as a query param) to the app's custom scheme.
    const hash = new URLSearchParams(window.location.hash.slice(1))
    if ((hash.has('id_token') || hash.has('error')) && hash.get('state') === GOOGLE_NATIVE_STATE) {
      const callback = new URL(NATIVE_CALLBACK_URL)
      const out = new URLSearchParams()
      if (hash.get('id_token')) out.set('id_token', hash.get('id_token'))
      if (hash.get('error')) out.set('error', hash.get('error'))
      out.set('state', GOOGLE_NATIVE_STATE)
      callback.search = out.toString()
      window.location.replace(callback.toString())
    }
  }
}

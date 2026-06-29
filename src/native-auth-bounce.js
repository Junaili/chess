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

if (!isNativeApp()) {
  const params = new URLSearchParams(window.location.search)
  const state = params.get('state') || ''
  if ((params.has('code') || params.has('error')) && isNativeAuthorizationState(state)) {
    const callback = new URL(NATIVE_CALLBACK_URL)
    callback.search = params.toString()
    window.location.replace(callback.toString())
  }
}

// Stable identifiers used to stitch analytics events together.
//
// device_id  — a persistent anonymous id (localStorage). Survives logout and
//              spans the pre-auth → registered transition, so we can join a
//              guest's invite-link click to the account they later create. Also
//              sent as the Device-Id login header, tying telemetry to login
//              history. Same key the auth layer has always used.
// session_id — a per-tab/session id (sessionStorage). Lets us measure per-session
//              depth (games per session, etc.).

const DEVICE_ID_KEY = 'ags_device_id'
const SESSION_ID_KEY = 'chess_session_id'

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
}

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = `chess-${randomId()}`
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

let cachedSessionId = null
export function getSessionId() {
  if (cachedSessionId) return cachedSessionId
  cachedSessionId = sessionStorage.getItem(SESSION_ID_KEY)
  if (!cachedSessionId) {
    cachedSessionId = randomId()
    sessionStorage.setItem(SESSION_ID_KEY, cachedSessionId)
  }
  return cachedSessionId
}

// Coarse platform dimension so web vs native iOS can be compared. Capacitor
// reports 'ios' | 'android' | 'web'; outside the native shell it's always web.
export function getPlatform() {
  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      return window.Capacitor.getPlatform?.() || 'ios'
    }
  } catch {}
  return 'web'
}

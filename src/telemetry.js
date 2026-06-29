import { GametelemetryOperationsApi } from '@accelbyte/sdk-gametelemetry'
import { sdk } from './ags-client.js'
import { getDeviceId, getSessionId, getPlatform } from './anon-id.js'

// Bump when the stamped payload shape changes, so analytics queries can filter
// or migrate by version instead of guessing.
const EVENT_SCHEMA_VERSION = 1

// Events queued before the user is authenticated; flushed after login.
let preAuthQueue = []

// Capture UTM params and referrer on first load and persist for the session
// so they survive the Google OAuth redirect (which clears the URL).
export function captureUtm() {
  if (sessionStorage.getItem('chess_utm')) return
  try {
    const p = new URLSearchParams(window.location.search)
    sessionStorage.setItem('chess_utm', JSON.stringify({
      utm_source:   p.get('utm_source')   || '',
      utm_medium:   p.get('utm_medium')   || '',
      utm_campaign: p.get('utm_campaign') || '',
      referrer:     document.referrer     || '',
    }))
  } catch {}
}

function getUtm() {
  try { return JSON.parse(sessionStorage.getItem('chess_utm') || '{}') } catch { return {} }
}

function api() {
  const { coreConfig } = sdk.assembly()
  return GametelemetryOperationsApi(sdk, { coreConfig: { ...coreConfig, useSchemaValidation: false } })
}

async function dispatch(events) {
  try {
    await api().createProtectedEvent(events)
  } catch (e) {
    console.warn('[telemetry]', e?.response?.data || e?.message)
  }
}

// Send a single event to AGS Game Telemetry. If the user is not yet
// authenticated the event is queued; call flushPendingEvents() after login.
export async function sendEvent(eventName, payload = {}) {
  const { coreConfig } = sdk.assembly()
  const event = {
    EventNamespace:  coreConfig.namespace,
    EventName:       eventName,
    ClientTimestamp: new Date().toISOString(),
    // Stamp identity + context on every event so funnels can join across the
    // pre-auth → registered boundary and slice by platform/session/version.
    Payload: {
      schema_version: EVENT_SCHEMA_VERSION,
      device_id:      getDeviceId(),
      session_id:     getSessionId(),
      platform:       getPlatform(),
      ...getUtm(),
      ...payload,
    },
  }
  if (!sdk.getToken()?.accessToken) {
    preAuthQueue.push(event)
    return
  }
  await dispatch([event])
}

// Deliver any events queued before authentication.
// Call once immediately after the user's session is established.
export async function flushPendingEvents() {
  if (!preAuthQueue.length || !sdk.getToken()?.accessToken) return
  const toSend = preAuthQueue.slice()
  preAuthQueue = []
  await dispatch(toSend)
}

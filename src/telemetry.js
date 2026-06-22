import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'
import { sdk } from './ags-client.js'

const TELEMETRY_KEY = 'chess-telemetry'
const MAX_EVENTS = 200

function api() {
  const { coreConfig } = sdk.assembly()
  return PublicPlayerRecordApi(sdk, {
    coreConfig: { ...coreConfig, useSchemaValidation: false },
  })
}

async function readEvents(userId) {
  try {
    const res = await api().getRecord_ByUserId_ByKey(userId, TELEMETRY_KEY)
    const events = res.data?.value?.events
    return Array.isArray(events) ? events : []
  } catch (e) {
    if (e?.response?.status === 404) return []
    throw e
  }
}

async function writeEvents(userId, events) {
  const record = { events, updatedAt: new Date().toISOString() }
  try {
    await api().updateRecord_ByUserId_ByKey(userId, TELEMETRY_KEY, record)
  } catch (e) {
    if (e?.response?.status !== 404) throw e
    await api().createRecord_ByUserId_ByKey(userId, TELEMETRY_KEY, record)
  }
}

export async function sendTelemetryEvent(eventName, payload) {
  const token = sdk.getToken()?.accessToken
  if (!token || !payload?.userId) return

  try {
    const existing = await readEvents(payload.userId)
    const event = {
      eventName,
      timestamp: new Date().toISOString(),
      ...payload,
    }
    const updated = [event, ...existing].slice(0, MAX_EVENTS)
    await writeEvents(payload.userId, updated)
  } catch (e) {
    console.warn('[AGS telemetry] sendTelemetryEvent:', e?.response?.data || e?.message)
  }
}

import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'
import { sdk } from './ags-client.js'

const LIVE_MATCH_KEY = 'chess-live'
const POLL_INTERVAL_MS = 3000

function api() {
  const { coreConfig } = sdk.assembly()
  return PublicPlayerRecordApi(sdk, {
    coreConfig: { ...coreConfig, useSchemaValidation: false },
  })
}

export async function publishLiveMatch(userId, data) {
  if (!userId || !sdk.getToken()?.accessToken) return
  const record = { __META: { is_public: true }, ...data, updatedAt: new Date().toISOString() }
  try {
    try {
      await api().updateRecord_ByUserId_ByKey(userId, LIVE_MATCH_KEY, record)
    } catch (e) {
      if (e?.response?.status !== 404) throw e
      await api().createRecord_ByUserId_ByKey(userId, LIVE_MATCH_KEY, record)
    }
  } catch (e) {
    console.warn('[AGS spectator] publish:', e?.response?.data || e?.message)
  }
}

export async function fetchLiveMatch(userId) {
  try {
    const res = await api().getPublic_ByUserId_ByKey(userId, LIVE_MATCH_KEY)
    return res.data?.value || null
  } catch (e) {
    if (e?.response?.status === 404) return null
    console.warn('[AGS spectator] fetch:', e?.message)
    return null
  }
}

export async function clearLiveMatch(userId) {
  await publishLiveMatch(userId, { active: false, moves: [] })
}

let _pollInterval = null

export function startWatching(userId, onUpdate) {
  stopWatching()
  const poll = async () => {
    const data = await fetchLiveMatch(userId)
    if (data) onUpdate(data)
  }
  poll()
  _pollInterval = setInterval(poll, POLL_INTERVAL_MS)
}

export function stopWatching() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null }
}

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

export async function publishLiveMatchStrict(userId, data) {
  if (!userId || !sdk.getToken()?.accessToken) {
    throw new Error('Sign in before publishing a live match.')
  }
  const record = { __META: { is_public: true }, ...data, updatedAt: new Date().toISOString() }
  try {
    await api().updateRecord_ByUserId_ByKey(userId, LIVE_MATCH_KEY, record)
  } catch (e) {
    if (e?.response?.status !== 404) throw e
    await api().createRecord_ByUserId_ByKey(userId, LIVE_MATCH_KEY, record)
  }
}

export async function publishLiveMatch(userId, data) {
  if (!userId || !sdk.getToken()?.accessToken) return
  try {
    await publishLiveMatchStrict(userId, data)
  } catch (e) {
    console.warn('[AGS spectator] publish:', e?.response?.data || e?.message)
  }
}

export async function fetchLiveMatchStrict(userId) {
  try {
    const res = await api().getPublic_ByUserId_ByKey(userId, LIVE_MATCH_KEY)
    return res.data?.value || null
  } catch (e) {
    if (e?.response?.status === 404) return null
    throw e
  }
}

export async function fetchLiveMatch(userId) {
  try {
    return await fetchLiveMatchStrict(userId)
  } catch (e) {
    console.warn('[AGS spectator] fetch:', e?.message)
    return null
  }
}

export async function clearLiveMatch(userId) {
  await publishLiveMatch(userId, { active: false, moves: [] })
}

// Records "I won matchId by forfeit, opponent never reconnected" onto the
// caller's OWN chess-live record — publishLiveMatch overwrites the whole
// record each call, so this reads the existing one first and merges the
// resolution in rather than clobbering the last-known move state. The other
// side reads this back (via fetchLiveMatch on the winner's userId, matched by
// matchId) whenever their client next runs, however long that takes.
export async function resolveMatchForfeit(userId, matchId, loserUserId) {
  const existing = await fetchLiveMatchStrict(userId)
  await publishLiveMatchStrict(userId, {
    ...existing,
    matchId,
    resolvedForfeit: { matchId, loserUserId, at: new Date().toISOString() },
  })
}

let _pollTimer = null
let _watchGeneration = 0

export function startWatching(userId, onUpdate) {
  stopWatching()
  const generation = _watchGeneration
  const poll = async () => {
    try {
      const data = await fetchLiveMatch(userId)
      if (generation !== _watchGeneration) return
      if (data) {
        try {
          onUpdate(data)
        } catch (error) {
          console.warn('[AGS spectator] update listener:', error?.message || error)
        }
      }
    } catch (error) {
      console.warn('[AGS spectator] watch poll:', error?.message || error)
    } finally {
      if (generation === _watchGeneration) {
        // Schedule only after the prior request finishes. A slow CloudSave
        // response must not create a pile-up of overlapping 3-second polls.
        _pollTimer = setTimeout(() => {
          _pollTimer = null
          void poll()
        }, POLL_INTERVAL_MS)
      }
    }
  }
  void poll()
}

export function stopWatching() {
  _watchGeneration += 1
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null }
}

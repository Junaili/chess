import { UserStatisticApi } from '@accelbyte/sdk-social'
import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'
import { sdk } from './ags-client.js'

const STAT_CODES = ['chess-wins', 'chess-losses']
const MATCH_HISTORY_KEY = 'chess-match-history'
const MAX_MATCH_HISTORY = 50
const MATCH_HISTORY_BUILD = 'cloudsave-v3'

window.agsMatchHistoryBuild = MATCH_HISTORY_BUILD

export async function initStats(userId) {
  try {
    await UserStatisticApi(sdk).createStatitemBulk_ByUserId(
      userId,
      STAT_CODES.map(statCode => ({ statCode }))
    )
  } catch (e) {
    console.warn('[AGS stats] initStats:', e?.response?.data || e?.message)
  }
}

export async function fetchStats(userId) {
  try {
    const res = await UserStatisticApi(sdk).getStatitems_ByUserId(userId, {
      statCodes: STAT_CODES.join(','),
    })
    const items = res.data?.data || []
    return {
      wins: items.find(i => i.statCode === 'chess-wins')?.value ?? 0,
      losses: items.find(i => i.statCode === 'chess-losses')?.value ?? 0,
    }
  } catch (e) {
    console.warn('[AGS stats] fetchStats:', e?.response?.data || e?.message)
    return null
  }
}

export async function incrementStat(userId, statCode, displayName = null) {
  try {
    const body = { inc: 1 }
    if (displayName) body.additionalData = { displayName }
    await UserStatisticApi(sdk).patchStatitemValue_ByUserId_ByStatCode(userId, statCode, body)
  } catch (e) {
    console.error('[AGS stats] incrementStat', statCode, ':', e?.response?.data || e?.message)
  }
}

function cloudSaveApi() {
  const { coreConfig } = sdk.assembly()
  return PublicPlayerRecordApi(sdk, {
    coreConfig: {
      ...coreConfig,
      useSchemaValidation: false,
    },
  })
}

function normalizeMatchHistory(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function fetchMatchHistory(userId) {
  if (!userId) return []
  try {
    const api = cloudSaveApi()
    let res
    try {
      res = await api.getPublic_ByUserId_ByKey(userId, MATCH_HISTORY_KEY)
    } catch (e) {
      if (e?.response?.status !== 404) throw e
      res = await api.getRecord_ByUserId_ByKey(userId, MATCH_HISTORY_KEY)
    }
    const history = normalizeMatchHistory(res.data?.value?.matches)
      .filter(match => match?.endedAt && match?.durationMs)
      .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
    if (localStorage.getItem('ags_match_history_debug') === '1') {
      console.debug('[AGS match history] fetched', { userId, count: history.length, record: res.data })
    }
    return history
  } catch (e) {
    if (e?.response?.status === 404) return []
    console.warn('[AGS match history] fetch:', e?.message || e)
    return []
  }
}

async function savePublicMatchHistory(userId, record) {
  const api = cloudSaveApi()
  try {
    await api.updateRecord_ByUserId_ByKey(userId, MATCH_HISTORY_KEY, record)
  } catch (e) {
    if (e?.response?.status !== 404) throw e
    await api.createRecord_ByUserId_ByKey(userId, MATCH_HISTORY_KEY, record)
  }
}

export async function recordMatchHistory(match) {
  const token = sdk.getToken()?.accessToken
  if (!token || !match?.playerUserId) return

  try {
    if (localStorage.getItem('ags_match_history_debug') === '1') {
      console.debug('[AGS match history] record build', MATCH_HISTORY_BUILD)
    }
    const current = await fetchMatchHistory(match.playerUserId)
    const entry = {
      id: match.id || `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mode: match.mode || 'unknown',
      opponentUserId: match.opponentUserId || '',
      opponentName: match.opponentName || 'Opponent',
      result: match.result || 'completed',
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      durationMs: Math.max(0, Number(match.durationMs) || 0),
      moves: Array.isArray(match.moves)
        ? match.moves.map(move => ({
            fr: move.fr,
            fc: move.fc,
            toR: move.toR,
            toC: move.toC,
            promType: move.promType || 'queen',
          }))
        : [],
      whiteName: match.whiteName || '',
      blackName: match.blackName || '',
    }
    const history = [entry, ...current.filter(item => item.id !== entry.id)].slice(0, MAX_MATCH_HISTORY)
    const record = {
      __META: { is_public: true },
      matches: history,
      updatedAt: new Date().toISOString(),
    }
    await savePublicMatchHistory(match.playerUserId, record)
    if (localStorage.getItem('ags_match_history_debug') === '1') {
      console.debug('[AGS match history] recorded', { entry, count: history.length })
    }
  } catch (e) {
    console.warn('[AGS match history] record:', e?.response?.status || '', e?.response?.data || e?.message || e)
  }
}

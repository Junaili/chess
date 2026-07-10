import { UserStatisticApi } from '@accelbyte/sdk-social'
import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'
import { sdk } from './ags-client.js'
import { moderateIncomingDisplayName } from './content-moderation.mjs'
import { computeEloUpdate } from './match-stats.mjs'

const STREAK_CURRENT = 'chess-current-streak'
const STREAK_LONGEST = 'chess-longest-streak'
const STREAK_LAST_DAY = 'chess-last-play-day'
const RATING = 'chess-rating'
const RATING_DEFAULT = 1200
const LEADERBOARD_STAT_CODES = {
  wins: 'chess-wins',
  losses: 'chess-losses',
  streak: STREAK_CURRENT,
}
const STAT_CODES = [
  'chess-wins', 'chess-losses', 'chess-games-played', 'chess-draws', 'chess-online-games',
  STREAK_CURRENT, STREAK_LONGEST, STREAK_LAST_DAY, RATING,
]
const MATCH_HISTORY_KEY = 'chess-match-history'
const MAX_MATCH_HISTORY = 50
const MATCH_HISTORY_BUILD = 'cloudsave-v3'
const STREAK_KEY = 'chess-streak'  // legacy CloudSave key — read once for backfill
const STREAK_MIGRATED_FLAG = 'chess-streak-migrated'
const DAY_MS = 86400000

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
    const get = code => items.find(i => i.statCode === code)?.value ?? 0
    return {
      wins:         get('chess-wins'),
      losses:       get('chess-losses'),
      gamesPlayed:  get('chess-games-played'),
      draws:        get('chess-draws'),
      onlineGames:  get('chess-online-games'),
      rating:       get(RATING) || RATING_DEFAULT,
    }
  } catch (e) {
    console.warn('[AGS stats] fetchStats:', e?.response?.data || e?.message)
    return null
  }
}

// The public Statistics bulk endpoint accepts one stat code and many users.
// Fetch the three compact leaderboard stats in parallel instead of issuing a
// separate request for every leaderboard row.
export async function fetchLeaderboardPlayerStats(rawUserIds) {
  const userIds = [...new Set(
    (rawUserIds || []).filter(userId => typeof userId === 'string' && userId),
  )]
  if (!userIds.length) return {}

  try {
    const statsByUserId = Object.fromEntries(
      userIds.map(userId => [userId, { wins: 0, losses: 0, streak: 0 }]),
    )
    const api = UserStatisticApi(sdk)
    const rowsByStat = await Promise.all(
      Object.entries(LEADERBOARD_STAT_CODES).map(async ([field, statCode]) => {
        const response = await api.getStatitemsBulk({
          statCode,
          userIds: userIds.join(','),
        })
        return [field, response.data || []]
      }),
    )

    for (const [field, rows] of rowsByStat) {
      for (const row of rows) {
        const value = Number(row?.value)
        if (statsByUserId[row?.userId] && Number.isFinite(value)) {
          statsByUserId[row.userId][field] = value
        }
      }
    }
    return statsByUserId
  } catch (e) {
    console.warn('[AGS stats] fetchLeaderboardPlayerStats:', e?.response?.data || e?.message)
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
      .map(match => ({
        ...match,
        opponentName: moderateIncomingDisplayName(match.opponentName, 'Opponent'),
        whiteName: moderateIncomingDisplayName(match.whiteName, 'White'),
        blackName: moderateIncomingDisplayName(match.blackName, 'Black'),
      }))
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
      opponentName: moderateIncomingDisplayName(match.opponentName, 'Opponent'),
      result: match.result || 'completed',
      endReason: typeof match.endReason === 'string' ? match.endReason : '',
      myColor: match.myColor === 'black' ? 'black' : match.myColor === 'white' ? 'white' : '',
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
      whiteName: moderateIncomingDisplayName(match.whiteName, 'White'),
      blackName: moderateIncomingDisplayName(match.blackName, 'Black'),
      capturedByWhite: Array.isArray(match.capturedByWhite) ? match.capturedByWhite.filter(t => typeof t === 'string') : [],
      capturedByBlack: Array.isArray(match.capturedByBlack) ? match.capturedByBlack.filter(t => typeof t === 'string') : [],
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

function setStat(userId, statCode, value, updateStrategy, displayName = null) {
  // _v2 is the update-strategy variant ({ value, updateStrategy }); the v1
  // method takes an increment body instead.
  const body = { value, updateStrategy }
  if (displayName) body.additionalData = { displayName }
  return UserStatisticApi(sdk).updateStatitemValue_ByUserId_ByStatCode_v2(userId, statCode, body)
}

async function readStreakStats(userId, codes) {
  const res = await UserStatisticApi(sdk).getStatitems_ByUserId(userId, { statCodes: codes.join(',') })
  const items = res.data?.data || []
  return code => items.find(i => i.statCode === code)?.value
}

// Applies one match's Elo result and persists the new rating. Only called for
// online matches where the opponent's pre-game rating was actually received
// over the peer connection — skip (don't guess) otherwise. displayName is
// attached the same way incrementStat does for chess-wins, so a brand-new
// leaderboard entry has a name available immediately rather than depending on
// the (already-existing, still-correct) IAM-lookup fallback in leaderboard.js.
export async function recordEloResult(userId, myRatingBefore, opponentRating, score, displayName = null) {
  if (!userId || typeof opponentRating !== 'number') return null
  const newRating = computeEloUpdate(myRatingBefore, opponentRating, score)
  try {
    await setStat(userId, RATING, newRating, 'OVERRIDE', displayName)
    return newRating
  } catch (e) {
    console.warn('[AGS rating] record:', e?.response?.data || e?.message)
    return null
  }
}

export async function fetchStreak(userId) {
  if (!userId || !sdk.getToken()?.accessToken) return { streak: 0, longestStreak: 0 }
  try {
    const get = await readStreakStats(userId, [STREAK_CURRENT, STREAK_LONGEST])
    return { streak: get(STREAK_CURRENT) ?? 0, longestStreak: get(STREAK_LONGEST) ?? 0 }
  } catch (e) {
    console.warn('[AGS streak] fetch:', e?.response?.data || e?.message)
    return { streak: 0, longestStreak: 0 }
  }
}

export async function updateStreak(userId) {
  if (!userId || !sdk.getToken()?.accessToken) return
  const today = Math.floor(Date.now() / DAY_MS)  // UTC days since epoch
  try {
    const get = await readStreakStats(userId, [STREAK_CURRENT, STREAK_LONGEST, STREAK_LAST_DAY])
    const lastDay = get(STREAK_LAST_DAY)
    const currentStreak = get(STREAK_CURRENT) ?? 0
    const longest = get(STREAK_LONGEST) ?? 0

    if (lastDay === today) return  // already counted today

    const newStreak = lastDay === today - 1 ? currentStreak + 1 : 1
    await Promise.allSettled([
      setStat(userId, STREAK_CURRENT, newStreak, 'OVERRIDE'),
      setStat(userId, STREAK_LAST_DAY, today, 'OVERRIDE'),
      setStat(userId, STREAK_LONGEST, newStreak, 'MAX'),
    ])
    return { streak: newStreak, longestStreak: Math.max(newStreak, longest) }
  } catch (e) {
    console.warn('[AGS streak] update:', e?.response?.data || e?.message)
  }
}

// One-time migration of the legacy CloudSave streak record into Statistics.
// Runs at most once per browser (guarded by localStorage); safe to skip.
export async function migrateStreakFromCloudSave(userId) {
  if (!userId || !sdk.getToken()?.accessToken) return
  if (localStorage.getItem(STREAK_MIGRATED_FLAG) === '1') return
  try {
    const api = cloudSaveApi()
    let res
    try {
      res = await api.getPublic_ByUserId_ByKey(userId, STREAK_KEY)
    } catch (e) {
      if (e?.response?.status !== 404) throw e
      res = await api.getRecord_ByUserId_ByKey(userId, STREAK_KEY)
    }
    const v = res.data?.value || {}
    const legacyStreak = v.streak || 0
    const legacyLongest = v.longestStreak || 0
    // Convert the legacy YYYY-MM-DD lastPlayDate to a UTC day index, if present
    const legacyDay = v.lastPlayDate ? Math.floor(Date.parse(v.lastPlayDate + 'T00:00:00Z') / DAY_MS) : null
    if (legacyStreak || legacyLongest) {
      const writes = [
        setStat(userId, STREAK_CURRENT, legacyStreak, 'OVERRIDE'),
        setStat(userId, STREAK_LONGEST, Math.max(legacyStreak, legacyLongest), 'MAX'),
      ]
      if (legacyDay != null) writes.push(setStat(userId, STREAK_LAST_DAY, legacyDay, 'OVERRIDE'))
      await Promise.allSettled(writes)
    }
    localStorage.setItem(STREAK_MIGRATED_FLAG, '1')
  } catch (e) {
    if (e?.response?.status === 404) {
      localStorage.setItem(STREAK_MIGRATED_FLAG, '1')  // nothing to migrate — don't retry
      return
    }
    console.warn('[AGS streak] migrate:', e?.response?.data || e?.message)
  }
}

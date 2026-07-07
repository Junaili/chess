import { LeaderboardDataV3Api } from '@accelbyte/sdk-leaderboard'
import { UsersV4Api } from '@accelbyte/sdk-iam'
import { sdk } from './ags-client.js'
import { moderateIncomingDisplayName } from './content-moderation.mjs'

// Two views, both backed by real AGS leaderboard configs:
// - "rating": chess-rating-lb, all-time — Elo-style skill, ten wins against
//   weak opponents isn't the same as ten wins against strong ones, and a
//   rating captures that where a raw win counter can't.
// - "weekly": chess-wins-lb (revived from dormant — it used to be the
//   all-time win-count board before rating replaced it), now cycle-scoped to
//   the "chessweekly" stat cycle (resets every Monday 00:00 UTC) — gives new
//   players a fresh, winnable target instead of only ever competing against
//   whoever has the most cumulative rating from months of play.
export const LEADERBOARD_VIEWS = {
  rating: { code: 'chess-rating-lb', kind: 'alltime' },
  weekly: { code: 'chess-wins-lb', kind: 'cycle', cycleId: 'chessweekly' },
}
const NAME_CACHE_KEY = 'ags-name-cache'

export function cacheDisplayName(userId, displayName) {
  if (!userId) return
  try {
    const cache = JSON.parse(localStorage.getItem(NAME_CACHE_KEY) || '{}')
    const safeName = displayName
      ? moderateIncomingDisplayName(displayName, 'Player')
      : null
    cache[userId] = { name: safeName, ts: Date.now() }
    localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(cache))
  } catch {}
}

function getCachedNameAnyAge(cache, userId) {
  // Returns the name regardless of age — used as display fallback when re-fetch fails
  const entry = cache[userId]
  if (!entry) return null
  if (typeof entry === 'string') return entry
  return entry.name
}

export async function fetchTopRankings(view = 'rating', limit = 10) {
  const config = LEADERBOARD_VIEWS[view] || LEADERBOARD_VIEWS.rating
  try {
    const res = config.kind === 'cycle'
      ? await LeaderboardDataV3Api(sdk).getCycle_ByLeaderboardCode_ByCycleId_v3(
          config.code, config.cycleId, { limit, offset: 0 },
        )
      : await LeaderboardDataV3Api(sdk).getAlltime_ByLeaderboardCode_v3(
          config.code, { limit, offset: 0 },
        )
    return res.data?.data || []
  } catch (e) {
    if (e?.response?.status === 404) return []  // empty leaderboard — not an error
    console.warn('[AGS lb] fetchTopRankings:', e?.response?.data || e?.message)
    return null
  }
}

export async function fetchUserRank(userId, view = 'rating') {
  const config = LEADERBOARD_VIEWS[view] || LEADERBOARD_VIEWS.rating
  try {
    const res = await LeaderboardDataV3Api(sdk).getUser_ByLeaderboardCode_ByUserId_v3(
      config.code,
      userId,
    )
    if (config.kind === 'cycle') {
      return res.data?.cycles?.find(c => c.cycleId === config.cycleId) || null
    }
    return res.data?.allTime || null
  } catch (e) {
    if (e?.response?.status === 404) return null  // user not ranked yet — not an error
    console.warn('[AGS lb] fetchUserRank:', e?.response?.data || e?.message)
    return null
  }
}

// Leaderboard display names come from the score's additionalData (written on a
// win — see agsIncrementWin) plus the local name cache (populated when you play
// or look up a user). Neither is available for a player you've never interacted
// with on a fresh browser, so their row rendered as a raw user ID. Resolve those
// via the IAM v4 user lookup — the same reliable path friends use — and cache
// the result so resolveDisplayNames (called right after) picks it up. We do NOT
// hit AGS Basic public profiles (this game never creates Basic profiles, so
// /basic/.../profiles/public always 404s and spammed the console).
export async function enrichDisplayNames(rankings) {
  if (!rankings?.length) return
  try {
    const cache = JSON.parse(localStorage.getItem(NAME_CACHE_KEY) || '{}')
    const missing = rankings.filter(
      entry =>
        entry?.userId &&
        !getCachedNameAnyAge(cache, entry.userId) &&
        !entry.additionalData?.displayName,
    )
    if (!missing.length) return
    const { coreConfig } = sdk.assembly()
    const v4 = UsersV4Api(sdk, { coreConfig: { ...coreConfig, useSchemaValidation: false } })
    const results = await Promise.allSettled(
      missing.map(entry => v4.getUser_ByUserId_v4(entry.userId)),
    )
    for (const outcome of results) {
      if (outcome.status !== 'fulfilled') continue
      const user = outcome.value?.data
      const rawName = user?.displayName || user?.uniqueDisplayName
      if (rawName && user?.userId) cacheDisplayName(user.userId, rawName) // moderates + caches
    }
  } catch (e) {
    console.warn('[AGS lb] enrichDisplayNames:', e?.response?.data || e?.message)
  }
}

export function resolveDisplayNames(rankings) {
  if (!rankings.length) return {}
  try {
    const cache = JSON.parse(localStorage.getItem(NAME_CACHE_KEY) || '{}')
    const map = {}
    for (const entry of rankings) {
      const id = entry.userId
      // Prefer fresh IAM/Basic name from cache; fall back to stale cache; last resort: additionalData
      const name = getCachedNameAnyAge(cache, id) || entry.additionalData?.displayName
      if (name) map[id] = moderateIncomingDisplayName(name, 'Player')
    }
    return map
  } catch {
    return {}
  }
}

export async function fetchInviterName(userId) {
  if (!userId) return null
  // Resolve from the local name cache only. We don't hit Basic public profiles
  // (always 404s — see enrichDisplayNames); an unknown inviter just shows a
  // generic label, same as the previous 404 → null behaviour.
  try {
    const cache = JSON.parse(localStorage.getItem(NAME_CACHE_KEY) || '{}')
    const name = getCachedNameAnyAge(cache, userId)
    return name ? moderateIncomingDisplayName(name, 'Player') : null
  } catch {
    return null
  }
}

import { LeaderboardDataV3Api } from '@accelbyte/sdk-leaderboard'
import { UsersV4Api } from '@accelbyte/sdk-iam'
import { sdk } from './ags-client.js'
import { moderateIncomingDisplayName } from './content-moderation.mjs'

// Ranks by chess-rating (Elo-style skill), not raw win count — ten wins
// against weak opponents isn't the same as ten wins against strong ones, and
// a rating captures that where a win counter can't. The old chess-wins-lb
// board is left in place in AGS (dormant, not deleted) rather than removed,
// in case its historical win-count data is useful later.
const LEADERBOARD_CODE = 'chess-rating-lb'
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

export async function fetchTopRankings(limit = 10) {
  try {
    const res = await LeaderboardDataV3Api(sdk).getAlltime_ByLeaderboardCode_v3(
      LEADERBOARD_CODE,
      { limit, offset: 0 }
    )
    return res.data?.data || []
  } catch (e) {
    if (e?.response?.status === 404) return []  // empty leaderboard — not an error
    console.warn('[AGS lb] fetchTopRankings:', e?.response?.data || e?.message)
    return null
  }
}

export async function fetchUserRank(userId) {
  try {
    const res = await LeaderboardDataV3Api(sdk).getUser_ByLeaderboardCode_ByUserId_v3(
      LEADERBOARD_CODE,
      userId
    )
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

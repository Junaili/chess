// AGS Achievements — Phase A foundation.
//
// Most achievements are incremental and linked to a statistic in the Admin
// Portal; AGS auto-unlocks them server-side when the stat crosses the goal, so
// the game needs no unlock code for those. This module reads the user's
// achievements and tracks newly-unlocked codes (vs a localStorage cache) so a
// later phase can celebrate them. Event achievements unlock explicitly.
//
// Defensive style mirrors stats.js / telemetry.js: schema validation off,
// 404/409-tolerant, console.warn on failure, never throw into game flow.

import { AchievementsApi, UserAchievementsApi } from '@accelbyte/sdk-achievement'
import { sdk } from './ags-client.js'

const UNLOCKED_CACHE_KEY = 'ags-achievements-unlocked'
const STATUS_UNLOCKED = 2  // AGS: status 1 = in progress, 2 = unlocked

let _catalog = null

function api(Factory) {
  const { coreConfig } = sdk.assembly()
  return Factory(sdk, { coreConfig: { ...coreConfig, useSchemaValidation: false } })
}

export async function fetchAchievementCatalog(language = 'en') {
  if (_catalog) return _catalog
  try {
    const res = await api(AchievementsApi).getAchievements({ language, limit: 100, offset: 0 })
    _catalog = res.data?.data || []
    return _catalog
  } catch (e) {
    console.warn('[AGS achievements] catalog:', e?.response?.data || e?.message)
    return []
  }
}

export async function fetchUserAchievements(userId) {
  if (!userId || !sdk.getToken()?.accessToken) return []
  try {
    const res = await api(UserAchievementsApi).getAchievements_ByUserId(userId, { limit: 100, offset: 0 })
    return res.data?.data || []
  } catch (e) {
    console.warn('[AGS achievements] user fetch:', e?.response?.data || e?.message)
    return []
  }
}

export async function unlockEventAchievement(userId, code) {
  if (!userId || !code || !sdk.getToken()?.accessToken) return
  try {
    await api(UserAchievementsApi).updateUnlock_ByUserId_ByAchievementCode(userId, code)
  } catch (e) {
    if (e?.response?.status === 409) return  // already unlocked — not an error
    console.warn('[AGS achievements] unlock', code, ':', e?.response?.data || e?.message)
  }
}

function readCache() {
  try { return new Set(JSON.parse(localStorage.getItem(UNLOCKED_CACHE_KEY) || '[]')) }
  catch { return new Set() }
}

function writeCache(set) {
  try { localStorage.setItem(UNLOCKED_CACHE_KEY, JSON.stringify([...set])) } catch {}
}

function unlockedCodes(list) {
  return list.filter(a => a.status === STATUS_UNLOCKED).map(a => a.achievementCode)
}

// Fetch + store the user's unlocked codes silently. Call on login so a later
// session's diff doesn't re-celebrate pre-existing unlocks.
export async function primeUnlockedCache(userId) {
  const list = await fetchUserAchievements(userId)
  writeCache(new Set(unlockedCodes(list)))
}

// Fetch, diff against cache, update cache, return newly-unlocked codes.
export async function diffNewlyUnlocked(userId) {
  const list = await fetchUserAchievements(userId)
  const current = unlockedCodes(list)
  const cache = readCache()
  const fresh = current.filter(code => !cache.has(code))
  if (fresh.length) {
    for (const c of current) cache.add(c)
    writeCache(cache)
  }
  return fresh
}

export function clearUnlockedCache() {
  try { localStorage.removeItem(UNLOCKED_CACHE_KEY) } catch {}
}

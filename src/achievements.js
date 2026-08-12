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
//
// Transport: the Extend proxy, NOT the AGS SDK. The Achievement service answers
// no CORS preflight and sets no Access-Control-Allow-Origin, so direct browser
// calls die before the response is readable — the defensive style above turned
// that into an empty badge panel instead of an error. The proxy takes the user
// id from the caller's token, so only "me" is ever readable/unlockable.

import { extendFetch } from './extend-client.js'
import { sdk } from './ags-client.js'

const UNLOCKED_CACHE_KEY = 'ags-achievements-unlocked'
const STATUS_UNLOCKED = 2  // AGS: status 1 = in progress, 2 = unlocked

let _catalog = null

export async function fetchAchievementCatalog(language = 'en') {
  if (_catalog) return _catalog
  try {
    const res = await extendFetch(
      `/achievement/catalog?language=${encodeURIComponent(language)}&limit=100&offset=0`,
    )
    if (!res.ok) throw new Error('HTTP ' + res.status)
    _catalog = (await res.json())?.data || []
    return _catalog
  } catch (e) {
    console.warn('[AGS achievements] catalog:', e?.message)
    return []
  }
}

export async function fetchUserAchievements(userId) {
  if (!userId || !sdk.getToken()?.accessToken) return []
  try {
    const res = await extendFetch('/achievement/me?limit=100&offset=0')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return (await res.json())?.data || []
  } catch (e) {
    console.warn('[AGS achievements] user fetch:', e?.message)
    return []
  }
}

export async function unlockEventAchievement(userId, code) {
  if (!userId || !code || !sdk.getToken()?.accessToken) return
  try {
    const res = await extendFetch(`/achievement/me/unlock/${encodeURIComponent(code)}`, { method: 'PUT' })
    // 409 = already unlocked, which is the normal case on every repeat call.
    if (!res.ok && res.status !== 409) throw new Error('HTTP ' + res.status)
  } catch (e) {
    console.warn('[AGS achievements] unlock', code, ':', e?.message)
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

// Catalog (all achievements) merged with the user's unlock status + progress,
// sorted by listOrder. Used by the badge panel and unlock toasts.
export async function fetchMergedAchievements(userId) {
  const [catalog, userAch] = await Promise.all([
    fetchAchievementCatalog(),
    fetchUserAchievements(userId),
  ])
  const byCode = {}
  for (const u of userAch) byCode[u.achievementCode] = u
  return catalog
    .slice()
    .sort((a, b) => (a.listOrder || 0) - (b.listOrder || 0))
    .map(a => {
      const u = byCode[a.achievementCode]
      const unlocked = u?.status === STATUS_UNLOCKED
      const goalValue = a.goalValue || 0
      const icons = unlocked ? a.unlockedIcons : a.lockedIcons
      return {
        code: a.achievementCode,
        name: a.name || a.achievementCode,
        description: a.description || '',
        goalValue,
        progress: Math.min(u?.latestValue ?? 0, goalValue || Infinity),
        unlocked,
        icon: icons?.[0]?.url || '',
      }
    })
}

import { LeaderboardDataV3Api } from '@accelbyte/sdk-leaderboard'
import { sdk } from './ags-client.js'

const LEADERBOARD_CODE = 'chess-wins-lb'
const NAME_CACHE_KEY = 'ags-name-cache'
const NAME_CACHE_TTL_MS = 1 * 60 * 1000  // re-fetch names older than 1 minute

let _clientToken = null
let _clientTokenExp = 0

async function getToken() {
  try {
    const t = sdk.getToken()?.accessToken
    if (t) return t
  } catch {}

  // Fall back to a short-lived client credentials token for unauthenticated calls
  if (_clientToken && Date.now() < _clientTokenExp) return _clientToken
  try {
    const { coreConfig } = sdk.assembly()
    const resp = await fetch(`${coreConfig.baseURL}/iam/v3/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(coreConfig.clientId + ':')}`,
      },
      body: 'grant_type=client_credentials',
      credentials: 'include',
    })
    if (!resp.ok) return null
    const d = await resp.json()
    if (!d.access_token) return null
    _clientToken = d.access_token
    _clientTokenExp = Date.now() + Math.max(0, (d.expires_in || 300) - 60) * 1000
    return _clientToken
  } catch {
    return null
  }
}

export function cacheDisplayName(userId, displayName) {
  if (!userId) return
  try {
    const cache = JSON.parse(localStorage.getItem(NAME_CACHE_KEY) || '{}')
    cache[userId] = { name: displayName ?? null, ts: Date.now() }
    localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(cache))
  } catch {}
}

function getCachedName(cache, userId) {
  const entry = cache[userId]
  if (!entry) return null
  if (typeof entry === 'string') return null  // old plain-string format → treat as stale
  if (Date.now() - entry.ts > NAME_CACHE_TTL_MS) return null
  return entry.name  // may be null (negative cache hit)
}

function hasFreshCacheEntry(cache, userId) {
  const entry = cache[userId]
  if (!entry || typeof entry === 'string') return false
  return Date.now() - entry.ts <= NAME_CACHE_TTL_MS
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

export async function enrichDisplayNames(rankings) {
  if (!rankings.length) return

  let cache
  try { cache = JSON.parse(localStorage.getItem(NAME_CACHE_KEY) || '{}') } catch { cache = {} }

  const missing = rankings.filter(entry => !hasFreshCacheEntry(cache, entry.userId))

  if (!missing.length) return

  const token = await getToken()
  if (!token) return

  const { coreConfig } = sdk.assembly()
  await Promise.allSettled(missing.map(async entry => {
    try {
      const resp = await fetch(
        `${coreConfig.baseURL}/basic/v1/public/namespaces/${coreConfig.namespace}/users/${entry.userId}/profiles/public`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!resp.ok) {
        // Cache the miss so we don't re-fetch every refresh cycle
        cacheDisplayName(entry.userId, null)
        return
      }
      const b = await resp.json()
      const name = b.customAttributes?.displayName || b.displayName
      cacheDisplayName(entry.userId, name || null)
    } catch {}
  }))
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
      if (name) map[id] = name
    }
    return map
  } catch {
    return {}
  }
}

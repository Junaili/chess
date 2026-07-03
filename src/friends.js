import { FriendsApi } from '@accelbyte/sdk-lobby'
import { UsersV4Api } from '@accelbyte/sdk-iam'
import { sdk } from './ags-client.js'
import { extendFetch } from './extend-client.js'
import { resolveDisplayNames } from './leaderboard.js'
import { fetchPresenceMap } from './presence.js'
import { moderateIncomingDisplayName } from './content-moderation.mjs'

const PAGE = { limit: 50, offset: 0 }

function friendsApi() {
  const { coreConfig } = sdk.assembly()
  return FriendsApi(sdk, {
    coreConfig: {
      ...coreConfig,
      useSchemaValidation: false,
    },
  })
}

function normalizeFriendId(entry) {
  if (!entry) return ''
  if (typeof entry === 'string') return entry
  return entry.friendId
    || entry.friendID
    || entry.userId
    || entry.userID
    || entry.friendUserId
    || entry.friendUserID
    || entry.id
    || ''
}

function normalizeList(data) {
  const source = [
    data,
    data?.data,
    data?.friends,
    data?.friendIds,
    data?.friendIDs,
    data?.friendsId,
    data?.friendIDs,
    data?.items,
  ].find(Array.isArray) || []

  return source
    .map(item => ({ raw: item, userId: normalizeFriendId(item) }))
    .filter(item => item.userId)
}

function getErrorMessage(e, fallback) {
  return e?.response?.data?.message
    || e?.response?.data?.errorMessage
    || e?.response?.data?.error
    || e?.message
    || fallback
}

async function withNames(items) {
  if (!items.length) return items
  let nameMap = resolveDisplayNames(items.map(item => ({ userId: item.userId })))

  const stillMissing = items.filter(item => !nameMap[item.userId])
  if (stillMissing.length) {
    const { coreConfig } = sdk.assembly()
    const v4 = UsersV4Api(sdk, { coreConfig: { ...coreConfig, useSchemaValidation: false } })
    const results = await Promise.allSettled(
      stillMissing.map(item => v4.getUser_ByUserId_v4(item.userId))
    )
    const { cacheDisplayName } = await import('./leaderboard.js')
    for (const outcome of results) {
      if (outcome.status !== 'fulfilled') continue
      const u = outcome.value?.data
      const rawName = u?.displayName || u?.uniqueDisplayName
      const name = rawName ? moderateIncomingDisplayName(rawName, 'Player') : ''
      if (name && u?.userId) {
        cacheDisplayName(u.userId, name)
        nameMap = { ...nameMap, [u.userId]: name }
      }
    }
  }

  return items.map(item => ({
    ...item,
    displayName: moderateIncomingDisplayName(
      nameMap[item.userId] || item.raw?.displayName || item.raw?.name,
      item.userId.slice(0, 8)
    ),
  }))
}

async function withPresence(items) {
  const presence = await fetchPresenceMap(items.map(item => item.userId))
  return items.map(item => ({
    ...item,
    presence: presence[item.userId] || { status: 'offline', label: 'Offline', activity: '' },
  }))
}

export async function fetchFriendState() {
  try {
    const api = friendsApi()
    const [friends, incoming, outgoing] = await Promise.all([
      api.getFriendsMe(PAGE),
      api.getFriendsMeIncoming(PAGE),
      api.getFriendsMeOutgoing(PAGE),
    ])

    const namedFriends = await withNames(normalizeList(friends.data))
    return {
      ok: true,
      friends: await withPresence(namedFriends),
      incoming: await withNames(normalizeList(incoming.data)),
      outgoing: await withNames(normalizeList(outgoing.data)),
    }
  } catch (e) {
    console.warn('[AGS friends] fetchFriendState:', e?.response?.data || e?.message)
    return { ok: false, error: getErrorMessage(e, 'Could not load friends.') }
  }
}

export async function requestFriend(friendId) {
  try {
    await friendsApi().createFriendMeRequest({ friendId })
    return { ok: true }
  } catch (e) {
    console.warn('[AGS friends] requestFriend:', e?.response?.data || e?.message)
    return { ok: false, error: getErrorMessage(e, 'Could not send friend request.') }
  }
}

export async function acceptFriend(friendId) {
  try {
    await friendsApi().createFriendMeRequestAccept({ friendId })
    return { ok: true }
  } catch (e) {
    console.warn('[AGS friends] acceptFriend:', e?.response?.data || e?.message)
    return { ok: false, error: getErrorMessage(e, 'Could not accept friend request.') }
  }
}

export async function rejectFriend(friendId) {
  try {
    await friendsApi().createFriendMeRequestReject({ friendId })
    return { ok: true }
  } catch (e) {
    console.warn('[AGS friends] rejectFriend:', e?.response?.data || e?.message)
    return { ok: false, error: getErrorMessage(e, 'Could not reject friend request.') }
  }
}

export async function cancelFriendRequest(friendId) {
  try {
    await friendsApi().createFriendMeRequestCancel({ friendId })
    return { ok: true }
  } catch (e) {
    console.warn('[AGS friends] cancelFriendRequest:', e?.response?.data || e?.message)
    return { ok: false, error: getErrorMessage(e, 'Could not cancel friend request.') }
  }
}

export async function getFriendshipStatus(friendId) {
  try {
    const res = await friendsApi().getFriendMeStatu_ByFriendId(friendId)
    return { ok: true, status: String(res.data?.code ?? res.data?.friendshipStatus ?? '') }
  } catch (e) {
    console.warn('[AGS friends] getFriendshipStatus:', e?.response?.data || e?.message)
    return { ok: false, error: getErrorMessage(e, 'Could not check friendship status.') }
  }
}

const PENDING_INVITES_KEY = 'ags-pending-invites'


export async function lookupUserByEmail(email) {
  if (!email?.includes('@')) return { ok: false, error: 'Invalid email address.' }
  try {
    const res = await extendFetch(`/lookup/email?email=${encodeURIComponent(email)}`)
    if (!res.ok) throw new Error('status ' + res.status)
    const data = await res.json()
    if (!data.found) return { ok: true, found: false }
    return {
      ok: true,
      found: true,
      userId: data.userId,
      displayName: moderateIncomingDisplayName(
        data.displayName,
        data.userId?.slice(0, 8) || 'Player'
      ),
    }
  } catch (e) {
    console.warn('[AGS friends] lookupUserByEmail:', e?.message)
    return { ok: false, error: 'Could not search for user.' }
  }
}

export async function addFriendByEmail(email, myUserId) {
  const lookup = await lookupUserByEmail(email)
  if (!lookup.ok) return lookup
  if (!lookup.found) return { ok: true, found: false }
  if (lookup.userId === myUserId) return { ok: false, error: "That's your own email address." }
  const sent = await requestFriend(lookup.userId)
  return { ...sent, found: true, userId: lookup.userId, displayName: lookup.displayName }
}

export function storePendingInvite(email, myUserId) {
  try {
    const invites = JSON.parse(localStorage.getItem(PENDING_INVITES_KEY) || '{}')
    invites[email.toLowerCase()] = { inviterUserId: myUserId, timestamp: Date.now() }
    localStorage.setItem(PENDING_INVITES_KEY, JSON.stringify(invites))
  } catch {}
}

export function clearPendingInvite(email) {
  try {
    const invites = JSON.parse(localStorage.getItem(PENDING_INVITES_KEY) || '{}')
    delete invites[email.toLowerCase()]
    localStorage.setItem(PENDING_INVITES_KEY, JSON.stringify(invites))
  } catch {}
}

export function getPendingInvites() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_INVITES_KEY) || '{}')
  } catch {
    return {}
  }
}

// After friends refresh: for each stored pending invite whose user has now registered
// and sent an incoming friend request, auto-accept it. Returns true if any were accepted.
export async function processIncomingInviteAcceptances(incomingRequests) {
  const invites = getPendingInvites()
  const emails = Object.keys(invites)
  if (!emails.length || !incomingRequests?.length) return false

  let accepted = false
  for (const email of emails) {
    const lookup = await lookupUserByEmail(email)
    if (!lookup.ok || !lookup.found) continue
    const match = incomingRequests.find(req => req.userId === lookup.userId)
    if (!match) continue
    const result = await acceptFriend(lookup.userId)
    if (result.ok) {
      clearPendingInvite(email)
      accepted = true
    }
  }
  return accepted
}

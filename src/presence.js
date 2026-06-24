import { Lobby } from '@accelbyte/sdk-lobby'
import { sdk } from './ags-client.js'

const AVAILABILITY = {
  offline: 0,
  online: 1,
  busy: 2,
}

const ACTIVITY = {
  online: 'online',
  inMatch: 'in-match',
  offline: 'offline',
}

let lobbyWs = null
let lobbyConnected = false
let queuedStatus = null
let currentStatus = 'offline'
let heartbeatTimer = null
let reconnectTimer = null
let reconnectAttempts = 0
let openWaiters = []
let pendingStatusRequests = new Map()
let pendingPersonalChatRequests = new Map()
let presenceListeners = new Set()
let gameInviteListeners = new Set()
let lobbyOpenListeners = new Set()
const knownPresence = new Map()  // userId (normalised) → last confirmed presence

const HEARTBEAT_MS    = 45000    // re-send presence every 45 s to prevent server idle timeout
const RECONNECT_DELAY_MS = 1500  // initial backoff; doubles on each consecutive failure, capped at 60s
const RECONNECT_MAX_MS = 60000
const RECONNECT_MAX_ATTEMPTS = 8 // give up after this many consecutive failures
const OFFLINE_FLUSH_MS = 1000
const CONNECT_TIMEOUT_MS = 2500
const FRIENDS_STATUS_TIMEOUT_MS = 5000

function debugPresence(...args) {
  try {
    if (localStorage.getItem('ags_presence_debug') === '1') {
      console.debug('[AGS presence]', ...args)
    }
  } catch {}
}

try {
  window.agsEnablePresenceDebug = () => localStorage.setItem('ags_presence_debug', '1')
  window.agsDisablePresenceDebug = () => localStorage.removeItem('ags_presence_debug')
} catch {}

function lobbyId() {
  if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '')
  return 'presence-' + Math.random().toString(36).slice(2)
}

function ensureLobbyConnected() {
  if (lobbyWs) return lobbyWs

  lobbyWs = Lobby.WebSocket(sdk)
  lobbyWs.connect()
  lobbyWs.onMessage(raw => {
    const message = parseLobbyMessage(raw)
    debugPresence('message', { raw, message })
    if (message?.type === 'friendsStatusResponse') {
      console.log('[AGS presence] friendsStatusResponse received:', {
        responseId: message.id,
        code: message.code,
        friendIds: message.friendIds || message.friendsId,
        availability: message.availability,
        pendingKeys: [...pendingStatusRequests.keys()],
      })
      const key = normalizeId(message.id)
      const pending = pendingStatusRequests.get(key)
      if (pending) {
        pendingStatusRequests.delete(key)
        pending.resolve(message)
      } else {
        console.warn('[AGS presence] friendsStatusResponse ID not matched — dropped:', message.id)
      }
    } else if (message?.type === 'personalChatResponse') {
      const pending = pendingPersonalChatRequests.get(normalizeId(message.id))
      if (pending) {
        pendingPersonalChatRequests.delete(normalizeId(message.id))
        pending.resolve(message)
      }
    } else if (message?.type === 'personalChatNotif' || message?.type === 'messageNotif') {
      notifyGameInvite(message)
    } else if (message?.type === 'userStatusNotif') {
      notifyPresenceUpdate(message)
    }
  }, true)
  lobbyWs.onOpen(() => {
    lobbyConnected = true
    reconnectAttempts = 0
    debugPresence('open')
    openWaiters.splice(0).forEach(resolve => resolve(true))
    if (queuedStatus) {
      sendPresence(queuedStatus)
      queuedStatus = null
    }
    lobbyOpenListeners.forEach(cb => { try { cb() } catch {} })
  })
  lobbyWs.onClose(() => {
    debugPresence('close')
    lobbyConnected = false
    lobbyWs = null
    pendingStatusRequests.forEach(pending => pending.resolve(null))
    pendingStatusRequests.clear()
    pendingPersonalChatRequests.forEach(pending => pending.resolve(null))
    pendingPersonalChatRequests.clear()
    // Reconnect with exponential backoff if we're supposed to be online.
    if (currentStatus !== 'offline' && !reconnectTimer) {
      if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        console.warn('[AGS presence] giving up reconnect after', reconnectAttempts, 'attempts')
        reconnectAttempts = 0
      } else {
        const delay = Math.min(RECONNECT_DELAY_MS * (2 ** reconnectAttempts), RECONNECT_MAX_MS)
        reconnectAttempts++
        debugPresence('schedule-reconnect', { attempt: reconnectAttempts, delay })
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          if (currentStatus !== 'offline' && !lobbyWs && sdk.getToken()?.accessToken) {
            debugPresence('auto-reconnect')
            sendPresence(currentStatus)
          }
        }, delay)
      }
    }
  })
  lobbyWs.onError(err => {
    const detail = err instanceof ErrorEvent
      ? err.message
      : err instanceof Event
        ? `WebSocket ${err.type} — readyState=${err.target?.readyState}, url=${err.target?.url}`
        : (err?.message || String(err))
    console.warn('[AGS presence] lobby websocket error:', detail)
    debugPresence('error', err)
    openWaiters.splice(0).forEach(resolve => resolve(false))
    pendingStatusRequests.forEach(pending => pending.resolve(null))
    pendingStatusRequests.clear()
    pendingPersonalChatRequests.forEach(pending => pending.resolve(null))
    pendingPersonalChatRequests.clear()
  })
  return lobbyWs
}

function waitForLobbyOpen(timeoutMs = CONNECT_TIMEOUT_MS) {
  if (lobbyConnected) return Promise.resolve(true)
  ensureLobbyConnected()
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    openWaiters.push(opened => {
      clearTimeout(timer)
      resolve(opened)
    })
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sendPresence(status) {
  const ws = ensureLobbyConnected()
  if (!lobbyConnected) {
    queuedStatus = status
    debugPresence('queue-status', status)
    return
  }

  const inMatch = status === 'in-match'
  const payload = {
    id: lobbyId(),
    availability: status === 'offline'
      ? AVAILABILITY.offline
      : inMatch
        ? AVAILABILITY.busy
        : AVAILABILITY.online,
    activity: status === 'offline'
      ? ACTIVITY.offline
      : inMatch
        ? ACTIVITY.inMatch
        : ACTIVITY.online,
  }
  debugPresence('set-status', payload)
  try {
    ws.sendSetUserStatus(payload)
  } catch (e) {
    debugPresence('set-status-error', e?.message || e)
    queuedStatus = status
  }
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (currentStatus !== 'offline' && sdk.getToken()?.accessToken) {
      sendPresence(currentStatus)
    }
  }, HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}

export function setPresenceStatus(status) {
  const token = sdk.getToken()?.accessToken
  if (!token) return
  currentStatus = status === 'in-match'
    ? 'in-match'
    : status === 'offline'
      ? 'offline'
      : 'online'
  sendPresence(currentStatus)
  if (currentStatus !== 'offline') {
    startHeartbeat()
  } else {
    stopHeartbeat()
  }
}

export function disconnectPresence() {
  stopHeartbeat()
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (!lobbyWs) return
  try {
    if (lobbyConnected) {
      sendPresence('offline')
      lobbyWs.sendOfflineNotification({ id: lobbyId() })
    }
    lobbyWs.disconnect()
  } catch (e) {
    console.warn('[AGS presence] disconnect:', e?.message || e)
  } finally {
    currentStatus = 'offline'
    queuedStatus = null
    lobbyWs = null
    lobbyConnected = false
  }
}

export async function signOutPresence() {
  if (!sdk.getToken()?.accessToken) return
  const opened = await waitForLobbyOpen()
  if (opened && lobbyWs) {
    sendPresence('offline')
    lobbyWs.sendOfflineNotification({ id: lobbyId() })
    await sleep(OFFLINE_FLUSH_MS)
  }
  disconnectPresence()
}

export function pausePresence() {
  if (currentStatus === 'offline') return
  disconnectPresence()
}

export function resumePresence() {
  if (!sdk.getToken()?.accessToken) return
  setPresenceStatus('online')
}

export function subscribePresenceUpdates(listener) {
  presenceListeners.add(listener)
  return () => presenceListeners.delete(listener)
}

export function subscribeGameInvites(listener) {
  gameInviteListeners.add(listener)
  return () => gameInviteListeners.delete(listener)
}

export function subscribeLobbyOpen(listener) {
  lobbyOpenListeners.add(listener)
  return () => lobbyOpenListeners.delete(listener)
}

export async function sendGameInvite({ from, to, payload }) {
  const opened = await waitForLobbyOpen()
  if (!opened || !lobbyWs) {
    return { ok: false, error: 'Could not connect to AGS Lobby.' }
  }

  const id = lobbyId()
  const message = {
    id,
    from,
    to,
    payload: JSON.stringify(payload),
    receivedAt: new Date().toISOString(),
  }

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingPersonalChatRequests.delete(id)
      resolve({ ok: false, error: 'Invite request timed out.' })
    }, FRIENDS_STATUS_TIMEOUT_MS)

    pendingPersonalChatRequests.set(id, {
      resolve: response => {
        clearTimeout(timer)
        if (response?.code === 0) {
          resolve({ ok: true })
        } else {
          resolve({ ok: false, error: 'Could not send match invite.' })
        }
      },
    })

    debugPresence('send-game-invite', message)
    try {
      lobbyWs.sendPersonalChat(message)
    } catch (e) {
      pendingPersonalChatRequests.delete(id)
      clearTimeout(timer)
      resolve({ ok: false, error: 'Connection lost while sending invite.' })
    }
  })
}

function notifyPresenceUpdate(message) {
  const userId = message.userId || message.userID
  if (!userId) return
  const presence = normalizePresenceStatus(message)
  knownPresence.set(normalizeId(userId), presence)
  debugPresence('presence-update', { userId, presence, message })
  presenceListeners.forEach(listener => {
    try {
      listener(userId, presence)
    } catch (e) {
      console.warn('[AGS presence] listener:', e?.message || e)
    }
  })
}

function notifyGameInvite(message) {
  let payload = null
  try {
    payload = JSON.parse(message.payload || '{}')
  } catch {
    return
  }
  const knownTypes = ['chess-match-invite', 'chess-match-declined']
  if (!knownTypes.includes(payload?.type)) return
  if (payload.type === 'chess-match-invite' && !payload.peerId) return

  const invite = {
    ...payload,
    fromUserId: payload.fromUserId || message.from,
    toUserId: message.to,
    receivedAt: message.receivedAt,
  }
  debugPresence('game-invite', invite)
  gameInviteListeners.forEach(listener => {
    try {
      listener(invite)
    } catch (e) {
      console.warn('[AGS presence] game invite listener:', e?.message || e)
    }
  })
}

function normalizePresenceStatus(presence) {
  if (!presence) return { status: 'offline', label: 'Offline', activity: '' }

  const availability = String(presence.availability ?? '0').toLowerCase()
  const activity = String(presence.activity || '').toLowerCase()

  if (
    availability === '0' ||
    availability === '3' ||
    availability === 'offline' ||
    availability === 'unavailable' ||
    activity.includes('offline') ||
    activity.includes('logout') ||
    activity.includes('signed-out')
  ) {
    return { status: 'offline', label: 'Offline', activity: presence.activity || '' }
  }
  if (activity.includes('match')) {
    return { status: 'in-match', label: 'In Match', activity: presence.activity || '' }
  }
  return { status: 'online', label: 'Online', activity: presence.activity || '' }
}

function parseLobbyValue(value) {
  const trimmed = String(value || '').trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

function parseLobbyMessage(raw) {
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed)
    } catch {}
  }
  return raw.split('\n').reduce((message, line) => {
    const separator = line.indexOf(':')
    if (separator <= 0) return message
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    message[key] = parseLobbyValue(value)
    return message
  }, {})
}

function normalizeId(id) {
  return String(id || '').replace(/-/g, '')
}

function mapFriendsStatusResponse(response, requestedIds) {
  const byId = {}
  if (response?.code === 0) {
    const friendIds = response.friendIds || response.friendsId || response.friendsIds || response.friendID || response.friendIDs || []
    const availability = response.availability || []
    const activity = response.activity || []
    const lastSeenAt = response.lastSeenAt || []

    friendIds.forEach((friendId, index) => {
      const normalized = normalizeId(friendId)
      const presence = normalizePresenceStatus({
        userID: friendId,
        availability: availability[index],
        activity: activity[index],
        lastSeenAt: lastSeenAt[index],
      })
      byId[normalized] = presence
      knownPresence.set(normalized, presence)
    })
  }

  const result = {}
  for (const id of requestedIds) {
    result[id] = byId[normalizeId(id)] || { status: 'offline', label: 'Offline', activity: '' }
  }
  debugPresence('mapped-friends-status', { response, requestedIds, result })
  return result
}

async function requestFriendsStatus() {
  const opened = await waitForLobbyOpen()
  if (!opened || !lobbyWs) return null

  const id = lobbyId()
  const key = normalizeId(id)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingStatusRequests.delete(key)
      console.warn('[AGS presence] friendsStatusRequest timed out — no response for id:', id)
      resolve(null)
    }, FRIENDS_STATUS_TIMEOUT_MS)

    pendingStatusRequests.set(key, {
      resolve: message => {
        clearTimeout(timer)
        resolve(message)
      },
    })
    console.log('[AGS presence] sendFriendsStatus, id:', id, 'key:', key)
    debugPresence('friends-status-request', { id })
    try {
      lobbyWs.sendFriendsStatus({ id })
    } catch (e) {
      pendingStatusRequests.delete(key)
      clearTimeout(timer)
      resolve(null)
    }
  })
}

export async function fetchPresenceMap(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (!ids.length) return {}

  const fallback = () =>
    Object.fromEntries(ids.map(id => [
      id,
      knownPresence.get(normalizeId(id)) || { status: 'offline', label: 'Offline', activity: '' },
    ]))

  try {
    const response = await requestFriendsStatus()
    if (response === null) {
      // WebSocket unavailable — return last-known presence rather than marking everyone offline
      debugPresence('fetchPresenceMap-fallback', ids)
      return fallback()
    }
    return mapFriendsStatusResponse(response, ids)
  } catch (e) {
    console.warn('[AGS presence] fetchPresenceMap:', e?.response?.data || e?.message)
    return fallback()
  }
}

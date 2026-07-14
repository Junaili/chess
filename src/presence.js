import { Lobby } from '@accelbyte/sdk-lobby'
import { sdk } from './ags-client.js'
import {
  classifyPersonalChatResponse,
  createDeliveryDeduper,
  deliverWithRetry,
  isStaleDelivery,
  serializePersonalChatPayload,
} from './realtime-delivery.mjs'
import { parseMatchFoundNotification } from './matchmaking-recovery.mjs'

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
let openWaiters = new Set()
let pendingStatusRequests = new Map()
let pendingPersonalChatRequests = new Map()
let pendingTokenRefreshRequests = new Map()
let presenceListeners = new Set()
let gameInviteListeners = new Set()
let lobbyOpenListeners = new Set()
let inviteJoinListeners = new Set()
let friendsChangeListeners = new Set()
let matchFoundListeners = new Set()
const knownPresence = new Map()  // userId (normalised) → last confirmed presence
const seenRealtimeDeliveries = createDeliveryDeduper()

const HEARTBEAT_MS    = 45000    // re-send presence every 45 s to prevent server idle timeout
// A brand-new account's just-issued token commonly fails its first Lobby
// connection because the token hasn't yet propagated to the Lobby service —
// a one-shot blip that clears in well under a second (this is what a manual
// hard-refresh was papering over). Retry the first few attempts fast instead
// of making the player wait through a slow backoff; sustained failures fall
// through to the normal capped exponential backoff below.
const FAST_RECONNECT_DELAYS_MS = [300, 800, 1500]
const FAST_RECONNECT_ATTEMPTS = FAST_RECONNECT_DELAYS_MS.length
const RECONNECT_DELAY_MS = 1500  // base for the slow phase; doubles each attempt, capped at 60s
const RECONNECT_MAX_MS = 60000
const RECONNECT_WARN_ATTEMPT = 8
const OFFLINE_FLUSH_MS = 1000
const CONNECT_TIMEOUT_MS = 10000
const FRIENDS_STATUS_TIMEOUT_MS = 5000
const INVITE_MAX_AGE_MS = 10 * 60 * 1000

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
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '')
  return 'presence-' + Math.random().toString(36).slice(2)
}

function settleOpenWaiters(opened) {
  for (const waiter of openWaiters) {
    clearTimeout(waiter.timer)
    waiter.resolve(opened)
  }
  openWaiters.clear()
}

// Tear down a dead socket and schedule a reconnect. Shared by onClose and (for
// connections that never opened) onError, guarded so the two can't double-fire
// for the same failed attempt — whichever runs first nulls out lobbyWs, so the
// other's `lobbyWs !== socket` check makes it a no-op.
function handleSocketDown(socket) {
  if (lobbyWs !== socket) return
  debugPresence('down')
  lobbyConnected = false
  lobbyWs = null
  try { socket.disconnect() } catch {}
  pendingStatusRequests.forEach(pending => pending.resolve(null))
  pendingStatusRequests.clear()
  pendingPersonalChatRequests.forEach(pending => pending.resolve(null))
  pendingPersonalChatRequests.clear()
  pendingTokenRefreshRequests.forEach(pending => pending.resolve(null))
  pendingTokenRefreshRequests.clear()
  if (currentStatus === 'offline') settleOpenWaiters(false)
  scheduleReconnect()
}

function scheduleReconnect() {
  if (currentStatus === 'offline' || reconnectTimer) return
  if (reconnectAttempts === RECONNECT_WARN_ATTEMPT) {
    console.warn('[AGS presence] Lobby is still unavailable; continuing background reconnects')
  }
  const delay = reconnectAttempts < FAST_RECONNECT_ATTEMPTS
    ? FAST_RECONNECT_DELAYS_MS[reconnectAttempts]
    : Math.min(
        RECONNECT_DELAY_MS * (2 ** Math.min(reconnectAttempts - FAST_RECONNECT_ATTEMPTS, 8)),
        RECONNECT_MAX_MS,
      )
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

function ensureLobbyConnected() {
  if (lobbyWs) return lobbyWs
  if (!sdk.getToken()?.accessToken) return null

  let socket
  try {
    socket = Lobby.WebSocket(sdk)
    lobbyWs = socket
    // The generated SDK only lets listeners be registered after connect()
    // creates its native WebSocket. Browser open events are asynchronous, so
    // the listeners below are still attached before the handshake completes.
    socket.connect()
  } catch (error) {
    lobbyWs = null
    lobbyConnected = false
    debugPresence('connect-throw', error?.message || error)
    scheduleReconnect()
    return null
  }
  socket.onMessage(raw => {
    if (lobbyWs !== socket) return
    const message = parseLobbyMessage(raw)
    debugPresence('message', { raw, message })
    if (message?.type === 'friendsStatusResponse') {
      debugPresence('friends-status-response', {
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
      } else debugPresence('unmatched-friends-status-response', message.id)
    } else if (message?.type === 'personalChatResponse') {
      const pending = pendingPersonalChatRequests.get(normalizeId(message.id))
      if (pending) {
        pendingPersonalChatRequests.delete(normalizeId(message.id))
        pending.resolve(message)
      }
    } else if (message?.type === 'errorNotif') {
      // Lobby reports protocol-level failures (including payload-too-large)
      // through errorNotif, not personalChatResponse. Correlate it by request
      // id so the UI gets the real error immediately instead of waiting five
      // seconds, tearing down a healthy socket, and repeating the same send.
      const key = normalizeId(message.id)
      const pending = pendingPersonalChatRequests.get(key)
      if (pending && (!message.requestType || message.requestType === 'personalChatRequest')) {
        pendingPersonalChatRequests.delete(key)
        pending.resolve(message)
      }
    } else if (message?.type === 'refreshTokenResponse') {
      const key = normalizeId(message.id)
      const pending = pendingTokenRefreshRequests.get(key)
      if (pending) {
        pendingTokenRefreshRequests.delete(key)
        pending.resolve(message)
      }
    } else if (message?.type === 'messageNotif' && message?.topic === 'OnMatchFound') {
      notifyMatchFound(message)
    } else if (message?.type === 'personalChatNotif' || message?.type === 'messageNotif') {
      notifyGameInvite(message)
    } else if (message?.type === 'userStatusNotif') {
      notifyPresenceUpdate(message)
    } else if (FRIENDS_NOTIF_TYPES.has(message?.type)) {
      // requestFriendsNotif/acceptFriendsNotif/rejectFriendsNotif/
      // cancelFriendsNotif/unfriendNotif — pushed in real time by Lobby to
      // whichever side didn't initiate the action. Without this, friend-list
      // changes only surfaced via the 15s polling refresh (startFriendsRefresh),
      // which is why an invitee saw their inviter sitting at "pending" for
      // several seconds after being accepted.
      notifyFriendsChange(message)
    }
  }, true)
  socket.onOpen(() => {
    if (lobbyWs !== socket) return
    lobbyConnected = true
    reconnectAttempts = 0
    debugPresence('open')
    settleOpenWaiters(true)
    if (queuedStatus) {
      sendPresence(queuedStatus)
      queuedStatus = null
    }
    lobbyOpenListeners.forEach(listener => {
      try {
        listener()
      } catch (error) {
        console.warn('[AGS presence] Lobby-open listener:', error?.message || error)
      }
    })
  })
  socket.onClose(() => handleSocketDown(socket))
  socket.onError(err => {
    if (lobbyWs !== socket) return
    const detail = typeof ErrorEvent !== 'undefined' && err instanceof ErrorEvent
      ? err.message
      : typeof Event !== 'undefined' && err instanceof Event
        ? `WebSocket ${err.type} — readyState=${err.target?.readyState}, url=${err.target?.url}`
        : (err?.message || String(err))
    // Quiet for the first few fast-retry attempts (see FAST_RECONNECT_*): a
    // brand-new account's just-issued token failing its very first Lobby
    // connection is expected and self-heals almost immediately, not worth a
    // console.warn. Once we're into sustained-failure territory, surface it.
    if (reconnectAttempts >= FAST_RECONNECT_ATTEMPTS) {
      console.warn('[AGS presence] lobby websocket error:', detail)
    } else {
      debugPresence('error (retrying)', detail)
    }
    // A WebSocket error leaves delivery state uncertain whether or not the
    // browser emits a prompt close event. Replace it now; handleSocketDown's
    // identity guard makes a later close event harmless.
    handleSocketDown(socket)
  })
  return socket
}

function waitForLobbyOpen(timeoutMs = CONNECT_TIMEOUT_MS) {
  if (lobbyConnected) return Promise.resolve(true)
  return new Promise(resolve => {
    const waiter = { resolve, timer: null }
    waiter.timer = setTimeout(() => {
      openWaiters.delete(waiter)
      resolve(false)
    }, timeoutMs)
    openWaiters.add(waiter)
    const socket = ensureLobbyConnected()
    if (!socket) {
      clearTimeout(waiter.timer)
      openWaiters.delete(waiter)
      resolve(false)
    }
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sendPresence(status) {
  const ws = ensureLobbyConnected()
  if (!ws || !lobbyConnected) {
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
    handleSocketDown(ws)
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
  const socket = lobbyWs
  try {
    if (socket && lobbyConnected) {
      sendPresence('offline')
      socket.sendOfflineNotification({ id: lobbyId() })
    }
    socket?.disconnect()
  } catch (e) {
    console.warn('[AGS presence] disconnect:', e?.message || e)
  } finally {
    currentStatus = 'offline'
    queuedStatus = null
    lobbyWs = null
    lobbyConnected = false
    reconnectAttempts = 0
    settleOpenWaiters(false)
    pendingStatusRequests.forEach(pending => pending.resolve(null))
    pendingStatusRequests.clear()
    pendingPersonalChatRequests.forEach(pending => pending.resolve(null))
    pendingPersonalChatRequests.clear()
    pendingTokenRefreshRequests.forEach(pending => pending.resolve(null))
    pendingTokenRefreshRequests.clear()
  }
}

// AGS Lobby can retain the previous block relationship for an established
// websocket after the REST unblock call succeeds. Replace that connection so
// personal-chat match invites use the updated safety relationship immediately.
export async function refreshPresenceConnection() {
  const desiredStatus = currentStatus
  const previousSocket = lobbyWs

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  lobbyWs = null
  lobbyConnected = false
  queuedStatus = null
  settleOpenWaiters(false)
  pendingStatusRequests.forEach(pending => pending.resolve(null))
  pendingStatusRequests.clear()
  pendingPersonalChatRequests.forEach(pending => pending.resolve(null))
  pendingPersonalChatRequests.clear()
  pendingTokenRefreshRequests.forEach(pending => pending.resolve(null))
  pendingTokenRefreshRequests.clear()

  try {
    previousSocket?.disconnect()
  } catch (error) {
    debugPresence('refresh-disconnect-error', error?.message || error)
  }

  if (desiredStatus === 'offline' || !sdk.getToken()?.accessToken) return true

  currentStatus = desiredStatus
  sendPresence(desiredStatus)
  startHeartbeat()
  return waitForLobbyOpen(5000)
}

export async function signOutPresence() {
  if (!sdk.getToken()?.accessToken) return
  try {
    const opened = await waitForLobbyOpen()
    if (opened && lobbyWs) {
      sendPresence('offline')
      lobbyWs.sendOfflineNotification({ id: lobbyId() })
      await sleep(OFFLINE_FLUSH_MS)
    }
  } catch (error) {
    console.warn('[AGS presence] offline notification failed:', error?.message || error)
  } finally {
    // Signing out must never be blocked by a failed best-effort Lobby send.
    disconnectPresence()
  }
}

export function pausePresence() {
  if (currentStatus === 'offline') return
  disconnectPresence()
}

export function resumePresence() {
  if (!sdk.getToken()?.accessToken) return
  setPresenceStatus('online')
}

// Keep an established Lobby socket authenticated when the proactive session
// refresh rotates the access token. If the refresh acknowledgement is lost,
// replace the socket so the next connection is guaranteed to use the new token.
export async function refreshPresenceToken(accessToken) {
  if (!accessToken || currentStatus === 'offline') return true
  const opened = await waitForLobbyOpen()
  const socket = lobbyWs
  if (!opened || !socket) {
    if (socket) handleSocketDown(socket)
    return false
  }

  const id = lobbyId()
  const key = normalizeId(id)
  const acknowledged = await new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingTokenRefreshRequests.delete(key)
      resolve(false)
    }, FRIENDS_STATUS_TIMEOUT_MS)
    pendingTokenRefreshRequests.set(key, {
      resolve: response => {
        clearTimeout(timer)
        resolve(response?.code === 0)
      },
    })
    try {
      socket.sendRefreshToken({ id, token: accessToken })
    } catch (error) {
      pendingTokenRefreshRequests.delete(key)
      clearTimeout(timer)
      debugPresence('refresh-token-send-error', error?.message || error)
      resolve(false)
    }
  })

  if (!acknowledged && lobbyWs === socket) {
    handleSocketDown(socket)
  }
  return acknowledged
}

export function subscribePresenceUpdates(listener) {
  presenceListeners.add(listener)
  return () => presenceListeners.delete(listener)
}

export function subscribeGameInvites(listener) {
  gameInviteListeners.add(listener)
  return () => gameInviteListeners.delete(listener)
}

// Lobby push notifications for the friend-relationship lifecycle. Each is only
// delivered to the side that DIDN'T initiate the action (e.g. the accepter's
// client never sees acceptFriendsNotif — it already knows). Fields per the
// Lobby WS protocol: requestFriendsNotif/acceptFriendsNotif/unfriendNotif carry
// `friendId` (the other user); rejectFriendsNotif/cancelFriendsNotif carry
// `userId` instead.
const FRIENDS_NOTIF_TYPES = new Set([
  'requestFriendsNotif',
  'acceptFriendsNotif',
  'rejectFriendsNotif',
  'cancelFriendsNotif',
  'unfriendNotif',
])

function notifyFriendsChange(message) {
  const otherUserId = message.friendId || message.userId || null
  debugPresence('friends-change', message)
  friendsChangeListeners.forEach(listener => {
    try {
      listener({ type: message.type, otherUserId })
    } catch (e) {
      console.warn('[AGS presence] friends-change listener:', e?.message || e)
    }
  })
}

export function subscribeFriendsChanges(listener) {
  friendsChangeListeners.add(listener)
  return () => friendsChangeListeners.delete(listener)
}

export function subscribeLobbyOpen(listener) {
  lobbyOpenListeners.add(listener)
  return () => lobbyOpenListeners.delete(listener)
}

export function subscribeInviteJoins(listener) {
  inviteJoinListeners.add(listener)
  return () => inviteJoinListeners.delete(listener)
}

export function subscribeMatchFound(listener) {
  matchFoundListeners.add(listener)
  return () => matchFoundListeners.delete(listener)
}

function notifyMatchFound(message) {
  const match = parseMatchFoundNotification(message)
  if (!match) return
  debugPresence('match-found', match)
  matchFoundListeners.forEach(listener => {
    try {
      listener(match)
    } catch (error) {
      console.warn('[AGS presence] match-found listener:', error?.message || error)
    }
  })
}

async function sendPersonalChatOnce({ from, to, payload }) {
  const serialized = serializePersonalChatPayload(payload)
  if (!serialized.ok) {
    return { ok: false, retryable: false, error: serialized.error }
  }
  const opened = await waitForLobbyOpen()
  const socket = lobbyWs
  if (!opened || !socket) {
    return { ok: false, retryable: true, error: 'Could not connect to AGS Lobby.' }
  }

  const id = lobbyId()
  const key = normalizeId(id)
  const message = {
    id,
    from,
    to,
    payload: serialized.value,
    receivedAt: new Date().toISOString(),
  }

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingPersonalChatRequests.delete(key)
      if (lobbyWs === socket) handleSocketDown(socket)
      resolve({ ok: false, retryable: true, error: 'Invite delivery timed out.' })
    }, FRIENDS_STATUS_TIMEOUT_MS)

    pendingPersonalChatRequests.set(key, {
      resolve: response => {
        clearTimeout(timer)
        const result = classifyPersonalChatResponse(response)
        if (!result.ok) {
          debugPresence('personal-chat-rejected', {
            code: response?.code,
            requestType: response?.requestType,
            type: payload?.type,
          })
        }
        resolve(result)
      },
    })

    debugPresence('send-personal-chat', { id, from, to, type: payload?.type })
    try {
      socket.sendPersonalChat(message)
    } catch (error) {
      pendingPersonalChatRequests.delete(key)
      clearTimeout(timer)
      handleSocketDown(socket)
      resolve({ ok: false, retryable: true, error: 'Connection lost while sending the invite.' })
    }
  })
}

async function deliverPersonalPayload({ from, to, payload }) {
  if (!from || !to) {
    return { ok: false, retryable: false, error: 'Invite sender and recipient are required.', attempts: 0 }
  }
  const result = await deliverWithRetry(() => sendPersonalChatOnce({ from, to, payload }))
  const { cause, ...safeResult } = result
  debugPresence('personal-chat-delivery', {
    type: payload?.type,
    deliveryId: payload?.deliveryId || payload?.inviteId,
    ok: safeResult.ok,
    attempts: safeResult.attempts,
  })
  return safeResult
}

export async function sendInviteJoinNotification({ to, fromUserId, fromName }) {
  const sentAt = new Date().toISOString()
  const deliveryId = `join-${lobbyId()}`
  return deliverPersonalPayload({
    from: fromUserId,
    to,
    payload: {
      type: 'chess-invite-clicked',
      deliveryId,
      fromUserId,
      fromName,
      sentAt,
    },
  })
}

export async function sendGameInvite({ from, to, payload }) {
  const deliveryId = payload?.inviteId || payload?.deliveryId || `invite-${lobbyId()}`
  return deliverPersonalPayload({
    from,
    to,
    payload: {
      ...payload,
      deliveryId,
      sentAt: payload?.sentAt || new Date().toISOString(),
    },
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
  if (isStaleDelivery(payload?.sentAt, INVITE_MAX_AGE_MS)) {
    debugPresence('stale-realtime-delivery', { type: payload?.type, sentAt: payload?.sentAt })
    return
  }
  const fromUserId = payload?.fromUserId || message.from
  const knownTypes = ['chess-invite-clicked', 'chess-match-invite', 'chess-match-declined']
  if (!knownTypes.includes(payload?.type) || !fromUserId) return
  if (payload.type === 'chess-match-invite' && !payload.peerId) return

  const deliveryId = payload?.inviteId || payload?.deliveryId || message.id
  if (seenRealtimeDeliveries.isDuplicate(`${payload?.type}:${fromUserId}:${deliveryId}`)) {
    debugPresence('duplicate-realtime-delivery', { type: payload?.type, deliveryId })
    return
  }
  if (payload?.type === 'chess-invite-clicked') {
    const join = {
      fromUserId,
      fromName: payload.fromName || null,
    }
    debugPresence('invite-join', join)
    inviteJoinListeners.forEach(listener => {
      try {
        listener(join)
      } catch (error) {
        console.warn('[AGS presence] invite-join listener:', error?.message || error)
      }
    })
    return
  }

  const invite = {
    ...payload,
    fromUserId,
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
      debugPresence('friends-status-timeout', { id })
      resolve(null)
    }, FRIENDS_STATUS_TIMEOUT_MS)

    pendingStatusRequests.set(key, {
      resolve: message => {
        clearTimeout(timer)
        resolve(message)
      },
    })
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

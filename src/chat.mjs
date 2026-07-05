const RPC_VERSION = '2.0'
const ENVELOPE_START = 'CaSr'
const ENVELOPE_END = 'CaEd'
const REQUEST_TIMEOUT_MS = 10_000
const SESSION_TOPIC_TIMEOUT_MS = 15_000
const SESSION_TOPIC_RETRY_INTERVAL_MS = 500
const MAX_RECONNECT_ATTEMPTS = 5

export class AgsChatError extends Error {
  constructor(message, { code = null, kind = 'service', cause = null } = {}) {
    super(message)
    this.name = 'AgsChatError'
    this.code = code
    this.kind = kind
    this.cause = cause
  }
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function chatWebSocketUrl(baseURL, sessionId = '') {
  const url = new URL(baseURL)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = '/chat/'
  url.search = ''
  url.hash = ''
  if (sessionId) url.searchParams.set('X-Ab-ChatSessionID', sessionId)
  url.searchParams.set('X-Ab-RpcEnvelopeStart', ENVELOPE_START)
  url.searchParams.set('X-Ab-RpcEnvelopeEnd', ENVELOPE_END)
  return url.toString()
}

function normalizeTimestamp(value) {
  if (typeof value === 'number') {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function normalizeMessage(value, fallbackTopicId = '') {
  if (!value || typeof value !== 'object') return null
  const chatId = String(value.chatId || value.id || '').trim()
  const message = String(value.message || '').trim()
  const topicId = String(value.topicId || fallbackTopicId || '').trim()
  const from = String(value.from || value.senderId || '').trim()
  if (!chatId || !message || !topicId || !from) return null
  return {
    chatId,
    message,
    topicId,
    from,
    createdAt: normalizeTimestamp(value.createdAt ?? value.receivedAt),
  }
}

function classifyError(error) {
  const code = error?.code ?? error?.Code ?? null
  const rawMessage = error?.message || error?.Message || 'AGS Chat request failed.'
  const message = String(rawMessage)
  const searchable = `${code || ''} ${message}`.toLowerCase()
  let kind = 'service'
  if (searchable.includes('mute')) kind = 'muted'
  else if (searchable.includes('ban')) kind = 'banned'
  else if (searchable.includes('profan') || searchable.includes('filter')) kind = 'filtered'
  else if (searchable.includes('rate') || searchable.includes('too many') || searchable.includes('spam')) kind = 'rate-limit'
  else if (searchable.includes('token') || searchable.includes('auth')) kind = 'authentication'
  else if (searchable.includes('topic') || searchable.includes('member')) kind = 'topic'
  return new AgsChatError(message, { code, kind, cause: error })
}

export class AgsChatClient {
  constructor({
    baseURL,
    namespace,
    getAccessToken,
    getUserId,
    loadHistory = null,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    sessionTopicTimeoutMs = SESSION_TOPIC_TIMEOUT_MS,
    sessionTopicRetryIntervalMs = SESSION_TOPIC_RETRY_INTERVAL_MS,
  }) {
    this.baseURL = baseURL
    this.namespace = namespace
    this.getAccessToken = getAccessToken
    this.getUserId = getUserId
    this.loadHistory = loadHistory
    this.WebSocketImpl = WebSocketImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.sessionTopicTimeoutMs = sessionTopicTimeoutMs
    this.sessionTopicRetryIntervalMs = sessionTopicRetryIntervalMs

    this.socket = null
    this.chatSessionId = ''
    this.state = 'idle'
    this.stateDetail = ''
    this.activeTopicId = ''
    this.activeContext = null
    this.knownSessionTopics = new Set()
    this.sessionTopicsAtPrepare = new Set()
    this.seenChats = new Map()
    this.pendingRequests = new Map()
    this.stateListeners = new Set()
    this.messageListeners = new Set()
    this.topicWaiters = new Set()
    this.fragmentBuffer = ''
    this.connectPromise = null
    this.connectResolve = null
    this.connectReject = null
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.restoreOnConnect = false
    this.activationGeneration = 0
    this.desiredConnected = false
    this.explicitDisconnect = false
  }

  subscribeState(listener) {
    this.stateListeners.add(listener)
    listener({ state: this.state, detail: this.stateDetail, topicId: this.activeTopicId })
    return () => this.stateListeners.delete(listener)
  }

  subscribeMessages(listener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  snapshot() {
    return {
      state: this.state,
      detail: this.stateDetail,
      topicId: this.activeTopicId,
      connected: this._socketIsOpen(),
      ready: this.state === 'ready' && !!this.activeTopicId,
    }
  }

  async connect() {
    this.desiredConnected = true
    this.explicitDisconnect = false
    if (this._socketIsOpen() &&
        (this.state === 'connected' || this.state === 'ready' || this.state === 'activating')) {
      return this.snapshot()
    }
    if (this.connectPromise) return this.connectPromise
    return this._openSocket(false)
  }

  prepareSessionChat() {
    this.sessionTopicsAtPrepare = new Set(this.knownSessionTopics)
    this.deactivateTopic()
  }

  async activateSessionChat(sessionId) {
    if (!sessionId) {
      throw new AgsChatError('The match did not provide an AGS session ID.', { kind: 'topic' })
    }
    const generation = ++this.activationGeneration
    this.activeContext = { type: 'session', sessionId }
    this._setState('activating', 'Connecting to match chat…')
    await this.connect()
    this._assertActiveGeneration(generation)

    const directMatch = [...this.knownSessionTopics].find(topicId => topicId.includes(sessionId))
    const newTopics = [...this.knownSessionTopics].filter(
      topicId => !this.sessionTopicsAtPrepare.has(topicId)
    )
    const expectedTopicId = `s.${sessionId}`
    let topicId = directMatch || (newTopics.length === 1 ? newTopics[0] : expectedTopicId)

    try {
      await this._activateTopic(topicId, generation)
      return this.snapshot()
    } catch (firstError) {
      this._assertActiveGeneration(generation)
      topicId = await this._waitForSessionTopic(sessionId)
      this._assertActiveGeneration(generation)
      await this._activateSessionTopicWithRetry(topicId, generation)
      return this.snapshot()
    }
  }

  async activatePersonalChat(otherUserId) {
    const currentUserId = this.getUserId?.()
    if (!currentUserId || !otherUserId) {
      throw new AgsChatError(
        'Chat is unavailable because both players must be signed in.',
        { kind: 'authentication' }
      )
    }
    const generation = ++this.activationGeneration
    this.activeContext = { type: 'personal', otherUserId }
    this._setState('activating', 'Connecting to private match chat…')
    await this.connect()
    this._assertActiveGeneration(generation)
    const result = await this._request('actionCreateTopic', {
      namespace: this.namespace,
      type: 'PERSONAL',
      members: [currentUserId, otherUserId],
      isJoinable: false,
    })
    this._assertActiveGeneration(generation)
    const topicId = String(result?.topicId || '').trim()
    if (!topicId) {
      throw new AgsChatError('AGS Chat did not return a personal topic.', { kind: 'topic' })
    }
    await this._activateTopic(topicId, generation)
    return this.snapshot()
  }

  async send(message) {
    const text = String(message || '').trim()
    if (!text) throw new AgsChatError('Enter a message first.', { kind: 'validation' })
    if (!this.activeTopicId || this.state !== 'ready') {
      throw new AgsChatError('Match chat is not connected yet.', { kind: 'connection' })
    }

    try {
      const result = await this._request('sendChat', {
        topicId: this.activeTopicId,
        message: text,
      })
      const chat = normalizeMessage({
        chatId: result?.chatId,
        topicId: result?.topicId || this.activeTopicId,
        from: this.getUserId?.(),
        message: text,
        createdAt: result?.processed,
      })
      if (chat) this._emitMessage(chat, 'send')
      return chat || result
    } catch (error) {
      const classified = error instanceof AgsChatError ? error : classifyError(error)
      this._applyErrorState(classified)
      throw classified
    }
  }

  async refreshToken(newToken) {
    if (!newToken || !this._socketIsOpen()) return false
    try {
      await this._request('actionRefreshToken', { token: newToken })
      return true
    } catch {
      this._closeSocketForReconnect()
      return false
    }
  }

  deactivateTopic() {
    this.activationGeneration += 1
    this._rejectTopicWaiters(new AgsChatError('Chat activation cancelled.', { kind: 'cancelled' }))
    this.activeTopicId = ''
    this.activeContext = null
    this.seenChats.clear()
    if (this._socketIsOpen()) this._setState('connected', 'Connected to AGS Chat')
    else if (this.desiredConnected) this._setState('connecting', 'Connecting to AGS Chat…')
    else this._setState('idle', '')
  }

  disconnect() {
    this.desiredConnected = false
    this.explicitDisconnect = true
    this.activeTopicId = ''
    this.activeContext = null
    this.chatSessionId = ''
    this.fragmentBuffer = ''
    this.knownSessionTopics.clear()
    this.sessionTopicsAtPrepare.clear()
    this.seenChats.clear()
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.activationGeneration += 1
    this._rejectTopicWaiters(new AgsChatError('Chat activation cancelled.', { kind: 'cancelled' }))
    this._rejectPending(new AgsChatError('AGS Chat disconnected.', { kind: 'connection' }))
    this._rejectConnect(new AgsChatError('AGS Chat disconnected.', { kind: 'connection' }))
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < 2) {
      try { socket.close(1000, 'logout') } catch {}
    }
    this._setState('idle', '')
  }

  _openSocket(isReconnect) {
    const token = this.getAccessToken?.()
    if (!token) {
      const error = new AgsChatError('Sign in to use match chat.', { kind: 'authentication' })
      this._setState('unavailable', error.message)
      return Promise.reject(error)
    }
    if (!this.WebSocketImpl) {
      const error = new AgsChatError('WebSocket is not available on this device.', { kind: 'connection' })
      this._setState('unavailable', error.message)
      return Promise.reject(error)
    }

    this.restoreOnConnect = isReconnect && !!this.activeContext
    this._setState(isReconnect ? 'reconnecting' : 'connecting', isReconnect
      ? 'Reconnecting match chat…'
      : 'Connecting to AGS Chat…')
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
    })

    let socket
    try {
      socket = new this.WebSocketImpl(chatWebSocketUrl(this.baseURL, this.chatSessionId), token)
    } catch (cause) {
      const error = new AgsChatError('Could not open AGS Chat.', { kind: 'connection', cause })
      const failedPromise = this.connectPromise
      this._rejectConnect(error)
      this._setState('unavailable', error.message)
      return failedPromise
    }

    this.socket = socket
    socket.addEventListener('message', event => {
      this._receive(event.data).catch(error => console.warn('[Chat] invalid message:', error))
    })
    socket.addEventListener('error', () => {
      if (!this._socketIsOpen() && this.connectReject) {
        this._rejectConnect(new AgsChatError('Could not connect to AGS Chat.', { kind: 'connection' }))
      }
    })
    socket.addEventListener('close', event => {
      if (this.socket === socket) this._handleClose(event)
    })
    return this.connectPromise
  }

  async _receive(rawData) {
    let raw = rawData
    if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw)
    else if (typeof Blob !== 'undefined' && raw instanceof Blob) raw = await raw.text()
    if (typeof raw !== 'string') return

    const complete = this._processFragment(raw)
    if (!complete) return
    const payload = JSON.parse(complete)

    if (payload.id && this.pendingRequests.has(payload.id)) {
      const pending = this.pendingRequests.get(payload.id)
      clearTimeout(pending.timer)
      this.pendingRequests.delete(payload.id)
      if (payload.error) pending.reject(classifyError(payload.error))
      else pending.resolve(payload.result ?? payload.params ?? {})
      return
    }

    const params = payload.params || {}
    switch (payload.method) {
      case 'eventConnected': {
        const shouldRestore = this.restoreOnConnect
        this.restoreOnConnect = false
        this.chatSessionId = String(params.sessionId || '')
        this.reconnectAttempts = 0
        this._setState(this.activeTopicId ? 'ready' : 'connected', 'Connected to AGS Chat')
        this._resolveConnect()
        if (shouldRestore && this.activeContext && !this.activeTopicId) {
          this._restoreActiveContext().catch(error => {
            this._setState('unavailable', error.message || 'Match chat is unavailable.')
          })
        }
        break
      }
      case 'eventAddedToTopic':
        this._handleAddedTopic(params)
        break
      case 'eventRemovedFromTopic':
      case 'eventTopicDeleted':
        if (params.topicId === this.activeTopicId) {
          this.activeTopicId = ''
          this._setState('unavailable', 'This match chat is no longer available.')
        }
        break
      case 'eventNewChat': {
        const chat = normalizeMessage(params)
        if (chat && chat.topicId === this.activeTopicId) this._emitMessage(chat, 'event')
        break
      }
      case 'eventUserMuted':
        if (!params.topicId || params.topicId === this.activeTopicId) {
          this._setState('muted', 'You are temporarily muted in match chat.')
        }
        break
      case 'eventUserUnmuted':
        if (!params.topicId || params.topicId === this.activeTopicId) {
          this._setState(this.activeTopicId ? 'ready' : 'connected', 'Connected to AGS Chat')
        }
        break
      case 'eventBanChat':
      case 'eventTopicBanChat':
      case 'eventUserBanned':
        this._setState('unavailable', 'Chat is unavailable for this account.')
        break
      case 'eventServerShutdown':
      case 'eventDisconnected':
        this._closeSocketForReconnect()
        break
      default:
        break
    }
  }

  _processFragment(raw) {
    const starts = raw.startsWith(ENVELOPE_START)
    const ends = raw.endsWith(ENVELOPE_END)
    if (!starts && !ends && !this.fragmentBuffer) return raw
    if (starts && ends) return raw.slice(ENVELOPE_START.length, -ENVELOPE_END.length)
    if (starts) {
      this.fragmentBuffer = raw.slice(ENVELOPE_START.length)
      return ''
    }
    if (!ends) {
      this.fragmentBuffer += raw
      return ''
    }
    const complete = this.fragmentBuffer + raw.slice(0, -ENVELOPE_END.length)
    this.fragmentBuffer = ''
    return complete
  }

  _request(method, params = {}) {
    if (!this._socketIsOpen()) {
      return Promise.reject(new AgsChatError('AGS Chat is disconnected.', { kind: 'connection' }))
    }
    const id = randomId()
    const payload = JSON.stringify({ jsonrpc: RPC_VERSION, id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new AgsChatError(`AGS Chat ${method} timed out.`, { kind: 'timeout' }))
      }, this.requestTimeoutMs)
      this.pendingRequests.set(id, { resolve, reject, timer, method })
      try {
        this.socket.send(payload)
      } catch (cause) {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(new AgsChatError('Could not send to AGS Chat.', { kind: 'connection', cause }))
      }
    })
  }

  async _activateTopic(topicId, generation) {
    this._assertActiveGeneration(generation)
    this.activeTopicId = topicId
    this.seenChats.clear()
    let history
    try {
      history = await this._loadTopicHistory(topicId)
    } catch (error) {
      if (generation === this.activationGeneration && this.activeTopicId === topicId) {
        this.activeTopicId = ''
      }
      throw error
    }
    this._assertActiveGeneration(generation)
    for (const item of history.sort((a, b) => a.createdAt - b.createdAt)) {
      this._emitMessage(item, 'history')
    }
    this._setState('ready', 'Connected')
  }

  async _activateSessionTopicWithRetry(topicId, generation) {
    const deadline = Date.now() + this.sessionTopicTimeoutMs
    while (true) {
      try {
        await this._activateTopic(topicId, generation)
        return
      } catch (error) {
        this._assertActiveGeneration(generation)
        const classified = error instanceof AgsChatError ? error : classifyError(error)
        if (classified.kind !== 'topic' || Date.now() >= deadline) throw classified
        await new Promise(resolve => setTimeout(resolve, this.sessionTopicRetryIntervalMs))
        this._assertActiveGeneration(generation)
      }
    }
  }

  async _loadTopicHistory(topicId) {
    const normalizedTopicId = String(topicId || '')
    // AGS personal topic IDs begin with "#". The generated REST SDK inserts the
    // topic into the URL without encoding it, so browsers interpret the topic
    // and "/chats" suffix as a fragment. Query personal and session history over
    // the already-connected Chat WebSocket instead.
    const useRestHistory = this.loadHistory &&
      !normalizedTopicId.startsWith('s.') &&
      !normalizedTopicId.startsWith('#')
    if (useRestHistory) {
      try {
        const data = await this.loadHistory(topicId)
        return (Array.isArray(data) ? data : [])
          .map(item => normalizeMessage(item, topicId))
          .filter(Boolean)
      } catch (error) {
        console.warn('[Chat] REST history unavailable, using WebSocket:', error?.message || error)
      }
    }
    const result = await this._request('queryChat', {
      topicId,
      limit: 100,
      lastChatCreatedAt: 0,
    })
    return (Array.isArray(result?.data) ? result.data : [])
      .map(item => normalizeMessage(item, topicId))
      .filter(Boolean)
  }

  _handleAddedTopic(params) {
    const topicId = String(params.topicId || '').trim()
    if (!topicId) return
    if (topicId.startsWith('s.')) this.knownSessionTopics.add(topicId)
    for (const waiter of [...this.topicWaiters]) {
      if (waiter.matches(topicId)) {
        clearTimeout(waiter.timer)
        this.topicWaiters.delete(waiter)
        waiter.resolve(topicId)
      }
    }
  }

  _waitForSessionTopic(sessionId) {
    const existing = [...this.knownSessionTopics].find(topicId =>
      topicId.includes(sessionId) || !this.sessionTopicsAtPrepare.has(topicId)
    )
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = {
        matches: topicId => topicId.startsWith('s.') &&
          (topicId.includes(sessionId) || !this.sessionTopicsAtPrepare.has(topicId)),
        resolve,
        reject,
        timer: null,
      }
      waiter.timer = setTimeout(() => {
        this.topicWaiters.delete(waiter)
        reject(new AgsChatError(
          'The AGS session chat topic was not created. Verify textChat is enabled for chess-quickmatch.',
          { kind: 'topic' }
        ))
      }, this.sessionTopicTimeoutMs)
      this.topicWaiters.add(waiter)
    })
  }

  async _restoreActiveContext() {
    const context = this.activeContext
    if (!context) return
    if (context.type === 'session') await this.activateSessionChat(context.sessionId)
    else if (context.type === 'personal') await this.activatePersonalChat(context.otherUserId)
  }

  _assertActiveGeneration(generation) {
    if (generation !== this.activationGeneration) {
      throw new AgsChatError('Chat activation cancelled.', { kind: 'cancelled' })
    }
  }

  _emitMessage(chat, source) {
    if (!chat?.chatId) return
    const previous = this.seenChats.get(chat.chatId)
    if (previous) {
      if (source === 'event' &&
          previous.source === 'send' &&
          previous.message !== chat.message) {
        const updated = { ...chat, source: 'update' }
        this.seenChats.set(chat.chatId, updated)
        for (const listener of this.messageListeners) listener(updated)
      }
      return
    }
    const event = { ...chat, source }
    this.seenChats.set(chat.chatId, event)
    if (this.seenChats.size > 1000) {
      this.seenChats.delete(this.seenChats.keys().next().value)
    }
    for (const listener of this.messageListeners) listener(event)
  }

  _applyErrorState(error) {
    if (error.kind === 'muted') this._setState('muted', 'You are temporarily muted in match chat.')
    else if (error.kind === 'banned') this._setState('unavailable', 'Chat is unavailable for this account.')
    else if (error.kind === 'rate-limit') this._setState('ready', 'Slow down before sending another message.')
    else if (error.kind === 'filtered') this._setState('ready', 'That message was rejected by the chat filter.')
  }

  _closeSocketForReconnect() {
    if (this.socket && this.socket.readyState < 2) {
      try { this.socket.close(4000, 'reconnect') } catch {}
    }
  }

  _handleClose() {
    this.socket = null
    this.fragmentBuffer = ''
    this.activeTopicId = ''
    this._rejectPending(new AgsChatError('AGS Chat connection closed.', { kind: 'connection' }))
    this._rejectConnect(new AgsChatError('AGS Chat connection closed.', { kind: 'connection' }))
    if (!this.desiredConnected || this.explicitDisconnect) {
      this._setState('idle', '')
      return
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._setState('unavailable', 'Match chat could not reconnect.')
      return
    }
    const delay = Math.min(16_000, 1000 * (2 ** this.reconnectAttempts))
    this.reconnectAttempts += 1
    this._setState('reconnecting', 'Reconnecting match chat…')
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.connectPromise = null
      this._openSocket(true).catch(() => {})
    }, delay)
  }

  _socketIsOpen() {
    return !!this.socket && this.socket.readyState === (this.WebSocketImpl.OPEN ?? 1)
  }

  _setState(state, detail) {
    this.state = state
    this.stateDetail = detail || ''
    const event = { state, detail: this.stateDetail, topicId: this.activeTopicId }
    for (const listener of this.stateListeners) listener(event)
  }

  _resolveConnect() {
    const resolve = this.connectResolve
    this.connectPromise = null
    this.connectResolve = null
    this.connectReject = null
    if (resolve) resolve(this.snapshot())
  }

  _rejectConnect(error) {
    const reject = this.connectReject
    this.connectPromise = null
    this.connectResolve = null
    this.connectReject = null
    if (reject) reject(error)
  }

  _rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  _rejectTopicWaiters(error) {
    for (const waiter of this.topicWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.topicWaiters.clear()
  }
}

export function createAgsChatClient(options) {
  return new AgsChatClient(options)
}

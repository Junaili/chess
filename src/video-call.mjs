export const VIDEO_PROFILES = Object.freeze({
  high: Object.freeze({
    name: 'high',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 1_600_000,
    scaleResolutionDownBy: 1,
  }),
  medium: Object.freeze({
    name: 'medium',
    width: 960,
    height: 540,
    frameRate: 24,
    maxBitrate: 900_000,
    scaleResolutionDownBy: 4 / 3,
  }),
  low: Object.freeze({
    name: 'low',
    width: 640,
    height: 360,
    frameRate: 20,
    maxBitrate: 450_000,
    scaleResolutionDownBy: 2,
  }),
})

const PROFILE_ORDER = ['high', 'medium', 'low']
const ICE_FETCH_TIMEOUT_MS = 3_000
const ICE_FAILURE_RETRY_MS = 60_000
const ICE_EXPIRY_SAFETY_MS = 60_000

function selectedProfile(name) {
  return VIDEO_PROFILES[name] || VIDEO_PROFILES.high
}

function preferredDevice(deviceId) {
  return deviceId ? { exact: String(deviceId) } : undefined
}

export function buildCallMediaConstraints({
  profile = 'high',
  audioDeviceId = '',
  videoDeviceId = '',
  facingMode = 'user',
} = {}) {
  const videoProfile = selectedProfile(profile)
  const video = {
    width: { ideal: videoProfile.width },
    height: { ideal: videoProfile.height },
    frameRate: { ideal: videoProfile.frameRate, max: videoProfile.frameRate },
    aspectRatio: { ideal: 16 / 9 },
  }
  const selectedVideoDevice = preferredDevice(videoDeviceId)
  if (selectedVideoDevice) video.deviceId = selectedVideoDevice
  else video.facingMode = { ideal: facingMode === 'environment' ? 'environment' : 'user' }

  const audio = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    sampleSize: { ideal: 16 },
  }
  const selectedAudioDevice = preferredDevice(audioDeviceId)
  if (selectedAudioDevice) audio.deviceId = selectedAudioDevice

  return { audio, video }
}

function normalizeUrls(value) {
  const urls = Array.isArray(value) ? value : [value]
  return urls
    .filter(url => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url.trim()))
    .map(url => url.trim())
    .slice(0, 8)
}

function normalizeIceServer(server) {
  if (!server || typeof server !== 'object') return null
  const urls = normalizeUrls(server.urls || server.url)
  if (!urls.length) return null
  const usesTurn = urls.some(url => /^turns?:/i.test(url))
  if (usesTurn && (typeof server.username !== 'string' || typeof server.credential !== 'string')) {
    return null
  }
  const normalized = { urls: urls.length === 1 ? urls[0] : urls }
  if (typeof server.username === 'string') normalized.username = server.username
  if (typeof server.credential === 'string') normalized.credential = server.credential
  if (server.credentialType === 'password') normalized.credentialType = 'password'
  return normalized
}

function parseExpiry(source, now) {
  const explicit = source?.expiresAt ?? source?.expires_at
  if (explicit) {
    const asNumber = Number(explicit)
    if (Number.isFinite(asNumber)) return asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber
    const parsed = Date.parse(explicit)
    if (Number.isFinite(parsed)) return parsed
  }
  const ttl = Number(source?.ttl ?? source?.ttlSeconds ?? source?.ttl_seconds)
  return Number.isFinite(ttl) && ttl > 0 ? now + ttl * 1000 : now + 10 * 60_000
}

export function normalizeIceConfiguration(payload, now = Date.now()) {
  const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const rawServers = Array.isArray(source)
    ? source
    : source?.iceServers || source?.ice_servers || source?.servers
  if (!Array.isArray(rawServers)) return null
  const iceServers = rawServers.map(normalizeIceServer).filter(Boolean).slice(0, 12)
  if (!iceServers.length) return null
  return {
    iceServers,
    expiresAt: parseExpiry(source, now),
    hasTurn: iceServers.some(server => normalizeUrls(server.urls).some(url => /^turns?:/i.test(url))),
  }
}

function number(value) {
  if (value === null || value === undefined || value === '') return null
  return Number.isFinite(Number(value)) ? Number(value) : null
}

function rounded(value, digits = 0) {
  const numeric = number(value)
  if (numeric === null) return null
  const factor = 10 ** digits
  return Math.round(numeric * factor) / factor
}

function statsValues(report) {
  if (!report) return []
  if (typeof report.values === 'function') return Array.from(report.values())
  if (typeof report.forEach === 'function') {
    const values = []
    report.forEach(value => values.push(value))
    return values
  }
  return Array.isArray(report) ? report : []
}

function bitrateKbps(current, previous, bytesKey) {
  const bytes = number(current?.[bytesKey])
  const oldBytes = number(previous?.[bytesKey])
  const timestamp = number(current?.timestamp)
  const oldTimestamp = number(previous?.timestamp)
  if (bytes === null || oldBytes === null || timestamp === null || oldTimestamp === null) return null
  const elapsedMs = timestamp - oldTimestamp
  const byteDelta = bytes - oldBytes
  if (elapsedMs <= 0 || byteDelta < 0) return null
  return (byteDelta * 8) / elapsedMs
}

function packetLossPercent(current, previous) {
  const received = number(current?.packetsReceived)
  const oldReceived = number(previous?.packetsReceived)
  const lost = number(current?.packetsLost)
  const oldLost = number(previous?.packetsLost)
  if ([received, oldReceived, lost, oldLost].some(value => value === null)) return null
  const receivedDelta = Math.max(0, received - oldReceived)
  const lostDelta = Math.max(0, lost - oldLost)
  const total = receivedDelta + lostDelta
  return total > 0 ? (lostDelta / total) * 100 : 0
}

function codecName(stat, byId) {
  const codec = stat?.codecId ? byId.get(stat.codecId) : null
  return typeof codec?.mimeType === 'string' ? codec.mimeType.slice(0, 40) : ''
}

function emptyRtpSample() {
  return {
    bitrateKbps: null,
    packetLossPercent: null,
    jitterMs: null,
    width: null,
    height: null,
    framesPerSecond: null,
    freezeCount: null,
    totalFreezeDurationMs: null,
    jitterBufferDelayMs: null,
    codec: '',
    qualityLimitationReason: '',
  }
}

export function classifyCallQuality(sample) {
  const state = sample?.connection?.state
  if (state && !['connected', 'completed'].includes(state)) return 'connecting'
  const rtt = number(sample?.network?.rttMs)
  const losses = [
    number(sample?.inbound?.audio?.packetLossPercent),
    number(sample?.inbound?.video?.packetLossPercent),
  ].filter(value => value !== null)
  const maxLoss = losses.length ? Math.max(...losses) : 0
  const audioJitter = number(sample?.inbound?.audio?.jitterMs) || 0
  const inboundFps = number(sample?.inbound?.video?.framesPerSecond)
  const limitedByBandwidth = sample?.outbound?.video?.qualityLimitationReason === 'bandwidth'
  const hasQualitySignal = rtt !== null || losses.length > 0 || audioJitter > 0 ||
    inboundFps !== null || number(sample?.outbound?.video?.bitrateKbps) !== null
  if (!hasQualitySignal) return 'connecting'

  if ((rtt !== null && rtt >= 500) || maxLoss >= 8 || audioJitter >= 60 ||
      (inboundFps !== null && inboundFps > 0 && inboundFps < 12)) return 'poor'
  if ((rtt !== null && rtt >= 250) || maxLoss >= 3 || audioJitter >= 30 || limitedByBandwidth ||
      (inboundFps !== null && inboundFps > 0 && inboundFps < 18)) return 'fair'
  return 'good'
}

export function summarizeRtcStats(report, previousById = new Map()) {
  const values = statsValues(report)
  const byId = new Map(values.filter(stat => stat?.id).map(stat => [stat.id, stat]))
  const nextById = new Map()
  const sample = {
    capturedAt: new Date().toISOString(),
    connection: { state: '' },
    network: {
      rttMs: null,
      availableOutgoingBitrateKbps: null,
      localCandidateType: '',
      remoteCandidateType: '',
      protocol: '',
      relayProtocol: '',
      relayed: false,
    },
    inbound: { audio: emptyRtpSample(), video: emptyRtpSample() },
    outbound: { audio: emptyRtpSample(), video: emptyRtpSample() },
  }

  let selectedPair = null
  for (const stat of values) {
    if (stat?.id) nextById.set(stat.id, stat)
    if (stat?.type === 'transport' && stat.selectedCandidatePairId) {
      selectedPair = byId.get(stat.selectedCandidatePairId) || selectedPair
    }
    if (stat?.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.selected || stat.nominated)) {
      selectedPair = stat
    }
    if (!['inbound-rtp', 'outbound-rtp'].includes(stat?.type) || stat.isRemote) continue
    const kind = stat.kind || stat.mediaType
    if (!['audio', 'video'].includes(kind)) continue
    const direction = stat.type === 'inbound-rtp' ? 'inbound' : 'outbound'
    const target = sample[direction][kind]
    const previous = previousById.get(stat.id)
    target.bitrateKbps = rounded(bitrateKbps(stat, previous, direction === 'inbound' ? 'bytesReceived' : 'bytesSent'))
    target.packetLossPercent = direction === 'inbound' ? rounded(packetLossPercent(stat, previous), 1) : null
    target.jitterMs = direction === 'inbound' && number(stat.jitter) !== null ? rounded(stat.jitter * 1000) : null
    target.width = rounded(stat.frameWidth)
    target.height = rounded(stat.frameHeight)
    target.framesPerSecond = rounded(stat.framesPerSecond, 1)
    target.freezeCount = rounded(stat.freezeCount)
    target.totalFreezeDurationMs = number(stat.totalFreezesDuration) !== null
      ? rounded(stat.totalFreezesDuration * 1000)
      : null
    target.jitterBufferDelayMs = number(stat.jitterBufferDelay) !== null && number(stat.jitterBufferEmittedCount) > 0
      ? rounded((stat.jitterBufferDelay / stat.jitterBufferEmittedCount) * 1000)
      : null
    target.codec = codecName(stat, byId)
    target.qualityLimitationReason = typeof stat.qualityLimitationReason === 'string'
      ? stat.qualityLimitationReason
      : ''
  }

  if (selectedPair) {
    const local = byId.get(selectedPair.localCandidateId)
    const remote = byId.get(selectedPair.remoteCandidateId)
    sample.network.rttMs = number(selectedPair.currentRoundTripTime) !== null
      ? rounded(selectedPair.currentRoundTripTime * 1000)
      : null
    sample.network.availableOutgoingBitrateKbps = number(selectedPair.availableOutgoingBitrate) !== null
      ? rounded(selectedPair.availableOutgoingBitrate / 1000)
      : null
    sample.network.localCandidateType = String(local?.candidateType || '').slice(0, 16)
    sample.network.remoteCandidateType = String(remote?.candidateType || '').slice(0, 16)
    sample.network.protocol = String(local?.protocol || remote?.protocol || '').slice(0, 12)
    sample.network.relayProtocol = String(local?.relayProtocol || remote?.relayProtocol || '').slice(0, 12)
    sample.network.relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
  }

  sample.quality = classifyCallQuality(sample)
  return { sample, nextById }
}

export function nextAdaptiveProfile(currentProfile, quality, counters = {}) {
  const currentIndex = Math.max(0, PROFILE_ORDER.indexOf(currentProfile))
  let poorSamples = Math.max(0, Number(counters.poorSamples) || 0)
  let goodSamples = Math.max(0, Number(counters.goodSamples) || 0)

  if (quality === 'poor') {
    poorSamples += 1
    goodSamples = 0
  } else if (quality === 'good') {
    goodSamples += 1
    poorSamples = 0
  } else {
    poorSamples = 0
    goodSamples = 0
  }

  let nextIndex = currentIndex
  if (poorSamples >= 2 && currentIndex < PROFILE_ORDER.length - 1) {
    nextIndex += 1
    poorSamples = 0
  } else if (goodSamples >= 5 && currentIndex > 0) {
    nextIndex -= 1
    goodSamples = 0
  }
  return {
    profile: PROFILE_ORDER[nextIndex],
    poorSamples,
    goodSamples,
    changed: nextIndex !== currentIndex,
  }
}

export function qualityTelemetryPayload(sample, profile) {
  return {
    quality: String(sample?.quality || 'unknown').slice(0, 16),
    connection_state: String(sample?.connection?.state || '').slice(0, 20),
    profile: String(profile || '').slice(0, 12),
    rtt_ms: rounded(sample?.network?.rttMs),
    available_outgoing_kbps: rounded(sample?.network?.availableOutgoingBitrateKbps),
    inbound_audio_loss_pct: rounded(sample?.inbound?.audio?.packetLossPercent, 1),
    inbound_audio_jitter_ms: rounded(sample?.inbound?.audio?.jitterMs),
    inbound_video_loss_pct: rounded(sample?.inbound?.video?.packetLossPercent, 1),
    inbound_video_kbps: rounded(sample?.inbound?.video?.bitrateKbps),
    inbound_video_fps: rounded(sample?.inbound?.video?.framesPerSecond, 1),
    outbound_video_kbps: rounded(sample?.outbound?.video?.bitrateKbps),
    outbound_video_fps: rounded(sample?.outbound?.video?.framesPerSecond, 1),
    outbound_video_width: rounded(sample?.outbound?.video?.width),
    outbound_video_height: rounded(sample?.outbound?.video?.height),
    local_candidate_type: String(sample?.network?.localCandidateType || '').slice(0, 16),
    remote_candidate_type: String(sample?.network?.remoteCandidateType || '').slice(0, 16),
    transport_protocol: String(sample?.network?.protocol || '').slice(0, 12),
    relayed: !!sample?.network?.relayed,
    video_codec: String(sample?.outbound?.video?.codec || sample?.inbound?.video?.codec || '').slice(0, 40),
  }
}

function setTrackContentHints(stream) {
  for (const track of stream.getAudioTracks()) {
    try { track.contentHint = 'speech' } catch {}
  }
  for (const track of stream.getVideoTracks()) {
    try { track.contentHint = 'motion' } catch {}
  }
}

export function createVideoCallRuntime({
  Peer,
  iceConfigUrl = '',
  getAccessToken = () => '',
  fetchImpl = globalThis.fetch?.bind(globalThis),
  mediaDevices = globalThis.navigator?.mediaDevices,
  nativeAudio = null,
  isNativeIOS = () => false,
  now = () => Date.now(),
  logger = globalThis.console,
} = {}) {
  let iceCache = null
  let iceRequest = null
  let iceRetryAfter = 0

  async function fetchIceConfiguration() {
    const currentTime = now()
    if (iceCache && currentTime < iceCache.expiresAt - ICE_EXPIRY_SAFETY_MS) return iceCache
    if (!iceConfigUrl || !fetchImpl || currentTime < iceRetryAfter) return null
    if (iceRequest) return iceRequest

    iceRequest = (async () => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timeout = controller ? setTimeout(() => controller.abort(), ICE_FETCH_TIMEOUT_MS) : null
      try {
        const token = getAccessToken?.() || ''
        const response = await fetchImpl(iceConfigUrl, {
          method: 'GET',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'same-origin',
          signal: controller?.signal,
        })
        if (!response.ok) throw new Error(`ICE configuration returned HTTP ${response.status}`)
        const normalized = normalizeIceConfiguration(await response.json(), currentTime)
        if (!normalized?.hasTurn) throw new Error('ICE configuration did not include a credentialed TURN server')
        iceCache = normalized
        return iceCache
      } catch (error) {
        iceRetryAfter = currentTime + ICE_FAILURE_RETRY_MS
        logger?.warn?.('[video-call] managed TURN unavailable; using PeerJS fallback', error?.message || error)
        return null
      } finally {
        if (timeout) clearTimeout(timeout)
        iceRequest = null
      }
    })()
    return iceRequest
  }

  async function createPeer(id) {
    if (typeof Peer !== 'function') throw new Error('PeerJS is unavailable')
    const ice = await fetchIceConfiguration()
    const options = ice
      ? {
          config: {
            iceServers: ice.iceServers,
            iceCandidatePoolSize: 4,
            bundlePolicy: 'max-bundle',
          },
        }
      : undefined
    if (options) return new Peer(id || undefined, options)
    return id ? new Peer(id) : new Peer()
  }

  async function acquireMedia(preferences = {}) {
    if (!mediaDevices?.getUserMedia) throw new Error('Camera and microphone access is unavailable')
    const stream = await mediaDevices.getUserMedia(buildCallMediaConstraints(preferences))
    setTrackContentHints(stream)
    return stream
  }

  async function enumerateInputDevices() {
    if (!mediaDevices?.enumerateDevices) return { audioInputs: [], videoInputs: [] }
    const devices = await mediaDevices.enumerateDevices()
    return {
      audioInputs: devices.filter(device => device.kind === 'audioinput'),
      videoInputs: devices.filter(device => device.kind === 'videoinput'),
    }
  }

  async function applyVideoProfile(call, profileName) {
    const pc = call?.peerConnection
    const sender = pc?.getSenders?.().find(candidate => candidate.track?.kind === 'video')
    if (!sender?.setParameters) return false
    const profile = selectedProfile(profileName)
    try {
      const parameters = sender.getParameters?.() || {}
      if (!parameters.encodings?.length) parameters.encodings = [{}]
      parameters.encodings[0] = {
        ...parameters.encodings[0],
        active: true,
        maxBitrate: profile.maxBitrate,
        maxFramerate: profile.frameRate,
        scaleResolutionDownBy: profile.scaleResolutionDownBy,
      }
      parameters.degradationPreference = 'maintain-framerate'
      await sender.setParameters(parameters)
      return true
    } catch (error) {
      logger?.debug?.('[video-call] sender profile not supported', error?.message || error)
      return false
    }
  }

  function monitorCall(call, {
    intervalMs = 3_000,
    initialProfile = 'high',
    onSample = () => {},
    onProfileChange = () => {},
  } = {}) {
    let stopped = false
    let timer = null
    let running = false
    let previousById = new Map()
    let profile = selectedProfile(initialProfile).name
    let counters = { poorSamples: 0, goodSamples: 0 }

    const tick = async () => {
      if (stopped || running) return
      const pc = call?.peerConnection
      if (!pc?.getStats) return
      running = true
      try {
        const { sample, nextById } = summarizeRtcStats(await pc.getStats(), previousById)
        previousById = nextById
        sample.connection.state = pc.connectionState || pc.iceConnectionState || ''
        sample.quality = classifyCallQuality(sample)
        const adaptation = nextAdaptiveProfile(profile, sample.quality, counters)
        counters = { poorSamples: adaptation.poorSamples, goodSamples: adaptation.goodSamples }
        if (adaptation.changed) {
          profile = adaptation.profile
          await applyVideoProfile(call, profile)
          onProfileChange(profile)
        }
        sample.profile = profile
        onSample(sample)
      } catch (error) {
        logger?.debug?.('[video-call] stats sample failed', error?.message || error)
      } finally {
        running = false
      }
    }

    applyVideoProfile(call, profile).catch(() => {})
    timer = setInterval(tick, Math.max(1_000, intervalMs))
    setTimeout(tick, 500)
    return {
      stop() {
        stopped = true
        if (timer) clearInterval(timer)
      },
      sampleNow: tick,
      getProfile: () => profile,
    }
  }

  async function replaceInputTrack({ call, stream, kind, deviceId = '', facingMode = 'user' }) {
    if (!mediaDevices?.getUserMedia || !stream || !['audio', 'video'].includes(kind)) {
      throw new Error('Cannot switch this call device')
    }
    const preferences = kind === 'audio'
      ? { audioDeviceId: deviceId }
      : { videoDeviceId: deviceId, facingMode }
    const base = buildCallMediaConstraints(preferences)
    const constraints = kind === 'audio'
      ? { audio: base.audio, video: false }
      : { audio: false, video: base.video }
    const replacementStream = await mediaDevices.getUserMedia(constraints)
    setTrackContentHints(replacementStream)
    const replacement = kind === 'audio'
      ? replacementStream.getAudioTracks()[0]
      : replacementStream.getVideoTracks()[0]
    if (!replacement) throw new Error(`No ${kind} input was available`)

    const previous = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0]
    replacement.enabled = previous?.enabled ?? true
    const sender = call?.peerConnection?.getSenders?.().find(candidate => candidate.track?.kind === kind)
    try {
      if (sender?.replaceTrack) await sender.replaceTrack(replacement)
      if (previous) {
        stream.removeTrack(previous)
        previous.stop()
      }
      stream.addTrack(replacement)
      return { track: replacement, settings: replacement.getSettings?.() || {} }
    } catch (error) {
      replacement.stop()
      throw error
    }
  }

  async function startNativeAudio() {
    if (!isNativeIOS?.() || !nativeAudio?.start) return false
    try {
      await nativeAudio.start()
      return true
    } catch (error) {
      logger?.warn?.('[video-call] iOS call audio session could not start', error?.message || error)
      return false
    }
  }

  async function stopNativeAudio() {
    if (!isNativeIOS?.() || !nativeAudio?.stop) return false
    try {
      await nativeAudio.stop()
      return true
    } catch (error) {
      logger?.warn?.('[video-call] iOS call audio session could not stop', error?.message || error)
      return false
    }
  }

  async function addNativeAudioListener(listener) {
    if (!isNativeIOS?.() || !nativeAudio?.addListener) return null
    try {
      return await nativeAudio.addListener('stateChange', listener)
    } catch {
      return null
    }
  }

  return Object.freeze({
    createPeer,
    acquireMedia,
    enumerateInputDevices,
    applyVideoProfile,
    monitorCall,
    replaceInputTrack,
    startNativeAudio,
    stopNativeAudio,
    addNativeAudioListener,
    qualityTelemetryPayload,
    getInfrastructureStatus: () => ({
      managedTurnConfigured: !!iceConfigUrl,
      managedTurnLoaded: !!iceCache?.hasTurn,
    }),
  })
}

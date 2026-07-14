const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const modulePromise = import(pathToFileURL(path.resolve(__dirname, '../../src/video-call.mjs')).href)

test('builds speech-first media constraints with a 16:9 video profile', async () => {
  const { buildCallMediaConstraints } = await modulePromise
  const constraints = buildCallMediaConstraints({
    profile: 'medium',
    audioDeviceId: 'mic-2',
    videoDeviceId: 'cam-4',
  })

  assert.deepEqual(constraints.video.width, { ideal: 960 })
  assert.deepEqual(constraints.video.height, { ideal: 540 })
  assert.deepEqual(constraints.video.frameRate, { ideal: 24, max: 24 })
  assert.deepEqual(constraints.video.deviceId, { exact: 'cam-4' })
  assert.deepEqual(constraints.audio.deviceId, { exact: 'mic-2' })
  assert.deepEqual(constraints.audio.echoCancellation, { ideal: true })
  assert.deepEqual(constraints.audio.noiseSuppression, { ideal: true })
  assert.deepEqual(constraints.audio.autoGainControl, { ideal: true })
  assert.deepEqual(constraints.audio.channelCount, { ideal: 1 })
  assert.deepEqual(constraints.audio.sampleRate, { ideal: 48_000 })
})

test('normalizes only credentialed TURN configuration and computes expiry', async () => {
  const { normalizeIceConfiguration } = await modulePromise
  const now = 1_000_000
  const normalized = normalizeIceConfiguration({
    ice_servers: [
      { urls: 'stun:stun.example.com:3478' },
      {
        urls: [
          'turn:turn.example.com:3478?transport=udp',
          'turns:turn.example.com:5349',
          'https://not-an-ice-url.example.com',
        ],
        username: 'temporary-user',
        credential: 'temporary-password',
      },
    ],
    ttl: 600,
  }, now)

  assert.equal(normalized.hasTurn, true)
  assert.equal(normalized.expiresAt, now + 600_000)
  assert.deepEqual(normalized.iceServers[1].urls, [
    'turn:turn.example.com:3478?transport=udp',
    'turns:turn.example.com:5349',
  ])

  const missingCredential = normalizeIceConfiguration({
    iceServers: [{ urls: 'turn:turn.example.com:3478' }],
  }, now)
  assert.equal(missingCredential, null)
})

function baselineStats() {
  return [
    { id: 'codec-video', type: 'codec', mimeType: 'video/VP8' },
    { id: 'codec-audio', type: 'codec', mimeType: 'audio/opus' },
    {
      id: 'out-video', type: 'outbound-rtp', kind: 'video', timestamp: 1_000,
      bytesSent: 100_000, frameWidth: 1280, frameHeight: 720,
      framesPerSecond: 30, codecId: 'codec-video', qualityLimitationReason: 'none',
    },
    {
      id: 'in-video', type: 'inbound-rtp', kind: 'video', timestamp: 1_000,
      bytesReceived: 80_000, packetsReceived: 100, packetsLost: 0,
      frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, codecId: 'codec-video',
    },
    {
      id: 'in-audio', type: 'inbound-rtp', kind: 'audio', timestamp: 1_000,
      bytesReceived: 10_000, packetsReceived: 100, packetsLost: 0,
      jitter: 0.01, codecId: 'codec-audio',
    },
    {
      id: 'selected-pair', type: 'candidate-pair', state: 'succeeded', selected: true,
      localCandidateId: 'local-candidate', remoteCandidateId: 'remote-candidate',
      currentRoundTripTime: 0.15, availableOutgoingBitrate: 2_000_000,
    },
    {
      id: 'local-candidate', type: 'local-candidate', candidateType: 'relay',
      protocol: 'udp', relayProtocol: 'udp', address: '192.0.2.10', port: 49152,
    },
    {
      id: 'remote-candidate', type: 'remote-candidate', candidateType: 'srflx',
      protocol: 'udp', address: '198.51.100.20', port: 3478,
    },
  ]
}

test('summarizes WebRTC quality without exposing candidate addresses', async () => {
  const { summarizeRtcStats } = await modulePromise
  const first = summarizeRtcStats(baselineStats())
  const secondStats = baselineStats().map(stat => ({ ...stat, timestamp: stat.timestamp ? 2_000 : stat.timestamp }))
  Object.assign(secondStats.find(stat => stat.id === 'out-video'), { bytesSent: 200_000 })
  Object.assign(secondStats.find(stat => stat.id === 'in-video'), {
    bytesReceived: 155_000,
    packetsReceived: 190,
    packetsLost: 10,
  })
  Object.assign(secondStats.find(stat => stat.id === 'in-audio'), {
    bytesReceived: 18_000,
    packetsReceived: 195,
    packetsLost: 5,
    jitter: 0.035,
  })

  const { sample } = summarizeRtcStats(secondStats, first.nextById)
  assert.equal(sample.outbound.video.bitrateKbps, 800)
  assert.equal(sample.inbound.video.packetLossPercent, 10)
  assert.equal(sample.inbound.audio.packetLossPercent, 5)
  assert.equal(sample.inbound.audio.jitterMs, 35)
  assert.equal(sample.network.rttMs, 150)
  assert.equal(sample.network.relayed, true)
  assert.equal(sample.network.localCandidateType, 'relay')
  assert.equal(sample.quality, 'poor')
  assert.doesNotMatch(JSON.stringify(sample), /192\.0\.2\.10|198\.51\.100\.20|49152/)
})

test('uses hysteresis when adapting video quality', async () => {
  const { nextAdaptiveProfile } = await modulePromise
  let state = { profile: 'high', poorSamples: 0, goodSamples: 0 }
  state = nextAdaptiveProfile(state.profile, 'poor', state)
  assert.equal(state.profile, 'high')
  state = nextAdaptiveProfile(state.profile, 'poor', state)
  assert.equal(state.profile, 'medium')
  assert.equal(state.changed, true)

  for (let count = 0; count < 4; count += 1) {
    state = nextAdaptiveProfile(state.profile, 'good', state)
    assert.equal(state.profile, 'medium')
  }
  state = nextAdaptiveProfile(state.profile, 'good', state)
  assert.equal(state.profile, 'high')
})

test('does not claim good quality before WebRTC has measurable signals', async () => {
  const { classifyCallQuality } = await modulePromise
  assert.equal(classifyCallQuality({
    connection: { state: 'connected' },
    network: { rttMs: null },
    inbound: {
      audio: { packetLossPercent: null, jitterMs: null },
      video: { packetLossPercent: null, framesPerSecond: null },
    },
    outbound: { video: { bitrateKbps: null, qualityLimitationReason: '' } },
  }), 'connecting')
})

test('quality telemetry contains aggregate transport data but no raw network identity', async () => {
  const { qualityTelemetryPayload } = await modulePromise
  const payload = qualityTelemetryPayload({
    quality: 'fair',
    connection: { state: 'connected' },
    network: {
      rttMs: 280,
      localCandidateType: 'relay',
      remoteCandidateType: 'srflx',
      protocol: 'udp',
      relayed: true,
      address: '203.0.113.5',
    },
    inbound: {
      audio: { packetLossPercent: 3.2, jitterMs: 32 },
      video: { packetLossPercent: 4.1, bitrateKbps: 620, framesPerSecond: 22 },
    },
    outbound: {
      video: { bitrateKbps: 700, framesPerSecond: 24, width: 960, height: 540, codec: 'video/H264' },
    },
  }, 'medium')

  assert.equal(payload.relayed, true)
  assert.equal(payload.rtt_ms, 280)
  assert.equal(payload.profile, 'medium')
  assert.doesNotMatch(JSON.stringify(payload), /203\.0\.113\.5/)
})

test('central peer factory authenticates and applies managed TURN configuration', async () => {
  const { createVideoCallRuntime } = await modulePromise
  const constructed = []
  class FakePeer {
    constructor(id, options) {
      constructed.push({ id, options })
    }
  }
  const fetchCalls = []
  const runtime = createVideoCallRuntime({
    Peer: FakePeer,
    iceConfigUrl: 'https://service.example.com/v1/rtc/ice-servers',
    getAccessToken: () => 'access-token',
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options })
      return {
        ok: true,
        json: async () => ({
          iceServers: [{
            urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'],
            username: 'temporary-user',
            credential: 'temporary-password',
          }],
          ttl: 600,
        }),
      }
    },
    now: () => 1_000_000,
  })

  await runtime.createPeer('player-peer')
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer access-token')
  assert.equal(constructed[0].id, 'player-peer')
  assert.equal(constructed[0].options.config.iceCandidatePoolSize, 4)
  assert.equal(constructed[0].options.config.iceServers[0].username, 'temporary-user')
  assert.equal(runtime.getInfrastructureStatus().managedTurnLoaded, true)
})

test('acquired tracks receive speech and motion content hints', async () => {
  const { createVideoCallRuntime } = await modulePromise
  const audioTrack = { contentHint: '' }
  const videoTrack = { contentHint: '' }
  const stream = {
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [videoTrack],
  }
  let requestedConstraints = null
  const runtime = createVideoCallRuntime({
    Peer: class {},
    mediaDevices: {
      getUserMedia: async constraints => {
        requestedConstraints = constraints
        return stream
      },
    },
  })

  assert.equal(await runtime.acquireMedia({ profile: 'low' }), stream)
  assert.equal(requestedConstraints.video.width.ideal, 640)
  assert.equal(audioTrack.contentHint, 'speech')
  assert.equal(videoTrack.contentHint, 'motion')
})

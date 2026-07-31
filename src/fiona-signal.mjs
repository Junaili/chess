// Session-scoped WebRTC signaling for Fortress Fiona.  The caller supplies
// AGS session-storage read/write functions so this module stays independent of
// the generated browser SDK and is easy to exercise in isolation.

const SIGNAL_KEY = 'fionaSignal'
const ANSWER_WAIT_MS = 45_000
const POLL_MS = 750

const randomNonce = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`

export function makeOfferEnvelope(sessionId, nonce, offer) {
  return { sessionId, nonce, offer: { type: offer.type, sdp: offer.sdp } }
}

export function readMatchingAnswer(storage, sessionId, nonce) {
  const signal = storage?.[SIGNAL_KEY]
  if (!signal || signal.sessionId !== sessionId || signal.nonce !== nonce) return null
  const answer = signal.answer
  return answer?.type === 'answer' && typeof answer.sdp === 'string' ? answer : null
}

async function waitForIceComplete(peer, timeoutMs = 10_000) {
  if (peer.iceGatheringState === 'complete') return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out gathering connection details.')) }, timeoutMs)
    const onState = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve() } }
    const cleanup = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', onState) }
    peer.addEventListener('icegatheringstatechange', onState)
  })
}

// connectToFiona creates an offer, stores it under fionaSignal, waits for the
// bot to replace it with an answer, and returns the connected data channel.
export async function connectToFiona({ sessionId, writeStorage, readStorage, rtcConfig, timeoutMs = ANSWER_WAIT_MS }) {
  if (!sessionId) throw new Error('A matched game session is required.')
  const peer = new RTCPeerConnection(rtcConfig)
  const channel = peer.createDataChannel('chess')
  const nonce = randomNonce()
  const offer = await peer.createOffer()
  await peer.setLocalDescription(offer)
  await waitForIceComplete(peer)
  await writeStorage({ [SIGNAL_KEY]: makeOfferEnvelope(sessionId, nonce, peer.localDescription) })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const answer = readMatchingAnswer(await readStorage(), sessionId, nonce)
    if (answer) {
      await peer.setRemoteDescription(answer)
      return { peer, channel, nonce }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  peer.close()
  throw new Error('Fiona did not answer in time. Please try again.')
}

export { SIGNAL_KEY }

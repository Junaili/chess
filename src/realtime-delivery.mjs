export const INVITE_RETRY_DELAYS_MS = Object.freeze([0, 400, 1_200])
// AGS Lobby rejects oversized personal-chat payloads with errorNotif/413.
// Keep application envelopes below the service's 256-byte boundary so UTF-8
// display names and small protocol additions cannot turn an invite into a
// silent timeout. The outer Lobby message already carries from/to/id, so those
// fields must not be duplicated inside the JSON payload.
export const PERSONAL_CHAT_PAYLOAD_MAX_BYTES = 240

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const utf8 = new TextEncoder()

function utf8Length(value) {
  return utf8.encode(String(value || '')).byteLength
}

function truncateUtf8(value, maxBytes) {
  let result = ''
  for (const character of String(value || '').replace(/[\u0000-\u001f\u007f]/g, '')) {
    if (utf8Length(result + character) > maxBytes) break
    result += character
  }
  return result
}

// Preserve the legacy field names so an invite sent immediately after a web
// deploy can still be understood by a recipient with an older tab open.
export function serializePersonalChatPayload(payload, maxBytes = PERSONAL_CHAT_PAYLOAD_MAX_BYTES) {
  const type = String(payload?.type || '')
  const sentAt = payload?.sentAt || new Date().toISOString()
  let wirePayload

  if (type === 'chess-match-invite') {
    wirePayload = {
      type,
      inviteId: String(payload?.inviteId || payload?.deliveryId || ''),
      peerId: String(payload?.peerId || ''),
      sentAt,
    }
  } else if (type === 'chess-match-declined') {
    wirePayload = {
      type,
      inviteId: String(payload?.inviteId || payload?.deliveryId || ''),
      sentAt,
    }
  } else if (type === 'chess-invite-clicked') {
    wirePayload = {
      type,
      deliveryId: String(payload?.deliveryId || payload?.inviteId || ''),
      sentAt,
    }
  } else {
    return { ok: false, error: 'Unsupported real-time invite type.' }
  }

  const fromName = truncateUtf8(payload?.fromName, 32)
  if (fromName) wirePayload.fromName = fromName

  let value = JSON.stringify(wirePayload)
  if (utf8Length(value) > maxBytes && wirePayload.fromName) {
    delete wirePayload.fromName
    value = JSON.stringify(wirePayload)
  }
  if (utf8Length(value) > maxBytes) {
    return { ok: false, error: 'Invite data is too large to send.' }
  }
  return { ok: true, value, bytes: utf8Length(value) }
}

export function classifyPersonalChatResponse(response) {
  if (response?.type === 'personalChatResponse' && Number(response.code) === 0) {
    return { ok: true, retryable: false }
  }
  if (!response) {
    return { ok: false, retryable: true, error: 'Connection lost while sending the invite.' }
  }

  const code = Number(response.code)
  if (code === 413) {
    return { ok: false, retryable: false, error: 'Invite data is too large to send.' }
  }
  if (code === 408 || code === 429 || (code >= 500 && code < 600)) {
    return { ok: false, retryable: true, error: 'AGS Lobby temporarily rejected the invite.' }
  }
  return { ok: false, retryable: false, error: 'AGS Lobby rejected the invite.' }
}

// Retry only failures explicitly marked retryable by the transport. This keeps
// permission/block errors single-shot while recovering from reconnect gaps and
// lost acknowledgements. The caller reuses the same application delivery ID so
// the receiver can safely collapse an accepted-first-attempt + retried-send.
export async function deliverWithRetry(
  sendAttempt,
  { delaysMs = INVITE_RETRY_DELAYS_MS, sleep = wait } = {},
) {
  let last = { ok: false, retryable: false, error: 'Delivery failed.' }
  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    const delay = Number(delaysMs[attempt]) || 0
    if (delay > 0) await sleep(delay)
    try {
      last = await sendAttempt(attempt)
    } catch (cause) {
      last = {
        ok: false,
        retryable: true,
        error: cause?.message || 'Delivery failed.',
        cause,
      }
    }
    if (last?.ok || !last?.retryable) return { ...last, attempts: attempt + 1 }
  }
  return { ...last, attempts: delaysMs.length }
}

export function createDeliveryDeduper({ ttlMs = 10 * 60_000, maxEntries = 200, now = () => Date.now() } = {}) {
  const seen = new Map()

  function prune(at) {
    for (const [key, timestamp] of seen) {
      if (at - timestamp > ttlMs) seen.delete(key)
    }
    while (seen.size > maxEntries) seen.delete(seen.keys().next().value)
  }

  return {
    isDuplicate(key) {
      const normalized = String(key || '')
      if (!normalized) return false
      const at = now()
      prune(at)
      if (seen.has(normalized)) return true
      seen.set(normalized, at)
      prune(at)
      return false
    },
    clear() {
      seen.clear()
    },
  }
}

export function isStaleDelivery(sentAt, maxAgeMs = 10 * 60_000, now = Date.now()) {
  if (!sentAt) return false
  const timestamp = Date.parse(sentAt)
  return Number.isFinite(timestamp) && now - timestamp > maxAgeMs
}

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000

export class NetworkTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`The network request timed out after ${timeoutMs}ms.`)
    this.name = 'NetworkTimeoutError'
    this.code = 'ETIMEDOUT'
    this.timeoutMs = timeoutMs
  }
}

// fetch() has no timeout of its own. A stalled mobile connection could
// otherwise leave sign-in, legal, family, or Extend UI permanently busy.
// Preserve a caller-provided AbortSignal while adding a bounded deadline.
export async function fetchWithTimeout(
  input,
  init = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  fetchImpl = globalThis.fetch?.bind(globalThis),
) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortController !== 'function') {
    return fetchImpl(input, init)
  }

  const controller = new AbortController()
  const upstreamSignal = init.signal
  let timedOut = false
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)

  if (upstreamSignal?.aborted) {
    abortFromUpstream()
  } else {
    upstreamSignal?.addEventListener?.('abort', abortFromUpstream, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new NetworkTimeoutError(timeoutMs)
    throw error
  } finally {
    clearTimeout(timer)
    upstreamSignal?.removeEventListener?.('abort', abortFromUpstream)
  }
}

export function friendlyNetworkError(error, fallback = 'The service is unavailable. Please try again.') {
  if (error?.code === 'ETIMEDOUT' || error?.name === 'NetworkTimeoutError') {
    return 'The request took too long. Check your connection and try again.'
  }
  if (error?.name === 'AbortError') return fallback
  if (/^(failed to fetch|load failed|network error)$/i.test(String(error?.message || '').trim())) {
    return 'Could not reach the service. Check your connection and try again.'
  }
  return error?.message || fallback
}

// Can a frame actually be sent on this socket right now?
//
// Browsers do NOT throw when send() is called on a CLOSING or CLOSED socket.
// They log "WebSocket is already in CLOSING or CLOSED state" and silently drop
// the frame, so a try/catch around the send cannot protect anything — the
// request just hangs until its own timeout while the console fills with errors.
// The AGS SDK's send only checks that its socket object exists, never its
// readyState, so the check has to happen on our side.
//
// Kept pure and free of SDK imports so it can be tested directly.

export const WS_CONNECTING = 0
export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

// native: the real WebSocket, or null/undefined when it could not be captured.
// connectedFallback: our own connection flag, used only when the native socket
// is unavailable — a future SDK change should degrade to the previous
// behaviour rather than block every send.
export function canSendOnSocket(native, connectedFallback = false) {
  if (!native || typeof native.readyState !== 'number') return !!connectedFallback
  return native.readyState === WS_OPEN
}

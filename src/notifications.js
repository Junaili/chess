// Browser notifications for game invites and friend requests.
//
// This is a static site with no push backend, so we use the Notification API
// directly, driven by the live AGS Lobby websocket events that already power
// game invites and friend requests. Notifications only fire when the tab is
// not focused, so an in-app user never gets a redundant OS popup.

const ICON = (import.meta.env.BASE_URL || '/') + 'icon-192.png'

let permissionAsked = false

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'denied'
}

// Must be triggered from a user gesture — Safari rejects permission requests
// made outside of one. Safe to call repeatedly; only the first prompt shows.
export async function ensureNotificationPermission() {
  if (!notificationsSupported()) return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  if (permissionAsked) return Notification.permission
  permissionAsked = true
  try {
    const result = await Notification.requestPermission()
    return result
  } catch {
    // Older Safari only supports the callback form
    return new Promise(resolve => {
      try { Notification.requestPermission(resolve) } catch { resolve('denied') }
    })
  }
}

// Show a notification, but only when the user isn't already looking at the tab.
export function notify(title, { body = '', tag = '', onClick = null } = {}) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
  try {
    const n = new Notification(title, { body, tag, icon: ICON, badge: ICON, renotify: !!tag })
    if (onClick) {
      n.onclick = () => {
        try { window.focus() } catch {}
        n.close()
        try { onClick() } catch {}
      }
    }
  } catch {}
}

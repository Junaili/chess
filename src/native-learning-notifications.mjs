// Dynamic Capacitor local-notification adapter for the chess-improvement
// notification system (notification dev-plan §13.9, N3). Dynamically
// imports @capacitor/local-notifications only when actually called — a
// player on web or with VITE_LEARNING_NATIVE_REMINDERS_V1 off never loads
// this dependency at all, since the orchestrator only reaches this module
// behind that same lazy chunk.
//
// Every exported function takes an optional `plugin` override as its last
// argument — the same injectable-dependency pattern as
// src/privacy-preferences.mjs's `storage` parameter — so unit tests can pass
// a fake plugin object instead of exercising the real native bridge
// (dev-plan §16.3: "adapter unit tests with a fake plugin").

let cachedPlugin = null

async function resolvePlugin(pluginOverride) {
  if (pluginOverride) return pluginOverride
  if (!cachedPlugin) {
    const module = await import('@capacitor/local-notifications')
    cachedPlugin = module.LocalNotifications
  }
  return cachedPlugin
}

// Fixed IDs by category, reserved 41000–41099 (dev-plan §13.9) — rescheduling
// the same kind always replaces or cancels the same ID, so at most one
// pending learning reminder can ever exist per kind, and the orchestrator's
// "only one pending overall" rule (dev-plan §10.3) layers on top of this.
export const NATIVE_ID_FOR_KIND = {
  practice_due: 41001,
  review_unfinished: 41002,
}

export function isNativePlatformAvailable() {
  return !!globalThis.window?.Capacitor?.isNativePlatform?.()
}

export async function checkLearningReminderPermission(plugin) {
  try {
    const p = await resolvePlugin(plugin)
    const { display } = await p.checkPermissions()
    return display // 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
  } catch (error) {
    console.warn('[native-learning-notifications] permission check failed:', error?.message || error)
    return 'denied'
  }
}

export async function requestLearningReminderPermission(plugin) {
  try {
    const p = await resolvePlugin(plugin)
    const { display } = await p.requestPermissions()
    return display
  } catch (error) {
    console.warn('[native-learning-notifications] permission request failed:', error?.message || error)
    return 'denied'
  }
}

// scheduleLearningReminder: one non-repeating notification (dev-plan §13.9).
// `extra` carries only the generic `intent` string ('practice' | 'review')
// — never an account ID, match ID, opponent name, or any private chess
// content, matching the lock-screen-safe copy already enforced upstream by
// formatLearningCopy(candidate, 'external' | 'external_child').
export async function scheduleLearningReminder({ kind, title, body, at, intent } = {}, plugin) {
  const id = NATIVE_ID_FOR_KIND[kind]
  if (!id) return false
  try {
    const p = await resolvePlugin(plugin)
    await p.cancel({ notifications: [{ id }] }).catch(() => {})
    await p.schedule({
      notifications: [{
        id,
        title,
        body,
        schedule: { at: new Date(at), allowWhileIdle: true },
        extra: { intent },
      }],
    })
    return true
  } catch (error) {
    console.warn('[native-learning-notifications] schedule failed:', error?.message || error)
    return false
  }
}

export async function cancelLearningReminder(kind, plugin) {
  const id = NATIVE_ID_FOR_KIND[kind]
  if (!id) return
  try {
    const p = await resolvePlugin(plugin)
    await p.cancel({ notifications: [{ id }] })
  } catch (error) {
    console.warn('[native-learning-notifications] cancel failed:', error?.message || error)
  }
}

export async function cancelAllLearningReminders(plugin) {
  try {
    const p = await resolvePlugin(plugin)
    await p.cancel({ notifications: Object.values(NATIVE_ID_FOR_KIND).map(id => ({ id })) })
  } catch (error) {
    console.warn('[native-learning-notifications] cancel-all failed:', error?.message || error)
  }
}

// getPendingLearningReminders: filtered to OUR reserved IDs only — other
// features may schedule their own native local notifications in the same
// app, and this must never touch or report on those.
export async function getPendingLearningReminders(plugin) {
  try {
    const p = await resolvePlugin(plugin)
    const { notifications } = await p.getPending()
    const reserved = new Set(Object.values(NATIVE_ID_FOR_KIND))
    return (notifications || []).filter(n => reserved.has(n.id))
  } catch (error) {
    console.warn('[native-learning-notifications] getPending failed:', error?.message || error)
    return []
  }
}

let actionListenerHandle = null

// subscribeLearningReminderAction: fires `handler({ kind, intent })` when the
// player taps one of OUR reminders (cold start or foreground). Only one
// listener is kept at a time — resubscribing replaces the previous handle
// rather than stacking listeners.
export async function subscribeLearningReminderAction(handler, plugin) {
  try {
    const p = await resolvePlugin(plugin)
    await actionListenerHandle?.remove?.()
    actionListenerHandle = await p.addListener('localNotificationActionPerformed', event => {
      const id = event?.notification?.id
      const kind = Object.keys(NATIVE_ID_FOR_KIND).find(k => NATIVE_ID_FOR_KIND[k] === id)
      if (!kind) return
      handler({ kind, intent: event?.notification?.extra?.intent || '' })
    })
  } catch (error) {
    console.warn('[native-learning-notifications] action subscription failed:', error?.message || error)
  }
}

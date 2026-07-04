export const PRIVACY_PREFERENCES_KEY = 'chess_privacy_preferences_v1'

const DEFAULT_PREFERENCES = Object.freeze({
  analytics: false,
  decided: false,
  updatedAt: '',
})

function storageOrNull(storage) {
  if (storage) return storage
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

export function readPrivacyPreferences(storage) {
  const target = storageOrNull(storage)
  if (!target) return { ...DEFAULT_PREFERENCES }

  try {
    const saved = JSON.parse(target.getItem(PRIVACY_PREFERENCES_KEY) || 'null')
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_PREFERENCES }
    return {
      analytics: saved.analytics === true,
      decided: saved.decided === true,
      updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : '',
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function writePrivacyPreferences({ analytics }, storage) {
  const preferences = {
    analytics: analytics === true,
    decided: true,
    updatedAt: new Date().toISOString(),
  }
  const target = storageOrNull(storage)
  if (target) {
    try {
      target.setItem(PRIVACY_PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      // Privacy choices still apply for this session when storage is unavailable.
    }
  }
  return preferences
}

export function hasAnalyticsConsent(storage) {
  const preferences = readPrivacyPreferences(storage)
  return preferences.decided && preferences.analytics
}

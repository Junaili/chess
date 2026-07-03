import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity'

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
})

export const HIDDEN_CHAT_MESSAGE = 'Message hidden by profanity filter.'

export function containsProfanity(value) {
  const text = String(value || '').normalize('NFKC').trim()
  if (!text) return false
  if (matcher.hasMatch(text)) return true

  // Catch simple separator-based evasions such as "f.u.c.k" without removing
  // spaces from ordinary sentences and creating broad false positives.
  const hasSeparatedLetters = /(?:[\p{L}\p{N}][\s._*/\\-]+){2,}[\p{L}\p{N}]/u.test(text)
  if (!hasSeparatedLetters) return false
  return matcher.hasMatch(text.replace(/[\s._*/\\-]+/gu, ''))
}

export function validateDisplayNameLocally(value) {
  const displayName = String(value || '').normalize('NFKC').trim()
  if (!displayName) {
    return { ok: false, error: 'Enter a display name.' }
  }
  if (containsProfanity(displayName)) {
    return { ok: false, error: 'Choose a display name without inappropriate language.' }
  }
  return { ok: true, value: displayName }
}

export function moderateIncomingDisplayName(value, fallback = 'Opponent') {
  const displayName = String(value || '').normalize('NFKC').trim()
  return displayName && !containsProfanity(displayName) ? displayName : fallback
}

export function moderateOutgoingChat(value) {
  const text = String(value || '').normalize('NFKC').trim()
  if (!text) return { ok: false, error: '' }
  if (containsProfanity(text)) {
    return { ok: false, error: 'Message not sent. Please remove inappropriate language.' }
  }
  return { ok: true, value: text }
}

export function moderateIncomingChat(value) {
  const text = String(value || '').normalize('NFKC').trim()
  if (!text) return ''
  return containsProfanity(text) ? HIDDEN_CHAT_MESSAGE : text
}

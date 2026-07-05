export function buildUsername(displayName, emailAddress, randomBytes = null) {
  const source = (displayName || String(emailAddress || '').split('@')[0] || 'player').toLowerCase()
  let base = source.replace(/[^a-z0-9]+/g, '')
  if (!base) base = 'player'
  if (!/^[a-z]/.test(base)) base = `player${base}`

  const bytes = randomBytes || crypto.getRandomValues(new Uint8Array(4))
  const suffix = Array.from(bytes, byte => byte.toString(36).padStart(2, '0')).join('').slice(0, 6)
  return `${base.slice(0, 26)}${suffix}`.slice(0, 32)
}

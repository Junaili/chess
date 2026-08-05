// Is this opponent one of our bots?
//
// Used to suppress the things that only make sense between two humans: friend
// requests, High Fives, and friend-list entries. Every personality signs in as
// its OWN AGS account, so a single hardcoded id can't answer this — the roster
// is published by the profile/roster fetch and read from here.
//
// Both id and display name are checked: a peer-to-peer game reveals the name
// over the data channel before any AGS id is known, and legacy match history
// stores the bot's slug ("gambit-gus") rather than its account id.

const norm = value => String(value ?? '').trim().toLowerCase()

// setBotIdentities publishes the roster for every consumer. Shape:
// [{ id, userId, name }]. Called once the bot profiles load.
export function setBotIdentities(bots) {
  const identities = (Array.isArray(bots) ? bots : [])
    .map(bot => ({
      id: norm(bot?.id),
      userId: norm(bot?.userId),
      name: norm(bot?.name),
    }))
    .filter(bot => bot.id || bot.userId || bot.name)
  window.agsBotIdentities = identities

  // The default bot's globals stay published for one release: older cached
  // bundles and any unlisted reader still expect them.
  const gus = identities.find(bot => bot.id === 'gambit-gus')
  window.agsGambitGusUserId = gus?.userId || ''
  window.agsGambitGusName = bots?.find(bot => norm(bot?.id) === 'gambit-gus')?.name || 'Gambit Gus'
}

export function clearBotIdentities() {
  window.agsBotIdentities = []
  window.agsGambitGusUserId = ''
  window.agsGambitGusName = 'Gambit Gus'
}

export function isBotIdentity(userId, displayName = '') {
  const id = norm(userId)
  const name = norm(displayName)
  const roster = Array.isArray(window.agsBotIdentities) ? window.agsBotIdentities : []

  // Fall back to the default bot when the roster hasn't loaded yet, so a bot
  // opponent is never mistaken for a human just because a fetch was slow.
  if (!roster.length) {
    const knownUserId = norm(window.agsGambitGusUserId)
    const knownName = norm(window.agsGambitGusName) || 'gambit gus'
    return id === 'gambit-gus' || (!!knownUserId && id === knownUserId) || name === knownName
  }

  return roster.some(bot =>
    (bot.id && id === bot.id)
    || (bot.userId && id === bot.userId)
    || (bot.name && name === bot.name))
}

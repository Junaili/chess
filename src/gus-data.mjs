// Pure view-model helpers for the "Play with Gus" feature: shaping the Extend
// /bot/profile response for display. No DOM, no network — unit-tested by
// tests/unit/gus-data.test.cjs, consumed by src/gus.js.

// normalizeGusProfile fills safe defaults so the renderer never branches on
// missing fields (a brand-new bot has no games, brain, or journal yet).
export function normalizeGusProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const bot = p.bot && typeof p.bot === 'object' ? p.bot : {}
  return {
    bot: {
      id: bot.id || 'gambit-gus',
      userId: bot.userId || '',
      name: bot.name || 'Gambit Gus',
      tagline: bot.tagline || '',
      personality: bot.personality || '',
      style: bot.style && typeof bot.style === 'object' ? bot.style : null,
    },
    playable: !!p.playable,
    stats: p.stats && typeof p.stats === 'object' ? p.stats : { games: 0, wins: 0, losses: 0, draws: 0, winRate: 0, streakCount: 0, gamesLast7Days: 0, avgDurationMs: 0 },
    recentMatches: Array.isArray(p.recentMatches) ? p.recentMatches : [],
    brain: p.brain && typeof p.brain === 'object' ? p.brain : null,
    aboutYou: p.aboutYou && typeof p.aboutYou === 'object' ? p.aboutYou : null,
    journal: Array.isArray(p.journal) ? p.journal : [],
    training: p.training && typeof p.training === 'object' ? p.training : { running: false, lastRun: {}, cadence: 'daily' },
  }
}

export function formatGusRecord(stats) {
  if (!stats || !stats.games) return 'No completed games yet'
  return `${stats.wins}W · ${stats.losses}L · ${stats.draws}D`
}

export function formatWinRate(stats) {
  if (!stats || !stats.games) return '—'
  return `${Math.round((stats.winRate || 0) * 100)}%`
}

export function streakLabel(stats) {
  if (!stats || !stats.streakCount) return ''
  const n = stats.streakCount
  if (stats.streakType === 'win') return n === 1 ? 'Won his last game' : `On a ${n}-game win streak`
  if (stats.streakType === 'loss') return n === 1 ? 'Lost his last game' : `Dropped his last ${n} games`
  if (stats.streakType === 'draw') return n === 1 ? 'Drew his last game' : `${n} draws in a row`
  return ''
}

// The trainer calibrates difficulty toward a ~50% win rate, one step per day.
export function difficultyLabel(difficulty) {
  switch (difficulty) {
    case 'easy': return 'Taking it easy'
    case 'medium': return 'Club player'
    case 'hard': return 'Playing sharp'
    default: return 'Still calibrating'
  }
}

export function thinkTimeLabel(brain) {
  const mean = brain?.thinkMsMean
  if (!mean) return ''
  return `Thinks about ${(mean / 1000).toFixed(1)}s per move`
}

// trainingStatusLine turns the trainer status into one human sentence.
export function trainingStatusLine(training, brain) {
  if (training?.running) return 'Training right now — new lessons landing shortly.'
  const last = training?.lastRun || {}
  const when = brain?.lastTrained ? formatDay(brain.lastTrained) : null
  if (last.result === 'trained') {
    const games = last.gamesLearned ?? last.newGames
    const suffix = games ? ` — studied ${games} ${games === 1 ? 'game' : 'games'}` : ''
    return `Last trained ${when || 'recently'}${suffix}.`
  }
  if (last.result === 'no_new_games') {
    return `Checked for new games ${formatDay(last.finishedAt) || 'recently'} — nothing new to study yet.`
  }
  if (last.error) return 'Last training run hit a snag — Gus will try again on his next cycle.'
  if (when) return `Last trained ${when}.`
  return 'Gus has not had his first training session yet. He trains once a day on his own games.'
}

// formatDay renders an ISO date(-time) as a friendly day ("today", "yesterday",
// or "Jul 3"). Returns '' for unparseable input.
export function formatDay(iso, now = new Date()) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const startOf = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function aboutYouSummary(aboutYou) {
  if (!aboutYou || !aboutYou.gamesVsYou) return ''
  const { gamesVsYou, yourWins, yourLosses, yourDraws } = aboutYou
  const games = `${gamesVsYou} ${gamesVsYou === 1 ? 'game' : 'games'}`
  return `You've played Gus ${games}: ${yourWins || 0} wins, ${yourLosses || 0} losses, ${yourDraws || 0} draws.`
}

// openingRecord renders "W-D-L" for an opening row.
export function openingRecord(opening) {
  return `${opening.wins || 0}-${opening.draws || 0}-${opening.losses || 0}`
}

// parseJournalText breaks a trainer journal note (light markdown: "## date"
// heading, "> quote" reflection, "- item" lists, plain lines) into typed blocks
// the renderer can style. The heading is dropped — the entry date is shown
// separately — and the per-game id lines under "Games:" are folded into a count.
export function parseJournalText(text) {
  const blocks = []
  let inGames = false
  let gameCount = 0
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('##')) continue
    if (/^games:$/i.test(line)) { inGames = true; continue }
    if (line.startsWith('- ')) {
      if (inGames) { gameCount++; continue }
      blocks.push({ type: 'item', text: line.slice(2).trim() })
      continue
    }
    inGames = false
    if (line.startsWith('>')) {
      blocks.push({ type: 'quote', text: line.replace(/^>\s*/, '') })
      continue
    }
    if (/^new lessons:$/i.test(line)) {
      blocks.push({ type: 'label', text: 'New lessons' })
      continue
    }
    blocks.push({ type: 'text', text: line })
  }
  if (gameCount > 0) {
    blocks.push({ type: 'text', text: `Reviewed ${gameCount} ${gameCount === 1 ? 'game' : 'games'} move by move.` })
  }
  return blocks
}

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const gusPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'gus-data.mjs')
))

test('normalizeGusProfile fills safe defaults for a brand-new bot', async () => {
  const { normalizeGusProfile } = await gusPromise
  const p = normalizeGusProfile({})
  assert.equal(p.bot.name, 'Gambit Gus')
  assert.equal(p.playable, false)
  assert.deepEqual(p.recentMatches, [])
  assert.deepEqual(p.journal, [])
  assert.equal(p.brain, null)
  assert.equal(p.aboutYou, null)
  assert.equal(p.stats.games, 0)
})

test('normalizeGusProfile passes through server fields', async () => {
  const { normalizeGusProfile } = await gusPromise
  const p = normalizeGusProfile({
    bot: { id: 'gambit-gus', name: 'Gambit Gus', tagline: 'T', userId: 'u-bot' },
    playable: true,
    stats: { games: 3, wins: 2, losses: 1, draws: 0, winRate: 2 / 3 },
    journal: [{ date: '2026-07-07', text: 'hello' }],
  })
  assert.equal(p.playable, true)
  assert.equal(p.bot.userId, 'u-bot')
  assert.equal(p.stats.wins, 2)
  assert.equal(p.journal.length, 1)
})

test('formatGusRecord and formatWinRate', async () => {
  const { formatGusRecord, formatWinRate } = await gusPromise
  assert.equal(formatGusRecord({ games: 6, wins: 3, losses: 2, draws: 1 }), '3W · 2L · 1D')
  assert.equal(formatGusRecord({ games: 0 }), 'No completed games yet')
  assert.equal(formatWinRate({ games: 6, winRate: 0.5 }), '50%')
  assert.equal(formatWinRate({ games: 0 }), '—')
})

test('streakLabel covers win/loss/draw and empty', async () => {
  const { streakLabel } = await gusPromise
  assert.equal(streakLabel({ streakType: 'win', streakCount: 3 }), 'On a 3-game win streak')
  assert.equal(streakLabel({ streakType: 'win', streakCount: 1 }), 'Won his last game')
  assert.equal(streakLabel({ streakType: 'loss', streakCount: 2 }), 'Dropped his last 2 games')
  assert.equal(streakLabel({ streakType: 'draw', streakCount: 1 }), 'Drew his last game')
  assert.equal(streakLabel({ streakCount: 0 }), '')
})

test('difficultyLabel maps engine levels to friendly copy', async () => {
  const { difficultyLabel } = await gusPromise
  assert.equal(difficultyLabel('easy'), 'Taking it easy')
  assert.equal(difficultyLabel('medium'), 'Club player')
  assert.equal(difficultyLabel('hard'), 'Playing sharp')
  assert.equal(difficultyLabel(undefined), 'Still calibrating')
})

test('trainingStatusLine describes each trainer state', async () => {
  const { trainingStatusLine } = await gusPromise
  assert.match(trainingStatusLine({ running: true }, null), /Training right now/)
  assert.match(
    trainingStatusLine({ running: false, lastRun: { result: 'trained', gamesLearned: 4 } }, { lastTrained: new Date().toISOString() }),
    /Last trained today — studied 4 games\./,
  )
  assert.match(
    trainingStatusLine({ running: false, lastRun: { result: 'no_new_games' } }, null),
    /nothing new to study/,
  )
  assert.match(
    trainingStatusLine({ running: false, lastRun: { error: 'boom' } }, null),
    /hit a snag/,
  )
  assert.match(
    trainingStatusLine({ running: false, lastRun: {}, lastChecked: '2026-07-14T10:00:00Z', healthy: true }, null),
    /scheduled review last checked/,
  )
  assert.match(trainingStatusLine({ running: false, lastRun: {} }, null), /first training session with verified evidence/)
})

test('formatDay renders today/yesterday/date and tolerates junk', async () => {
  const { formatDay } = await gusPromise
  // Local-time dates: formatDay compares calendar days in the viewer's zone.
  const now = new Date(2026, 6, 8, 20, 0, 0)
  assert.equal(formatDay(new Date(2026, 6, 8, 2, 0, 0).toISOString(), now), 'today')
  assert.equal(formatDay(new Date(2026, 6, 7, 12, 0, 0).toISOString(), now), 'yesterday')
  assert.notEqual(formatDay(new Date(2026, 5, 20).toISOString(), now), '')
  assert.equal(formatDay('not-a-date', now), '')
  assert.equal(formatDay('', now), '')
})

test('aboutYouSummary flips perspective to the player', async () => {
  const { aboutYouSummary } = await gusPromise
  assert.equal(
    aboutYouSummary({ gamesVsYou: 3, yourWins: 2, yourLosses: 1, yourDraws: 0 }),
    "You've played Gus 3 games: 2 wins, 1 losses, 0 draws.",
  )
  assert.equal(aboutYouSummary(null), '')
  assert.equal(aboutYouSummary({ gamesVsYou: 0 }), '')
})

test('parseJournalText handles the trainer journal format', async () => {
  const { parseJournalText } = await gusPromise
  const text = [
    '',
    '## 2026-07-07 09:00 UTC — brain v3',
    '',
    'Learned from 2 game(s): 1 new lesson(s), 1 opening(s), 1 opponent(s).',
    '',
    '> The Qh5 attack crushed an unprepared opponent.',
    '',
    'New lessons:',
    '- Stop sacking on f7 against solid defenders',
    '',
    'Games:',
    '- abc123 vs Ethan — win (book)',
    '- def456 vs Maya — loss (engine)',
  ].join('\n')
  const blocks = parseJournalText(text)
  assert.ok(!blocks.some(b => b.text.includes('brain v3')), 'heading dropped')
  assert.deepEqual(blocks.find(b => b.type === 'quote'), { type: 'quote', text: 'The Qh5 attack crushed an unprepared opponent.' })
  assert.deepEqual(blocks.find(b => b.type === 'item'), { type: 'item', text: 'Stop sacking on f7 against solid defenders' })
  assert.ok(!blocks.some(b => b.text.includes('abc123')), 'game ids folded away')
  assert.ok(blocks.some(b => b.type === 'text' && /Reviewed 2 recorded games/.test(b.text)))
})

test('parseJournalText tolerates empty input', async () => {
  const { parseJournalText } = await gusPromise
  assert.deepEqual(parseJournalText(''), [])
  assert.deepEqual(parseJournalText(null), [])
})

test('parseJournalText preserves evidence-source labels', async () => {
  const { parseJournalText } = await gusPromise
  const blocks = parseJournalText([
    'Analyzer-verified lessons:',
    '- Compare g4 with Nf3',
    'Model-assisted suggestions (check against the position):',
    '- Consider the e4 square before attacking',
  ].join('\n'))
  assert.deepEqual(
    blocks.filter(block => block.type === 'label').map(block => block.text),
    ['Analyzer-verified lessons', 'Model-assisted suggestions (check against the position)'],
  )
})

test('openingRecord formats W-D-L', async () => {
  const { openingRecord } = await gusPromise
  assert.equal(openingRecord({ wins: 3, draws: 1, losses: 2 }), '3-1-2')
  assert.equal(openingRecord({}), '0-0-0')
})

// "Play with <bot>" — the client face of the self-learning cold-start bots
// (Gambit Gus, Fortress Fiona). Talks to the Extend service's player-facing
// endpoints:
//   GET  /bot/roster     — every hosted personality's identity
//   GET  /bot/profile    — persona, stats, matches, journal, brain, training
//   POST /bot/challenge  — summon a bot to the queue now (skips the queue gate)
// DOM: #ags-bot-panels (one card per bot, cloned from #bot-card-template),
// #ags-bot-play-actions, and the #screen-gus profile screen.
import { extendFetch } from './extend-client.js'
import { startMatchmaking } from './matchmaking.js'
import { sendEvent } from './telemetry.js'
import { setBotIdentities, clearBotIdentities } from './bot-identity.mjs'
import {
  normalizeGusProfile, formatGusRecord, formatWinRate, streakLabel,
  difficultyLabel, thinkTimeLabel, trainingStatusLine, formatDay,
  aboutYouSummary, openingRecord, parseJournalText,
} from './gus-data.mjs'

const PROFILE_TTL_MS = 60_000
export const DEFAULT_BOT_ID = 'gambit-gus'

// One cache entry per personality: the matchmaking wait screen offers a random
// bot, so several profiles can be viewed in a session and they must not clobber
// each other's cached data.
const profileCache = new Map() // botId -> { profile, at }
let gusAvailable = false
let lastViewedBotId = DEFAULT_BOT_ID

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Same transport reality as the Family panel: a production-style build without
// VITE_EXTEND_EMAIL_URL has no route to Extend, so Gus stays hidden there.
export function gusTransportAvailable() {
  return !!import.meta.env.DEV || !!import.meta.env.VITE_EXTEND_EMAIL_URL
}

function cachedFor(botId) {
  return profileCache.get(botId) || null
}

async function fetchGusProfile(force = false, botId = DEFAULT_BOT_ID) {
  const hit = cachedFor(botId)
  if (!force && hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile
  const res = await extendFetch(`/bot/profile?bot=${encodeURIComponent(botId)}`)
  if (!res.ok) throw new Error(`profile ${res.status}`)
  const profile = normalizeGusProfile(await res.json())
  profileCache.set(botId, { profile, at: Date.now() })
  return profile
}

// ── home panels ───────────────────────────────────────────────────────────────

// initGusPanel is called once the player is signed in. It reads the roster and
// renders one home card + one "Play <bot>" button per personality, revealing
// each only when that bot is actually playable. Any failure (Extend down,
// endpoint not deployed yet, guest token) just leaves the bots hidden.
export async function initGusPanel() {
  if (!gusTransportAvailable()) return
  let roster
  try {
    roster = await fetchBotRoster()
  } catch (error) {
    console.warn('[bot] roster unavailable:', error?.message || error)
    return
  }

  // Identities go out before any profile loads: they gate friend requests and
  // High Fives, and a bot must never look like a human just because its
  // profile fetch is slow.
  setBotIdentities(roster)
  // The wait screen and the challenge copy read names/glyphs from here rather
  // than from a hardcoded list.
  window.agsBotRoster = roster.map(bot => ({ id: bot.id, name: bot.name, glyph: bot.glyph || '' }))

  // One slow or broken bot must not hide the rest of the roster.
  const loaded = await Promise.all(roster.map(async bot => {
    try {
      return { bot, profile: await fetchGusProfile(false, bot.id) }
    } catch (error) {
      console.warn(`[bot] ${bot.id} profile unavailable:`, error?.message || error)
      return null
    }
  }))

  const rendered = loaded.filter(Boolean)
  if (!rendered.length) return
  gusAvailable = rendered.some(entry => entry.profile.playable)
  renderHomePanels(rendered)
}

// fetchBotRoster returns every hosted personality. A deployment predating
// /bot/roster still gets the default bot from its profile, so the home card
// never disappears on an older service.
async function fetchBotRoster() {
  try {
    const res = await extendFetch('/bot/roster')
    if (!res.ok) throw new Error(`roster ${res.status}`)
    const data = await res.json()
    const bots = (Array.isArray(data?.bots) ? data.bots : [])
      .filter(bot => bot && bot.id)
    if (bots.length) return bots
  } catch (error) {
    console.warn('[bot] roster fetch failed, falling back to the default bot:', error?.message || error)
  }
  const profile = await fetchGusProfile()
  return [{
    id: profile.bot.id || DEFAULT_BOT_ID,
    userId: profile.bot.userId || '',
    name: profile.bot.name || 'Gambit Gus',
    glyph: profile.bot.glyph || '',
  }]
}

// challengeBot routes through app.js so the challenge gets the full waiting-room
// and peer-connection flow, not just the backend summon.
function challengeBot(botId) {
  if (typeof window.startBotChallenge === 'function') window.startBotChallenge(botId)
}

export function resetGusPanel() {
  gusAvailable = false
  profileCache.clear()
  clearBotIdentities()
  window.agsBotRoster = []
  const panels = document.getElementById('ags-bot-panels')
  if (panels) panels.replaceChildren()
  const playActions = document.getElementById('ags-bot-play-actions')
  if (playActions) playActions.replaceChildren()
}

function renderHomePanels(entries) {
  const panels = document.getElementById('ags-bot-panels')
  const playActions = document.getElementById('ags-bot-play-actions')
  const template = document.getElementById('bot-card-template')
  if (!panels || !template) return
  panels.replaceChildren()
  if (playActions) playActions.replaceChildren()

  for (const { bot, profile } of entries) {
    panels.append(buildBotCard(template, bot, profile))
    if (playActions && profile.playable) playActions.append(buildPlayButton(bot, profile))
  }
}

function buildBotCard(template, bot, profile) {
  const card = template.content.firstElementChild.cloneNode(true)
  const { stats, playable, journal } = profile
  const name = profile.bot.name || bot.name || bot.id
  const glyph = profile.bot.glyph || bot.glyph || ''
  const sel = attr => card.querySelector(`[${attr}]`)

  card.dataset.botCard = bot.id
  sel('data-bot-glyph').textContent = glyph
  sel('data-bot-name').textContent = name
  sel('data-bot-tagline').textContent = profile.bot.tagline ? `“${profile.bot.tagline}”` : ''

  const bits = [stats.games ? `${formatGusRecord(stats)} lifetime` : 'Brand new — no games yet']
  const streak = streakLabel(stats)
  if (streak) bits.push(streak.toLowerCase())
  sel('data-bot-record').textContent = bits.join(' · ')

  const teaser = journal[0]
  const teaserQuote = teaser && parseJournalText(teaser.text).find(b => b.type === 'quote')
  sel('data-bot-blurb').textContent = teaserQuote
    ? `${name}’s model-assisted reflection: “${teaserQuote.text}”`
    // Deliberately pronoun-free: personalities differ and the roster is open.
    : 'Reviews completed games and publishes evidence-checked training notes.'

  const open = sel('data-bot-open')
  open.textContent = `Meet ${name} →`
  open.addEventListener('click', () => openGusProfile(bot.id))
  sel('data-bot-stats').addEventListener('click', () => openGusProfile(bot.id))

  const challenge = sel('data-bot-challenge')
  challenge.textContent = `${glyph} Challenge ${name}`.trim()
  challenge.style.display = playable ? '' : 'none'
  challenge.addEventListener('click', () => challengeBot(bot.id))
  return card
}

function buildPlayButton(bot, profile) {
  const name = profile.bot.name || bot.name || bot.id
  const glyph = profile.bot.glyph || bot.glyph || ''
  const button = document.createElement('button')
  button.className = 'btn btn-gus'
  button.dataset.botPlay = bot.id
  button.textContent = `Play ${name} ${glyph}`.trim()
  button.addEventListener('click', () => challengeBot(bot.id))
  return button
}

// ── profile screen ────────────────────────────────────────────────────────────

export async function openGusProfile(botId = DEFAULT_BOT_ID) {
  lastViewedBotId = botId
  if (typeof window.showScreen === 'function') window.showScreen('gus')
  sendEvent('gus_profile_viewed', { bot: botId })
  setStatus('Loading the latest…', '')
  const hit = cachedFor(botId)
  try {
    const profile = await fetchGusProfile(!hit || Date.now() - hit.at > PROFILE_TTL_MS, botId)
    renderGusScreen(profile)
    setStatus('', '')
  } catch (error) {
    console.warn(`[bot] ${botId} profile load failed:`, error?.message || error)
    if (hit) {
      renderGusScreen(hit.profile)
      setStatus('Showing the last known info — refresh to retry.', 'error')
    } else {
      setStatus('Could not reach this bot right now. Check your connection and try again.', 'error')
    }
  }
}

export async function refreshGusProfile() {
  profileCache.delete(lastViewedBotId)
  await openGusProfile(lastViewedBotId)
}

let gusRecentMatches = []

export function showGusTab(name = 'overview') {
  const allowed = new Set(['overview', 'journal', 'training', 'matches'])
  const active = allowed.has(name) ? name : 'overview'
  document.querySelectorAll('[data-gus-tab]').forEach(tab => {
    const selected = tab.dataset.gusTab === active
    tab.classList.toggle('active', selected)
    tab.setAttribute('aria-selected', selected ? 'true' : 'false')
    tab.tabIndex = selected ? 0 : -1
  })
  document.querySelectorAll('[data-gus-panel]').forEach(panel => {
    const selected = panel.dataset.gusPanel === active
    panel.classList.toggle('active', selected)
    panel.setAttribute('aria-hidden', selected ? 'false' : 'true')
    panel.tabIndex = selected ? 0 : -1
  })
}

function initGusTabs() {
  document.querySelectorAll('[data-gus-tab]').forEach(tab => {
    if (tab.dataset.gusTabBound === '1') return
    tab.dataset.gusTabBound = '1'
    tab.addEventListener('click', () => showGusTab(tab.dataset.gusTab))
  })
}

function renderGusScreen(profile) {
  initGusTabs()
  showGusTab('overview')
  const { bot, stats, brain, aboutYou, journal, training, recentMatches, playable } = profile

  setText('gus-profile-name', bot.name)
  setText('gus-profile-tagline', bot.tagline ? `“${bot.tagline}”` : '')
  // Deliberately pronoun-free: personalities differ and the roster is open.
  setText('gus-personality', bot.personality || 'A chess bot with personality — plays, loses, learns, and comes back sharper.')
  // The profile screen is reachable for any personality (the wait screen offers
  // a random one), so the challenge button must name and summon the bot being
  // viewed rather than always Gus. The glyph comes from the bot's persona file,
  // so a new personality needs no edit here.
  const challengeBtn = document.getElementById('btn-gus-challenge')
  if (challengeBtn) {
    challengeBtn.style.display = playable ? '' : 'none'
    challengeBtn.textContent = `${bot.glyph || ''} Play ${bot.name} Now`.trim()
    challengeBtn.dataset.botId = bot.id
    if (challengeBtn.dataset.botBound !== '1') {
      challengeBtn.dataset.botBound = '1'
      challengeBtn.addEventListener('click', () => challengeBot(challengeBtn.dataset.botId || DEFAULT_BOT_ID))
    }
  }
  const offlineNote = document.getElementById('gus-offline-note')
  if (offlineNote) offlineNote.style.display = playable ? 'none' : ''

  // Stats grid
  setText('gus-stat-record', stats.games ? formatGusRecord(stats) : '—')
  setText('gus-stat-winrate', formatWinRate(stats))
  setText('gus-stat-week', String(stats.gamesLast7Days || 0))
  setText('gus-stat-strength', difficultyLabel(brain?.difficulty))
  const form = streakLabel(stats)
  setText('gus-stat-form', form || (stats.games ? 'Mixed results' : 'No games yet'))
  setText('gus-stat-brain', brain ? `v${brain.version}` : 'v0')

  // What Gus knows about you
  const aboutCard = document.getElementById('gus-about-you')
  if (aboutCard) {
    const summary = aboutYouSummary(aboutYou)
    if (summary || aboutYou?.notes) {
      setText('gus-about-you-record', summary)
      const noteEl = document.getElementById('gus-about-you-note')
      if (noteEl) {
        noteEl.style.display = aboutYou?.notes ? '' : 'none'
        noteEl.textContent = aboutYou?.notes ? `Gus’s scouting note on you: “${aboutYou.notes}”` : ''
      }
      aboutCard.style.display = ''
    } else {
      aboutCard.style.display = 'none'
    }
  }

  renderJournal(journal)
  renderTraining(training, brain)
  renderMatches(recentMatches, bot)
}

function renderJournal(journal) {
  const listEl = document.getElementById('gus-journal-list')
  if (!listEl) return
  if (!journal.length) {
    listEl.innerHTML = `<div class="profile-history-empty">
      <strong>No journal entries yet</strong>
      <span>Gus writes a diary entry after each nightly training session. Play him a game and check back tomorrow!</span>
    </div>`
    return
  }
  listEl.innerHTML = journal.map(entry => {
    const blocks = parseJournalText(entry.text)
    const body = blocks.map(block => {
      if (block.type === 'quote') return `<blockquote>${esc(block.text)}</blockquote>`
      if (block.type === 'label') return `<span class="gus-journal-label">${esc(block.text)}</span>`
      if (block.type === 'item') return `<li>${esc(block.text)}</li>`
      return `<p>${esc(block.text)}</p>`
    }).join('')
    const day = formatDay(entry.date)
    return `<article class="gus-journal-entry">
      <header>${esc(entry.date)}${day && day !== entry.date ? ` · ${esc(day)}` : ''}</header>
      <div class="gus-journal-body">${body}</div>
    </article>`
  }).join('')
}

function renderTraining(training, brain) {
  setText('gus-training-status', trainingStatusLine(training, brain))
  setText('gus-training-learned', brain ? String(brain.gamesLearnedFrom || 0) : '0')
  setText('gus-training-book', brain ? String(brain.bookLines || 0) : '0')
  setText('gus-training-opponents', brain ? String(brain.opponentsKnown || 0) : '0')
  const think = thinkTimeLabel(brain)
  const pace = document.getElementById('gus-training-pace')
  if (pace) {
    pace.style.display = think ? '' : 'none'
    pace.textContent = think
  }

  const lessonsEl = document.getElementById('gus-lessons-list')
  if (lessonsEl) {
    const lessons = brain?.lessons || []
    lessonsEl.innerHTML = lessons.length
      ? lessons.map(l => `<li>${esc(l.text)}${l.learnedAt ? `<span class="gus-lesson-date">${esc(formatDay(l.learnedAt) || l.learnedAt)}</span>` : ''}</li>`).join('')
      : '<li class="gus-empty-line">Nothing yet — lessons appear after Gus reflects on his games.</li>'
  }

  const openingsEl = document.getElementById('gus-openings-list')
  if (openingsEl) {
    const openings = brain?.openings || []
    openingsEl.innerHTML = openings.length
      ? openings.map(o => `<div class="gus-opening-row">
          <span class="gus-opening-line">${esc(o.line)}</span>
          <span class="gus-opening-record" title="wins-draws-losses">${esc(openingRecord(o))} in ${o.played} ${o.played === 1 ? 'game' : 'games'}</span>
          ${o.note ? `<span class="gus-opening-note">${esc(o.note)}</span>` : ''}
        </div>`).join('')
      : '<div class="gus-empty-line">His repertoire is still forming — favorite openings show up as he discovers what works.</div>'
  }
}

function renderMatches(matches, bot) {
  const listEl = document.getElementById('gus-match-history')
  const countEl = document.getElementById('gus-match-count')
  if (!listEl) return
  gusRecentMatches = matches
  if (countEl) countEl.textContent = matches.length ? `last ${matches.length}` : ''
  if (!matches.length) {
    listEl.innerHTML = `<div class="profile-history-empty">
      <strong>No matches yet</strong>
      <span>Be the first: challenge Gus and your game will show up here.</span>
    </div>`
    return
  }
  const myUserId = window.agsCurrentUserId || ''
  listEl.innerHTML = matches.map((match, index) => {
    const canReplay = Array.isArray(match.moves) && match.moves.length > 0
    const ended = new Date(match.endedAt)
    const time = Number.isNaN(ended.getTime())
      ? 'Unknown time'
      : ended.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    // Results are stored from Gus's perspective; it's his page, so color them
    // his way too (green when Gus won).
    const raw = (match.result || '').toLowerCase()
    const label = raw === 'win' ? 'Gus won' : raw === 'loss' ? 'Gus lost' : raw === 'draw' ? 'Draw' : 'Unfinished'
    const resultClass = ['win', 'loss', 'draw'].includes(raw) ? raw : 'completed'
    const isYou = myUserId && match.opponentUserId === myUserId
    const opponent = isYou ? 'You' : (match.opponentName || 'A challenger')
    return `<button class="profile-history-row${canReplay ? ' replayable' : ' no-replay'}" type="button" ${canReplay ? `data-gus-replay="${index}"` : 'disabled'}>
      <span class="profile-history-result ${resultClass}">${esc(label)}</span>
      <div class="profile-history-main">
        <strong>vs ${esc(opponent)}</strong>
        <span>${esc(time)} · ${canReplay ? 'Tap to replay' : 'Replay unavailable'}</span>
      </div>
      <div class="profile-history-meta">
        <span>Moves</span>
        <span>${Array.isArray(match.moves) ? Math.ceil(match.moves.length / 2) : '—'}</span>
      </div>
    </button>`
  }).join('')
  listEl.querySelectorAll('[data-gus-replay]').forEach(button => {
    button.addEventListener('click', () => {
      const match = gusRecentMatches[Number(button.dataset.gusReplay)]
      if (match) window.agsReplayMatchData?.(match, 'gus')
    })
  })
}

// ── challenge (matchmake with Gus) ────────────────────────────────────────────

// agsStartGusMatchmaking queues a normal matchmaking ticket, then asks Extend
// to summon Gus immediately (bypassing the humans-first gate — the player
// explicitly chose the bot). If the summon call fails, the ticket stays queued:
// the match watcher's regular gate is the fallback, so the player still gets a
// game. Note AGS matchmaking does the pairing — if another human is waiting in
// the pool, the player may (by design) get the human instead.
// Every bot shares the human quickmatch pool: one AMS fleet backs them all, and
// naming the bot only pins which personality the claimed DS wakes up as. An
// unnamed challenge lets the DS choose, which is what the cold-start gate does.
export async function startBotMatchmaking(botId, onFound, onTimeout, onError) {
  let failed = false
  await startMatchmaking(onFound, onTimeout, message => { failed = true; onError(message) })
  if (failed) return
  sendEvent('gus_challenge_requested', { bot: botId })
  try {
    const res = await extendFetch(`/bot/challenge?bot=${encodeURIComponent(botId)}`, { method: 'POST' })
    if (!res.ok) console.warn(`[bot] ${botId} challenge returned`, res.status, '— relying on the cold-start gate')
  } catch (error) {
    console.warn(`[bot] ${botId} challenge failed:`, error?.message || error, '— relying on the cold-start gate')
  }
}

export function startGusMatchmaking(onFound, onTimeout, onError) {
  return startBotMatchmaking('gambit-gus', onFound, onTimeout, onError)
}

export function isGusAvailable() {
  return gusAvailable
}

// ── helpers ───────────────────────────────────────────────────────────────────

function setText(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

function setStatus(message, tone) {
  const el = document.getElementById('gus-profile-status')
  if (!el) return
  el.textContent = message
  el.className = 'auth-message' + (tone ? ` ${tone}` : '')
  el.style.display = message ? '' : 'none'
}

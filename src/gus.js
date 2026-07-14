// "Play with Gus" — the client face of the self-learning cold-start bot
// (Gambit Gus). Talks to the Extend service's player-facing endpoints:
//   GET  /bot/profile    — persona, stats, matches, journal, brain, training
//   POST /bot/challenge  — summon Gus to the queue right now (skips the queue gate)
// DOM: the #ags-gus-panel home card and the #screen-gus profile screen.
import { extendFetch } from './extend-client.js'
import { startMatchmaking } from './matchmaking.js'
import { sendEvent } from './telemetry.js'
import {
  normalizeGusProfile, formatGusRecord, formatWinRate, streakLabel,
  difficultyLabel, thinkTimeLabel, trainingStatusLine, formatDay,
  aboutYouSummary, openingRecord, parseJournalText,
} from './gus-data.mjs'

const PROFILE_TTL_MS = 60_000

let cachedProfile = null
let cachedAt = 0
let gusAvailable = false

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Same transport reality as the Family panel: a production-style build without
// VITE_EXTEND_EMAIL_URL has no route to Extend, so Gus stays hidden there.
export function gusTransportAvailable() {
  return !!import.meta.env.DEV || !!import.meta.env.VITE_EXTEND_EMAIL_URL
}

async function fetchGusProfile(force = false) {
  if (!force && cachedProfile && Date.now() - cachedAt < PROFILE_TTL_MS) return cachedProfile
  const res = await extendFetch('/bot/profile')
  if (!res.ok) throw new Error(`profile ${res.status}`)
  cachedProfile = normalizeGusProfile(await res.json())
  cachedAt = Date.now()
  return cachedProfile
}

// ── home panel ────────────────────────────────────────────────────────────────

// initGusPanel is called once the player is signed in. It probes the profile;
// on success it reveals the home card and the "Play Gus" button. Any failure
// (Extend down, endpoint not deployed yet, guest token) just leaves Gus hidden.
export async function initGusPanel() {
  if (!gusTransportAvailable()) return
  let profile
  try {
    profile = await fetchGusProfile()
  } catch (error) {
    console.warn('[gus] profile unavailable:', error?.message || error)
    return
  }
  gusAvailable = true
  window.agsGambitGusUserId = profile.bot.userId || profile.bot.id || 'gambit-gus'
  window.agsGambitGusName = profile.bot.name || 'Gambit Gus'
  renderHomePanel(profile)
}

export function resetGusPanel() {
  gusAvailable = false
  cachedProfile = null
  cachedAt = 0
  window.agsGambitGusUserId = ''
  window.agsGambitGusName = 'Gambit Gus'
  const panel = document.getElementById('ags-gus-panel')
  if (panel) panel.style.display = 'none'
  const playBtn = document.getElementById('btn-play-gus')
  if (playBtn) playBtn.style.display = 'none'
}

function renderHomePanel(profile) {
  const panel = document.getElementById('ags-gus-panel')
  if (!panel) return
  const { bot, stats, playable, journal } = profile

  setText('gus-home-name', bot.name)
  setText('gus-home-tagline', bot.tagline ? `“${bot.tagline}”` : '')
  const bits = []
  bits.push(stats.games ? `${formatGusRecord(stats)} lifetime` : 'Brand new — no games yet')
  const streak = streakLabel(stats)
  if (streak) bits.push(streak.toLowerCase())
  setText('gus-home-record', bits.join(' · '))

  const teaser = journal[0]
  const teaserQuote = teaser && parseJournalText(teaser.text).find(b => b.type === 'quote')
  setText('gus-home-blurb', teaserQuote
    ? `Gus’s model-assisted reflection: “${teaserQuote.text}”`
    : 'He reviews completed games and publishes evidence-checked training notes.')

  const playBtnHome = document.getElementById('btn-play-gus-home')
  if (playBtnHome) playBtnHome.style.display = playable ? '' : 'none'
  const playBtn = document.getElementById('btn-play-gus')
  if (playBtn) playBtn.style.display = playable ? '' : 'none'
  panel.style.display = ''
}

// ── profile screen ────────────────────────────────────────────────────────────

export async function openGusProfile() {
  if (typeof window.showScreen === 'function') window.showScreen('gus')
  sendEvent('gus_profile_viewed', {})
  setStatus('Loading Gus’s latest…', '')
  try {
    const profile = await fetchGusProfile(Date.now() - cachedAt > PROFILE_TTL_MS)
    renderGusScreen(profile)
    setStatus('', '')
  } catch (error) {
    console.warn('[gus] profile load failed:', error?.message || error)
    if (cachedProfile) {
      renderGusScreen(cachedProfile)
      setStatus('Showing Gus’s last known info — refresh to retry.', 'error')
    } else {
      setStatus('Could not reach Gus right now. Check your connection and try again.', 'error')
    }
  }
}

export async function refreshGusProfile() {
  cachedAt = 0
  await openGusProfile()
}

let gusRecentMatches = []

export function showGusTab(name = 'overview') {
  const allowed = new Set(['overview', 'journal', 'training', 'matches'])
  const active = allowed.has(name) ? name : 'overview'
  document.querySelectorAll('[data-gus-tab]').forEach(tab => {
    const selected = tab.dataset.gusTab === active
    tab.classList.toggle('active', selected)
    tab.setAttribute('aria-selected', selected ? 'true' : 'false')
  })
  document.querySelectorAll('[data-gus-panel]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.gusPanel === active)
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
  setText('gus-personality', bot.personality || 'A chess bot with personality — he plays, loses, learns, and comes back sharper.')
  const challengeBtn = document.getElementById('btn-gus-challenge')
  if (challengeBtn) challengeBtn.style.display = playable ? '' : 'none'
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
export async function startGusMatchmaking(onFound, onTimeout, onError) {
  let failed = false
  await startMatchmaking(onFound, onTimeout, message => { failed = true; onError(message) })
  if (failed) return
  sendEvent('gus_challenge_requested', {})
  try {
    const res = await extendFetch('/bot/challenge', { method: 'POST' })
    if (!res.ok) console.warn('[gus] challenge returned', res.status, '— relying on the cold-start gate')
  } catch (error) {
    console.warn('[gus] challenge failed:', error?.message || error, '— relying on the cold-start gate')
  }
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

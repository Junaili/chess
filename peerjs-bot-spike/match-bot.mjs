// The bot match loop (non-blocking / concurrent). One login, one PeerJS peer,
// many simultaneous games. It keeps a matchmaking ticket in the pool; on each
// match it starts the game WITHOUT waiting, then immediately re-queues — so the
// same Gus login can play several humans at once (AGS allows multiple active
// sessions per user).
//
//   node match-bot.mjs
//
// Run it, then "Play vs Random" from one or more browsers — each gets matched
// with Gus and plays concurrently.
//
// (Still piece #2 behavior: the bot is always queued, so matches are ~instant.
// The 20s "only after a human waits" gate is piece #3, the Extend watcher.)
import './env.mjs'
import { login, createMatchTicket, getMatchTicket, getGameSession } from './ags.mjs'
import { loadPeer, playGame, log } from './play.mjs'

const POOL = process.env.MATCH_POOL || 'chess-quickmatch'
const POLL_MS = 2000
const JOINER_CONNECT_DELAY_MS = 1500 // mirror the web client's joiner delay
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let auth = null // { token, userId }
async function ensureLogin() {
  if (auth) return auth
  auth = await login(process.env.BOT_EMAIL, process.env.BOT_PASSWORD)
  log('logged in as bot — userId =', auth.userId)
  return auth
}

const shortTag = (id) => (id ? id.slice(0, 6) : '?')

async function main() {
  await ensureLogin()
  const Peer = await loadPeer()

  // One persistent peer, registered under the bot's userId. It can accept MANY
  // incoming connections (bot-as-host games) and initiate many outbound
  // connections (bot-as-joiner games) at the same time.
  const peerId = auth.userId.replace(/-/g, '')
  const peer = new Peer(peerId, { debug: 1 })
  await new Promise((resolve, reject) => {
    peer.on('open', (id) => { log('peer registered as', id); resolve() })
    peer.on('error', reject)
    setTimeout(() => reject(new Error('peer open timeout')), 15000)
  })
  peer.on('error', (e) => log('peer error:', e?.type || e?.message || e))

  // Bot-as-HOST games: whenever a human (joiner) connects to us, play them.
  // This fires independently of the queue loop, one game per connection.
  peer.on('connection', (conn) => {
    const tag = shortTag(conn.peer)
    log(`[${tag}]`, 'incoming connection (bot is HOST)')
    playGame(conn, 'host', { botName: 'Gambit Gus', botId: auth.userId, tag })
      .then((why) => log(`[${tag}]`, 'host game ended:', why))
      .catch((e) => log(`[${tag}]`, 'host game error:', e?.message || e))
  })

  // Continuous queue loop: keep one ticket active; on each match, spawn the game
  // and immediately re-queue for the next one.
  for (;;) {
    try {
      const ticketId = await createMatchTicket(auth.token, POOL)
      const sessionId = await waitForMatch(ticketId)
      if (sessionId) {
        // Do NOT await — let it run concurrently while we re-queue.
        handleMatch(peer, sessionId).catch((e) => log('match handling error:', e?.message || e))
      }
    } catch (e) {
      log('queue loop error:', e?.message || e)
      if (String(e?.message || '').includes('401')) { auth = null; await ensureLogin() }
      await sleep(3000)
    }
  }
}

// Poll a ticket until it matches (→ sessionId) or is gone/expired (→ null).
async function waitForMatch(ticketId) {
  for (;;) {
    await sleep(POLL_MS)
    let t
    try { t = await getMatchTicket(auth.token, ticketId) } catch { return null }
    if (t.notFound) return null // consumed/expired → re-queue
    if (t.matchFound && (t.sessionID || t.sessionId)) return t.sessionID || t.sessionId
  }
}

// Given a matched session, determine our role and (for joiner) connect out and
// play. Host games are handled by peer.on('connection').
async function handleMatch(peer, sessionId) {
  const sess = await getGameSession(auth.token, sessionId)
  const members = (sess.members || []).map((m) => m.id).filter(Boolean)
  if (members.length < 2) return

  const sorted = members.slice().sort()
  const hostId = sorted[0]
  const botIsHost = hostId === auth.userId
  const tag = shortTag(sessionId)

  if (botIsHost) {
    log(`[${tag}]`, 'matched — bot is HOST, awaiting the opponent’s connection')
    return // peer.on('connection') will handle it
  }

  const hostPeerId = hostId.replace(/-/g, '')
  log(`[${tag}]`, 'matched — bot is JOINER, connecting to', shortTag(hostPeerId))
  await sleep(JOINER_CONNECT_DELAY_MS) // let the human host register its peer
  const conn = peer.connect(hostPeerId, { reliable: true })
  const why = await playGame(conn, 'joiner', { botName: 'Gambit Gus', botId: auth.userId, tag })
  log(`[${tag}]`, 'joiner game ended:', why)
  try { conn.close() } catch {}
}

main().catch((e) => { console.error('fatal:', e?.message || e); process.exit(1) })

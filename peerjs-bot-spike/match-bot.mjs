// The bot match loop, TRIGGER-BASED (cold-start gate, piece #3).
//
// The bot is NOT always queued. The Extend watcher (ethan-chess-service) polls
// the pool and, when a human has waited > ~20s, POSTs /trigger here. On each
// trigger the bot queues ONE ticket, gets paired with that waiting human, and
// plays. Tickets are created one-at-a-time (respecting one active ticket per
// user); games run concurrently (one login, one PeerJS peer, many sessions).
//
//   node match-bot.mjs
//
// Then run the Extend service with the watcher enabled (see README).
import './env.mjs'
import http from 'node:http'
import { login, createMatchTicket, getMatchTicket, deleteMatchTicket, getGameSession } from './ags.mjs'
import { loadPeer, playGame, log } from './play.mjs'

const POOL = process.env.MATCH_POOL || 'chess-quickmatch'
const POLL_MS = 2000
// A genuinely-waiting human (already queued >20s) matches within a poll or two.
// If our ticket hasn't matched in this window, there was no waiting human — cancel
// it so it never lingers long enough for the watcher to re-trigger on it.
const MATCH_WAIT_MS = 10000
const JOINER_CONNECT_DELAY_MS = 1500
const TRIGGER_PORT = Number(process.env.BOT_TRIGGER_PORT) || 8091
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shortTag = (id) => (id ? id.slice(0, 6) : '?')

let auth = null // { token, userId }
let peer = null
let pending = 0
let pumping = false

async function ensureLogin() {
  if (auth) return auth
  auth = await login(process.env.BOT_EMAIL, process.env.BOT_PASSWORD)
  log('logged in as bot — userId =', auth.userId)
  return auth
}

async function main() {
  await ensureLogin()
  const Peer = await loadPeer()

  const peerId = auth.userId.replace(/-/g, '')
  peer = new Peer(peerId, { debug: 1 })
  await new Promise((resolve, reject) => {
    peer.on('open', (id) => { log('peer registered as', id); resolve() })
    peer.on('error', reject)
    setTimeout(() => reject(new Error('peer open timeout')), 15000)
  })
  peer.on('error', (e) => log('peer error:', e?.type || e?.message || e))

  // Bot-as-HOST games: any human (joiner) that connects to us gets played. One
  // handler serves many concurrent connections.
  peer.on('connection', (conn) => {
    const tag = shortTag(conn.peer)
    log(`[${tag}]`, 'incoming connection (bot is HOST)')
    playGame(conn, 'host', { botName: 'Gambit Gus', botId: auth.userId, tag })
      .then((why) => log(`[${tag}]`, 'host game ended:', why))
      .catch((e) => log(`[${tag}]`, 'host game error:', e?.message || e))
  })

  // Trigger endpoint the Extend watcher calls when a human has waited too long.
  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/trigger') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      pending++
      pump()
      return
    }
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return }
    res.writeHead(404); res.end()
  }).listen(TRIGGER_PORT, () => log('trigger server listening on :' + TRIGGER_PORT))

  log('ready — NOT auto-queued; waiting for triggers from the Extend watcher')
}

// Process triggers one ticket at a time (serialized create), so the bot never
// has more than one active matchmaking ticket. Games still run concurrently.
async function pump() {
  if (pumping) return
  pumping = true
  while (pending > 0) {
    pending--
    try {
      await queueOne()
    } catch (e) {
      log('queueOne error:', e?.message || e)
      if (String(e?.message || '').includes('401')) { auth = null; await ensureLogin() }
    }
  }
  pumping = false
}

async function queueOne() {
  log('triggered → queuing one ticket')
  const ticketId = await createMatchTicket(auth.token, POOL)
  const sessionId = await waitForMatch(ticketId)
  if (!sessionId) { log('ticket', shortTag(ticketId), 'expired without a match'); return }
  // Spawn the game concurrently; return so pump() can serve the next trigger.
  handleMatch(peer, sessionId).catch((e) => log('match handling error:', e?.message || e))
}

async function waitForMatch(ticketId) {
  const deadline = Date.now() + MATCH_WAIT_MS
  for (;;) {
    await sleep(POLL_MS)
    let t
    try { t = await getMatchTicket(auth.token, ticketId) } catch { return null }
    if (t.notFound) return null
    if (t.matchFound && (t.sessionID || t.sessionId)) return t.sessionID || t.sessionId
    if (Date.now() > deadline) {
      log('ticket', shortTag(ticketId), 'no match within 10s — cancelling (no waiting human)')
      await deleteMatchTicket(auth.token, ticketId)
      return null
    }
  }
}

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
    return // peer.on('connection') handles it
  }

  const hostPeerId = hostId.replace(/-/g, '')
  log(`[${tag}]`, 'matched — bot is JOINER, connecting to', shortTag(hostPeerId))
  await sleep(JOINER_CONNECT_DELAY_MS)
  const conn = peer.connect(hostPeerId, { reliable: true })
  const why = await playGame(conn, 'joiner', { botName: 'Gambit Gus', botId: auth.userId, tag })
  log(`[${tag}]`, 'joiner game ended:', why)
  try { conn.close() } catch {}
}

main().catch((e) => { console.error('fatal:', e?.message || e); process.exit(1) })

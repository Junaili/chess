// The bot match loop: log in as the bot user, queue for matchmaking like a real
// player, and on each match play the human over PeerJS. Run it, then "Play vs
// Random" on the web client — you'll be matched with the bot.
//
//   node match-bot.mjs
//
// (This is piece #2: the bot is ALWAYS queued. The 20s "only after a human waits"
// trigger and the AMS hosting come next.)
import './env.mjs'
import { login, createMatchTicket, getMatchTicket, deleteMatchTicket, getGameSession } from './ags.mjs'
import { loadPeer, playGame, log } from './play.mjs'

const POOL = process.env.MATCH_POOL || 'chess-quickmatch'
const POLL_MS = 2000
const JOINER_CONNECT_DELAY_MS = 1500 // mirror the web client's joiner delay
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let session = null // { token, userId }

async function ensureLogin() {
  if (session) return session
  session = await login(process.env.BOT_EMAIL, process.env.BOT_PASSWORD)
  log('logged in as bot — userId =', session.userId)
  return session
}

// Resolve with the next incoming DataConnection on the peer.
function nextConnection(peer) {
  return new Promise((resolve) => peer.once('connection', resolve))
}

async function main() {
  await ensureLogin()
  const Peer = await loadPeer()

  // One persistent peer, registered under the bot's userId, so when the bot is
  // the host the human can always reach it (no per-match registration race).
  const peerId = session.userId.replace(/-/g, '')
  const peer = new Peer(peerId, { debug: 1 })
  await new Promise((resolve, reject) => {
    peer.on('open', (id) => { log('peer registered as', id); resolve() })
    peer.on('error', reject)
    setTimeout(() => reject(new Error('peer open timeout')), 15000)
  })
  peer.on('error', (e) => log('peer error:', e?.type || e?.message || e))

  for (;;) {
    try {
      await oneMatch(peer)
    } catch (e) {
      log('loop error:', e?.message || e)
      if (String(e?.message || '').includes('401')) { session = null; await ensureLogin() }
      await sleep(3000)
    }
  }
}

async function oneMatch(peer) {
  const { token, userId } = session
  log('queuing for', POOL, '…')
  let ticketId = await createMatchTicket(token, POOL)

  let sessionId = null
  while (!sessionId) {
    await sleep(POLL_MS)
    const t = await getMatchTicket(token, ticketId)
    if (t.notFound) { ticketId = await createMatchTicket(token, POOL); continue } // expired → requeue
    if (t.matchFound && (t.sessionID || t.sessionId)) sessionId = t.sessionID || t.sessionId
  }

  log('matched! session', sessionId)
  const sess = await getGameSession(token, sessionId)
  const members = (sess.members || []).map((m) => m.id).filter(Boolean)
  if (members.length < 2) { log('session has <2 members — skipping'); return }

  const sorted = members.slice().sort()
  const hostId = sorted[0]
  const botIsHost = hostId === userId
  const hostPeerId = hostId.replace(/-/g, '')
  log('members:', members.join(', '), '| bot is', botIsHost ? 'HOST (White)' : 'JOINER')

  let conn
  if (botIsHost) {
    conn = await Promise.race([
      nextConnection(peer),
      sleep(20000).then(() => { throw new Error('timed out waiting for opponent to connect') }),
    ])
  } else {
    await sleep(JOINER_CONNECT_DELAY_MS) // let the human host register its peer first
    conn = peer.connect(hostPeerId, { reliable: true })
  }

  const why = await playGame(conn, botIsHost ? 'host' : 'joiner', { botName: 'Gambit Gus', botId: userId })
  log('game ended (', why, ') — re-queuing')
  try { conn.close() } catch {}
  await deleteMatchTicket(token, ticketId)
}

main().catch((e) => { console.error('fatal:', e?.message || e); process.exit(1) })

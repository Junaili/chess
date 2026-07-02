// ds.mjs — the AMS dedicated-server entrypoint for the chess bot (piece #4).
//
// EPHEMERAL, ONE-GAME lifecycle. An AMS warm pool holds these ready; when a human
// has waited ~20s the Extend match-watcher CLAIMS one and POSTs /trigger to it.
// This instance then logs in as the bot user, queues ONE ticket, gets paired with
// the waiting human, plays ONE game over PeerJS, and drains so AMS recycles it.
//
// It reuses the proven bot pieces unchanged: ags.mjs (login/ticket/session),
// play.mjs (playGame over PeerJS), engine.mjs (chess + AI). The only DS-specific
// bits are the watchdog lifecycle (watchdog.mjs) and the one-game drain policy.
//
//   AMS:    node ds.mjs         (watchdog at ws://localhost:5555/watchdog)
//   local:  node ds.mjs         (no watchdog -> standalone; curl :8091/trigger)
import './env.mjs'
import http from 'node:http'
import { login, createMatchTicket, getMatchTicket, deleteMatchTicket, getGameSession } from './ags.mjs'
import { Watchdog } from './watchdog.mjs'

// play.mjs pulls in the native @roamhq/wrtc addon. We DEFER importing it (dynamic
// import inside the game path) so that if the addon fails to load on the host
// (e.g. a glibc mismatch), the DS still connects the watchdog, registers, and
// LOGS the error — instead of crashing at startup before AMS ever sees it.
let _play = null
async function play() {
  if (!_play) _play = await import('./play.mjs')
  return _play
}
const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(ts(), ...a)

// A failed native WebRTC load (e.g. glibc too old for @roamhq/wrtc) throws from
// deep in a CJS require and can escape our try/catch. Keep the DS ALIVE and
// registered so AMS sees a ready server (and its logs surface the real cause)
// rather than crash-looping into StartError.
process.on('uncaughtException', (e) => log('uncaughtException (continuing):', e?.message || e))
process.on('unhandledRejection', (e) => log('unhandledRejection (continuing):', e?.message || e))

const POOL = process.env.MATCH_POOL || 'chess-quickmatch'
const POLL_MS = 2000
// A genuinely-waiting human matches within a poll or two. If our ticket hasn't
// matched in this window there was no waiting human (spurious claim) — cancel and
// drain rather than linger.
const MATCH_WAIT_MS = 10000
const JOINER_CONNECT_DELAY_MS = 1500

// AMS substitutes placeholders in the config's commandLineArguments and passes
// them to the executable, e.g. "-port=${default_port} -watchdog_url=${watchdog_url}".
// AMS assigns the port DYNAMICALLY, so we must bind whatever -port it gives us
// (not a fixed value). Falls back to env / 8091 for local runs.
const argv = process.argv.slice(2)
const argVal = (name) => {
  const pre = `-${name}=`
  const hit = argv.find((a) => a.startsWith(pre))
  return hit ? hit.slice(pre.length) : undefined
}
// The HTTP /trigger must listen on the fleet's TCP port (named "trigger"), NOT
// the auto-created "default" port (which is UDP and can't be changed). AMS injects
// it as ${trigger_port}; fall back to -port then env for local runs.
const TRIGGER_PORT = Number(argVal('trigger_port') || argVal('port') || process.env.BOT_TRIGGER_PORT) || 8091
const WATCHDOG_URL = argVal('watchdog_url') || process.env.AMS_WATCHDOG_URL || 'ws://localhost:5555/watchdog'
// AMS passes -dsid=<serverId>; the watchdog needs it as the ams-dsid header.
const DSID = argVal('dsid') || process.env.DS_ID || ''
// If claimed but the paired human never connects, don't hang the instance forever.
const HOST_CONNECT_TIMEOUT_MS = 60000
// Safety net: if this instance is never triggered (e.g. it was claimed but the
// trigger POST never arrived — the DS has no other way to learn it was claimed),
// exit after this long so AMS relaunches a fresh, claimable server. Healthy idle
// buffer servers recycle too — harmless minor churn.
const IDLE_MAX_MS = (Number(process.env.BOT_IDLE_MAX_MINUTES) || 60) * 60000
// Optional shared secret: when set, /trigger requires header x-trigger-secret to
// match (the DS port is publicly reachable on AMS). Unset = open (local dev).
const TRIGGER_SECRET = process.env.BOT_TRIGGER_SECRET || ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shortTag = (id) => (id ? id.slice(0, 6) : '?')

let auth = null // { token, userId }
let peer = null
let busy = false // one game per instance
let draining = false

async function ensureLogin() {
  if (auth) return auth
  auth = await login(process.env.BOT_EMAIL, process.env.BOT_PASSWORD)
  log('logged in as bot — userId =', auth.userId)
  return auth
}

// Register the PeerJS peer LAZILY (only when a game actually starts), so a warm
// instance never holds peerId=botUserId — that avoids colliding with a draining
// predecessor that shares the bot account.
async function ensurePeer() {
  if (peer) return peer
  const { loadPeer } = await play()
  const Peer = await loadPeer()
  const peerId = auth.userId.replace(/-/g, '')
  peer = new Peer(peerId, { debug: 1 })
  await new Promise((resolve, reject) => {
    peer.on('open', (id) => { log('peer registered as', id); resolve() })
    peer.on('error', reject)
    setTimeout(() => reject(new Error('peer open timeout')), 15000)
  })
  peer.on('error', (e) => log('peer error:', e?.type || e?.message || e))
  return peer
}

async function main() {
  log('starting — trigger port', TRIGGER_PORT, '| watchdog', WATCHDOG_URL, '| dsid', DSID || '(none)')
  log('argv:', JSON.stringify(argv)) // diagnostic: confirms AMS substituted ${trigger_port}
  // diagnostic: in case AMS exposes ports via env instead of args (non-secret only)
  log('env ports:', Object.entries(process.env).filter(([k]) => /port/i.test(k) && !/PASSWORD|SECRET/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)')
  const wd = new Watchdog(WATCHDOG_URL, DSID)
  wd.onDrain = () => {
    draining = true
    if (!busy) { log('drain while idle — exiting'); shutdown(wd, 0) }
    else log('drain during a game — will finish it, then exit')
  }

  // 1. Trigger endpoint the claimer (Extend watcher) POSTs after claiming us.
  //    Bind it FIRST: AMS marks us claimable once we announce watchdog "ready",
  //    and the claimer POSTs /trigger immediately after — so the port must
  //    already be listening to avoid a connection-refused race.
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/trigger') {
      if (TRIGGER_SECRET && req.headers['x-trigger-secret'] !== TRIGGER_SECRET) {
        res.writeHead(403); res.end('forbidden'); return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      onTrigger(wd)
      return
    }
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return }
    res.writeHead(404); res.end()
  })
  server.on('error', (e) => { console.error('trigger server error:', e?.message || e); process.exit(1) })
  await new Promise((resolve) => server.listen(TRIGGER_PORT, () => { log('trigger server listening on :' + TRIGGER_PORT); resolve() }))

  // 2. Watchdog: announce ready + heartbeat only AFTER the trigger port is up.
  //    On drain, finish any active game then exit (we exit after one game
  //    regardless, so drain just hurries an idle instance out).
  try {
    await wd.connect()
    wd.sendReady()
    wd.startHeartbeat(5000)
    log('registered with watchdog — ready for a claim')
  } catch (e) {
    const why = e?.code || e?.errors?.[0]?.code || e?.message || 'unreachable'
    log('no watchdog (' + why + ') — standalone/dev mode')
  }

  // 3. Probe the native WebRTC addon now (non-fatal) so a host-side load failure
  //    (e.g. glibc mismatch) is visible in the logs while the DS stays registered.
  log('node', process.version, 'platform', process.platform, process.arch)
  try {
    await play()
    log('webrtc: @roamhq/wrtc loaded OK')
  } catch (e) {
    log('webrtc: LOAD FAILED —', e?.message || e)
  }

  // 4. Idle self-recycle (see IDLE_MAX_MS).
  const idleTimer = setTimeout(() => {
    if (!busy) { log('never triggered within', IDLE_MAX_MS / 60000, 'min — recycling'); shutdown(wd, 0) }
  }, IDLE_MAX_MS)
  if (idleTimer.unref) idleTimer.unref()
}

// One claim -> one game -> drain. Guarded so a duplicate trigger is a no-op.
async function onTrigger(wd) {
  if (busy) { log('already playing — ignoring extra trigger'); return }
  busy = true
  let code = 0
  try {
    await ensureLogin()
    await ensurePeer()
    await runOneGame()
  } catch (e) {
    log('game error:', e?.message || e)
    code = 1
  } finally {
    log('game finished — draining this instance')
    shutdown(wd, code)
  }
}

async function runOneGame() {
  const { playGame } = await play()
  log('triggered → queuing one ticket')
  const ticketId = await createMatchTicket(auth.token, POOL)
  const sessionId = await waitForMatch(ticketId)
  if (!sessionId) { log('ticket', shortTag(ticketId), 'expired without a match (spurious claim)'); return }

  const sess = await getGameSession(auth.token, sessionId)
  const members = (sess.members || []).map((m) => m.id).filter(Boolean)
  if (members.length < 2) { log('session has <2 members — nothing to play'); return }

  const hostId = members.slice().sort()[0]
  const botIsHost = hostId === auth.userId
  const tag = shortTag(sessionId)

  if (botIsHost) {
    log(`[${tag}]`, 'matched — bot is HOST, awaiting the opponent’s connection')
    await new Promise((resolve) => {
      const timer = setTimeout(() => { log(`[${tag}]`, 'opponent never connected within 60s'); resolve() }, HOST_CONNECT_TIMEOUT_MS)
      peer.once('connection', (conn) => {
        clearTimeout(timer)
        log(`[${tag}]`, 'opponent connected (bot is HOST)')
        playGame(conn, 'host', { botName: 'Gambit Gus', botId: auth.userId, tag })
          .then((why) => { log(`[${tag}]`, 'host game ended:', why); resolve() })
          .catch((e) => { log(`[${tag}]`, 'host game error:', e?.message || e); resolve() })
      })
    })
    return
  }

  const hostPeerId = hostId.replace(/-/g, '')
  log(`[${tag}]`, 'matched — bot is JOINER, connecting to', shortTag(hostPeerId))
  await sleep(JOINER_CONNECT_DELAY_MS)
  const conn = await connectJoiner(hostPeerId, tag)
  if (!conn) { log(`[${tag}]`, 'could not reach host peer after retries — giving up'); return }
  const why = await playGame(conn, 'joiner', { botName: 'Gambit Gus', botId: auth.userId, tag })
  log(`[${tag}]`, 'joiner game ended:', why)
  try { conn.close() } catch {}
}

// Connect to the host peer with retries. After a ~30s matchmaking wait the host's
// PeerJS registration can land AFTER our first connect attempt → 'peer-unavailable'.
// The web client tries once and gives up; we retry so a briefly-late host still works.
async function connectJoiner(hostPeerId, tag) {
  const ATTEMPTS = 8
  const GAP_MS = 2000
  for (let i = 1; i <= ATTEMPTS; i++) {
    const conn = peer.connect(hostPeerId, { reliable: true })
    const ok = await new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        try { peer.off('error', onPeerErr) } catch {}
        resolve(v)
      }
      const onPeerErr = (e) => { if (String(e?.type || '') === 'peer-unavailable') finish(false) }
      peer.on('error', onPeerErr)
      conn.once('open', () => finish(true))
      conn.once('error', () => finish(false))
      setTimeout(() => finish(false), 8000)
    })
    if (ok) return conn
    try { conn.close() } catch {}
    log(`[${tag}]`, `joiner connect ${i}/${ATTEMPTS}: host peer not ready, retrying in ${GAP_MS}ms`)
    await sleep(GAP_MS)
  }
  return null
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
      log('ticket', shortTag(ticketId), 'no match within 10s — cancelling')
      await deleteMatchTicket(auth.token, ticketId)
      return null
    }
  }
}

function shutdown(wd, code) {
  try { wd?.close() } catch {}
  try { peer?.destroy() } catch {}
  // Give logs/sockets a moment to flush, then exit so AMS recycles this instance.
  setTimeout(() => process.exit(code), 500)
}

main().catch((e) => { console.error('fatal:', e?.message || e); process.exit(1) })

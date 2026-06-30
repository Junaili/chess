// Spike: a Node PeerJS peer that plays the live Ethan's Chess web client.
//
// This proves the make-or-break piece of the cold-start bot: that a Node
// `peerjs` + `wrtc` peer can interoperate with the unmodified web client's P2P
// protocol (the same one in app.js: game_start handshake, move messages,
// ping/pong keepalive) and play a full game — reusing the real chess engine/AI.
//
// TEST (bot as JOINER — easiest):
//   1) Open the web game, click "Invite Friend". The invite link contains the
//      host's peer id (the value after ?join= , or shown in the browser console).
//   2) node bot.mjs --connect <hostPeerId>
//      → the web client is host (White); the bot joins as Black and plays.
//
// TEST (bot as HOST):
//   node bot.mjs --host gambitgus-test
//   → then open the web game with an invite link whose peer id is "gambitgus-test"
//     (i.e. ...?join=gambitgus-test). The bot is White and moves first.

import wrtc from '@roamhq/wrtc'
import { WebSocket } from 'ws'

// PeerJS + wrtc need browser globals in Node.
globalThis.RTCPeerConnection = wrtc.RTCPeerConnection
globalThis.RTCSessionDescription = wrtc.RTCSessionDescription
globalThis.RTCIceCandidate = wrtc.RTCIceCandidate
globalThis.WebSocket = WebSocket
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' }

const peerjs = await import('peerjs') // after globals are set
const Peer = peerjs.Peer || peerjs.default?.Peer || peerjs.default

const { ChessGame, ChessAI } = await import('./engine.mjs')

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const connectTo = flag('--connect')
const hostId = flag('--host')
const THINK_MS = Number(flag('--think')) || 1200
const BOT_NAME = 'Gambit Gus'
const BOT_ID = 'bot-gambit-gus'

const ai = new ChessAI()
let game = null
let botColor = null
let conn = null

const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(ts(), ...a)

function isOver() {
  const s = String(game?.status || '')
  return s === 'checkmate' || s === 'stalemate' || s.startsWith('draw')
}

function maybeBotMove() {
  if (!game || game.currentTurn !== botColor || isOver()) {
    if (isOver()) log('game over:', game.status, game.winner || '')
    return
  }
  setTimeout(() => {
    if (!game || game.currentTurn !== botColor || isOver()) return
    const m = ai.getBestMove(game, 'medium')
    if (!m) { log('no legal move'); return }
    const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, 'queen')
    game.makeMove(m.fr, m.fc, m.toR, m.toC, 'queen')
    try { conn.send({ type: 'move', fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType: 'queen' }) } catch (e) { log('send move failed', e?.message) }
    log('bot played', notation, isOver() ? `(game over: ${game.status})` : '')
  }, THINK_MS)
}

function startHeartbeat(c) {
  let lastPong = Date.now()
  const onData = (d) => { if (d && d.type === 'pong') lastPong = Date.now() }
  c.on('data', onData)
  const iv = setInterval(() => {
    try { c.send({ type: 'ping' }) } catch {}
    if (Date.now() - lastPong > 16000) log('⚠ no pong in 16s — connection may be unhealthy')
  }, 5000)
  c.on('close', () => clearInterval(iv))
}

function wireConn(c, role) {
  conn = c
  c.on('open', () => {
    log('✓ data connection OPEN (role =', role + ')')
    startHeartbeat(c)
    if (role === 'host') {
      botColor = 'white'
      game = new ChessGame()
      c.send({ type: 'game_start', yourColor: 'black', opponentName: BOT_NAME, opponentId: BOT_ID })
      log('sent game_start → human is Black, bot is White')
      maybeBotMove() // White moves first
    } else {
      log('joined host; waiting for game_start…')
    }
  })

  c.on('data', (d) => {
    if (!d || typeof d.type !== 'string') return
    if (d.type === 'ping') { try { c.send({ type: 'pong' }) } catch {}; return }
    if (d.type === 'pong') return

    if (d.type === 'game_start') {
      botColor = d.yourColor === 'white' ? 'white' : 'black'
      game = new ChessGame()
      log('game_start received → bot is', botColor, '| opponent:', d.opponentName || '?')
      try { c.send({ type: 'player_info', name: BOT_NAME, userId: BOT_ID }) } catch {}
      maybeBotMove()
    } else if (d.type === 'player_info') {
      log('opponent identity:', d.name || '?')
    } else if (d.type === 'move') {
      if (!game) return
      const notation = game.getMoveNotation(d.fr, d.fc, d.toR, d.toC, d.promType || 'queen')
      const ok = game.makeMove(d.fr, d.fc, d.toR, d.toC, d.promType || 'queen')
      if (!ok) { log('✗ opponent sent an ILLEGAL move (desync?):', d); return }
      log('opponent played', notation, isOver() ? `[game over: ${game.status}]` : '')
      maybeBotMove()
    } else if (d.type === 'chat') {
      log('chat from opponent:', d.text)
    }
    // rematch / video / resync intentionally ignored for the spike
  })

  c.on('close', () => log('connection closed'))
  c.on('error', (e) => log('conn error:', e?.message || e))
}

const peer = new Peer(hostId || undefined, { debug: 2 })
peer.on('open', (id) => {
  log('peer registered, my id =', id)
  if (connectTo) {
    log('connecting to host peer', connectTo, '…')
    wireConn(peer.connect(connectTo, { reliable: true }), 'joiner')
  } else {
    log('HOSTING as', id, '— open the web client and join this peer id')
  }
})
peer.on('connection', (c) => { log('incoming connection from', c.peer); wireConn(c, 'host') })
peer.on('error', (e) => log('peer error:', e?.type || e?.message || e))
peer.on('disconnected', () => log('peer disconnected from signaling server'))

process.on('SIGINT', () => { log('shutting down'); try { peer.destroy() } catch {}; process.exit(0) })

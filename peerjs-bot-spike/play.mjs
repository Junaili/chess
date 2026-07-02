// The bot's PeerJS gameplay, factored out of the spike so the match loop reuses
// it. Speaks the web client's exact P2P protocol (game_start handshake, move
// messages, ping/pong) and plays with the real chess engine/AI. Each call is one
// independent game (its own connection + ChessGame), so many can run at once.
import wrtc from '@roamhq/wrtc'
import { WebSocket } from 'ws'
import { ChessGame, ChessAI } from './engine.mjs'

let globalsReady = false
export function ensureGlobals() {
  if (globalsReady) return
  globalThis.RTCPeerConnection = wrtc.RTCPeerConnection
  globalThis.RTCSessionDescription = wrtc.RTCSessionDescription
  globalThis.RTCIceCandidate = wrtc.RTCIceCandidate
  globalThis.WebSocket = WebSocket
  if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' }
  globalsReady = true
}

export async function loadPeer() {
  ensureGlobals()
  const peerjs = await import('peerjs')
  return peerjs.Peer || peerjs.default?.Peer || peerjs.default
}

const ai = new ChessAI()
const ts = () => new Date().toISOString().slice(11, 19)
export const log = (...a) => console.log(ts(), ...a)

// Play one game over a PeerJS DataConnection. role: 'host' | 'joiner'.
// Resolves with a reason string when the game ends or the connection closes.
export function playGame(conn, role, opts = {}) {
  const botName = opts.botName || 'Gambit Gus'
  const botId = opts.botId || 'bot'
  const thinkMs = opts.thinkMs ?? 1200
  const difficulty = opts.difficulty || 'medium'
  const tag = opts.tag ? `[${opts.tag}]` : ''
  const glog = (...a) => log(tag, ...a)

  let game = null
  let botColor = null
  let done = false

  return new Promise((resolve) => {
    const finish = (why) => { if (!done) { done = true; cleanup(); resolve(why) } }
    const isOver = () => {
      const s = String(game?.status || '')
      return s === 'checkmate' || s === 'stalemate' || s.startsWith('draw')
    }

    // Never wedge forever (an ephemeral AMS DS must eventually drain): the game
    // must start promptly, and a game with no peer data for a long stretch is
    // considered abandoned.
    const startTimeoutMs = opts.startTimeoutMs ?? 45000
    const idleTimeoutMs = opts.idleTimeoutMs ?? 300000
    let lastData = Date.now()
    const startTimer = setTimeout(() => {
      if (!game) { glog('✗ no game_start within', startTimeoutMs / 1000, 's — abandoning'); finish('no_game_start') }
    }, startTimeoutMs)
    const idleTimer = setInterval(() => {
      if (Date.now() - lastData > idleTimeoutMs) { glog('✗ no peer data for', idleTimeoutMs / 1000, 's — abandoning'); finish('idle_timeout') }
    }, 15000)
    const cleanup = () => { clearTimeout(startTimer); clearInterval(idleTimer) }
    const maybeBotMove = () => {
      if (!game || game.currentTurn !== botColor) return
      if (isOver()) { glog('game over:', game.status, game.winner || ''); return finish('over') }
      setTimeout(() => {
        if (done || !game || game.currentTurn !== botColor || isOver()) return
        const m = ai.getBestMove(game, difficulty)
        if (!m) return
        const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, 'queen')
        game.makeMove(m.fr, m.fc, m.toR, m.toC, 'queen')
        try { conn.send({ type: 'move', fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType: 'queen' }) } catch {}
        glog('bot played', notation, isOver() ? `[game over: ${game.status}]` : '')
        if (isOver()) finish('over')
      }, thinkMs)
    }

    let lastPong = Date.now()
    const startHeartbeat = () => {
      const iv = setInterval(() => {
        try { conn.send({ type: 'ping' }) } catch {}
        if (Date.now() - lastPong > 16000) glog('⚠ no pong in 16s')
      }, 5000)
      conn.on('close', () => clearInterval(iv))
    }

    conn.on('open', () => {
      glog('✓ data connection OPEN (role =', role + ')')
      startHeartbeat()
      if (role === 'host') {
        botColor = 'white'
        game = new ChessGame()
        try { conn.send({ type: 'game_start', yourColor: 'black', opponentName: botName, opponentId: botId }) } catch {}
        maybeBotMove() // White moves first
      } else {
        glog('joined; waiting for game_start…')
      }
    })

    conn.on('data', (d) => {
      if (!d || typeof d.type !== 'string') return
      lastData = Date.now()
      if (d.type === 'ping') { try { conn.send({ type: 'pong' }) } catch {}; return }
      if (d.type === 'pong') { lastPong = Date.now(); return }
      if (d.type === 'game_start') {
        botColor = d.yourColor === 'white' ? 'white' : 'black'
        game = new ChessGame()
        glog('game_start → bot is', botColor, '| opponent:', d.opponentName || '?')
        try { conn.send({ type: 'player_info', name: botName, userId: botId }) } catch {}
        maybeBotMove()
      } else if (d.type === 'player_info') {
        glog('opponent identity:', d.name || '?')
      } else if (d.type === 'move') {
        if (!game) return
        const notation = game.getMoveNotation(d.fr, d.fc, d.toR, d.toC, d.promType || 'queen')
        if (!game.makeMove(d.fr, d.fc, d.toR, d.toC, d.promType || 'queen')) {
          glog('✗ opponent sent an illegal move (desync?):', d); return
        }
        glog('opponent played', notation, isOver() ? `[game over: ${game.status}]` : '')
        maybeBotMove()
      }
      // rematch / resync / video intentionally ignored for now
    })

    conn.on('close', () => { glog('connection closed'); finish('closed') })
    conn.on('error', (e) => { glog('conn error:', e?.message || e); finish('error') })
  })
}

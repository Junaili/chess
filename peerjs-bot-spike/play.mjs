// The bot's PeerJS gameplay, factored out of the spike so the match loop reuses
// it. Speaks the web client's exact P2P protocol (game_start handshake, move
// messages, ping/pong) and plays with the real chess engine/AI.
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

  let game = null
  let botColor = null
  let done = false

  return new Promise((resolve) => {
    const finish = (why) => { if (!done) { done = true; resolve(why) } }
    const isOver = () => {
      const s = String(game?.status || '')
      return s === 'checkmate' || s === 'stalemate' || s.startsWith('draw')
    }
    const maybeBotMove = () => {
      if (!game || game.currentTurn !== botColor) return
      if (isOver()) { log('game over:', game.status, game.winner || ''); return finish('over') }
      setTimeout(() => {
        if (done || !game || game.currentTurn !== botColor || isOver()) return
        const m = ai.getBestMove(game, difficulty)
        if (!m) return
        const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, 'queen')
        game.makeMove(m.fr, m.fc, m.toR, m.toC, 'queen')
        try { conn.send({ type: 'move', fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType: 'queen' }) } catch {}
        log('bot played', notation, isOver() ? `[game over: ${game.status}]` : '')
        if (isOver()) finish('over')
      }, thinkMs)
    }

    let lastPong = Date.now()
    const startHeartbeat = () => {
      const iv = setInterval(() => {
        try { conn.send({ type: 'ping' }) } catch {}
        if (Date.now() - lastPong > 16000) log('⚠ no pong in 16s')
      }, 5000)
      conn.on('close', () => clearInterval(iv))
    }

    conn.on('open', () => {
      log('✓ data connection OPEN (role =', role + ')')
      startHeartbeat()
      if (role === 'host') {
        botColor = 'white'
        game = new ChessGame()
        try { conn.send({ type: 'game_start', yourColor: 'black', opponentName: botName, opponentId: botId }) } catch {}
        maybeBotMove() // White moves first
      } else {
        log('joined; waiting for game_start…')
      }
    })

    conn.on('data', (d) => {
      if (!d || typeof d.type !== 'string') return
      if (d.type === 'ping') { try { conn.send({ type: 'pong' }) } catch {}; return }
      if (d.type === 'pong') { lastPong = Date.now(); return }
      if (d.type === 'game_start') {
        botColor = d.yourColor === 'white' ? 'white' : 'black'
        game = new ChessGame()
        log('game_start → bot is', botColor, '| opponent:', d.opponentName || '?')
        try { conn.send({ type: 'player_info', name: botName, userId: botId }) } catch {}
        maybeBotMove()
      } else if (d.type === 'player_info') {
        log('opponent identity:', d.name || '?')
      } else if (d.type === 'move') {
        if (!game) return
        const notation = game.getMoveNotation(d.fr, d.fc, d.toR, d.toC, d.promType || 'queen')
        if (!game.makeMove(d.fr, d.fc, d.toR, d.toC, d.promType || 'queen')) {
          log('✗ opponent sent an illegal move (desync?):', d); return
        }
        log('opponent played', notation, isOver() ? `[game over: ${game.status}]` : '')
        maybeBotMove()
      }
      // rematch / resync / video intentionally ignored for now
    })

    conn.on('close', () => { log('connection closed'); finish('closed') })
    conn.on('error', (e) => { log('conn error:', e?.message || e); finish('error') })
  })
}

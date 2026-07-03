// The bot's PeerJS gameplay, factored out of the spike so the match loop reuses
// it. Speaks the web client's exact P2P protocol (game_start handshake, move
// messages, ping/pong) and plays with the real chess engine/AI. Each call is one
// independent game (its own connection + ChessGame), so many can run at once.
import { randomUUID } from 'node:crypto'
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

  // Human-ness: per-move think time sampled around the learned mean (from the
  // brain's play tuning) instead of a fixed delay. Falls back to thinkMs.
  const sampleThink = () => {
    if (opts.thinkMsMean) {
      const jitter = opts.thinkMsJitter ?? Math.floor(opts.thinkMsMean / 2)
      const v = opts.thinkMsMean + Math.round((Math.random() * 2 - 1) * jitter)
      return Math.max(350, Math.min(6000, v))
    }
    return thinkMs
  }

  let game = null
  let botColor = null
  let done = false

  // Game record for the self-learning pipeline — same MatchEntry shape the web
  // client stores (src/stats.js), so the trainer consumes it unchanged. Handed
  // to opts.onRecord(record) when the game finishes; games that never really
  // started (no moves) are not reported.
  const rec = {
    id: randomUUID(),
    mode: 'online',
    opponentUserId: '',
    opponentName: '',
    result: 'abandoned',
    startedAt: '',
    endedAt: '',
    durationMs: 0,
    whiteName: '',
    blackName: '',
    moves: [],
  }
  const finishRecord = () => {
    if (typeof opts.onRecord !== 'function' || rec.moves.length === 0 || !game) return
    rec.endedAt = new Date().toISOString()
    rec.durationMs = rec.startedAt ? Date.now() - Date.parse(rec.startedAt) : 0
    const s = String(game.status || '')
    if (s === 'checkmate') rec.result = game.winner === botColor ? 'win' : 'loss'
    else if (s === 'stalemate' || s.startsWith('draw')) rec.result = 'draw'
    rec.whiteName = botColor === 'white' ? botName : rec.opponentName || 'Opponent'
    rec.blackName = botColor === 'black' ? botName : rec.opponentName || 'Opponent'
    try { opts.onRecord({ ...rec, botColor }) } catch (e) { glog('onRecord error:', e?.message || e) }
  }

  return new Promise((resolve) => {
    const finish = (why) => { if (!done) { done = true; cleanup(); finishRecord(); resolve(why) } }
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
    // Opening book (learned from the bot's own wins): while the game still
    // matches a book line's move prefix, play the line's next move.
    const bookMove = () => {
      const book = opts.book
      if (!Array.isArray(book) || book.length === 0 || rec.moves.length >= 12) return null
      const played = rec.moves
      const sorted = [...book].sort((a, b) => (b.weight || 0) - (a.weight || 0))
      for (const line of sorted) {
        const mv = line.moves
        if (!Array.isArray(mv) || mv.length <= played.length) continue
        let match = true
        for (let i = 0; i < played.length; i++) {
          const a = played[i], b = mv[i]
          if (a.fr !== b.fr || a.fc !== b.fc || a.toR !== b.toR || a.toC !== b.toC) { match = false; break }
        }
        if (match) {
          const n = mv[played.length]
          return { fr: n.fr, fc: n.fc, toR: n.toR, toC: n.toC, promType: n.promType || 'queen' }
        }
      }
      return null
    }

    const playMove = (m, promType, label) => {
      const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, promType)
      if (!game.makeMove(m.fr, m.fc, m.toR, m.toC, promType)) return false
      rec.moves.push({ fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType })
      try { conn.send({ type: 'move', fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType }) } catch {}
      glog('bot played' + label, notation, isOver() ? `[game over: ${game.status}]` : '')
      return true
    }

    const maybeBotMove = () => {
      if (!game || game.currentTurn !== botColor) return
      if (isOver()) { glog('game over:', game.status, game.winner || ''); return finish('over') }
      setTimeout(() => {
        if (done || !game || game.currentTurn !== botColor || isOver()) return
        const bm = bookMove()
        let moved = bm ? playMove(bm, bm.promType, ' (book)') : false
        if (!moved) {
          const m = ai.getBestMove(game, difficulty)
          if (!m) return
          moved = playMove(m, 'queen', '')
        }
        if (moved && isOver()) finish('over')
      }, sampleThink())
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
        rec.startedAt = new Date().toISOString()
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
        rec.startedAt = rec.startedAt || new Date().toISOString()
        if (d.opponentName) rec.opponentName = String(d.opponentName).slice(0, 40)
        if (d.opponentId) rec.opponentUserId = String(d.opponentId).slice(0, 64)
        glog('game_start → bot is', botColor, '| opponent:', d.opponentName || '?')
        try { conn.send({ type: 'player_info', name: botName, userId: botId }) } catch {}
        maybeBotMove()
      } else if (d.type === 'player_info') {
        if (d.name) rec.opponentName = String(d.name).slice(0, 40)
        if (d.userId) rec.opponentUserId = String(d.userId).slice(0, 64)
        glog('opponent identity:', d.name || '?')
      } else if (d.type === 'move') {
        if (!game) return
        const notation = game.getMoveNotation(d.fr, d.fc, d.toR, d.toC, d.promType || 'queen')
        if (!game.makeMove(d.fr, d.fc, d.toR, d.toC, d.promType || 'queen')) {
          glog('✗ opponent sent an illegal move (desync?):', d); return
        }
        rec.moves.push({ fr: d.fr, fc: d.fc, toR: d.toR, toC: d.toC, promType: d.promType || 'queen' })
        glog('opponent played', notation, isOver() ? `[game over: ${game.status}]` : '')
        maybeBotMove()
      }
      // rematch / resync / video intentionally ignored for now
    })

    conn.on('close', () => { glog('connection closed'); finish('closed') })
    conn.on('error', (e) => { glog('conn error:', e?.message || e); finish('error') })
  })
}

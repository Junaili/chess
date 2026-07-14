import { parentPort } from 'node:worker_threads'
import { ChessGame, ChessAI } from './engine.mjs'

const ai = new ChessAI()

parentPort.postMessage({ ready: true })

function restoreGame(state) {
  const game = new ChessGame()
  game.board = state.board.map(row => row.map(piece => piece ? { ...piece } : null))
  game.currentTurn = state.currentTurn
  game.enPassantTarget = state.enPassantTarget ? { ...state.enPassantTarget } : null
  game.castlingRights = structuredClone(state.castlingRights)
  game.capturedByWhite = [...(state.capturedByWhite || [])]
  game.capturedByBlack = [...(state.capturedByBlack || [])]
  game.status = state.status
  game.winner = state.winner
  game.halfmoveClock = state.halfmoveClock || 0
  game.positionCounts = new Map(state.positionCounts || [])
  game.moveHistory = []
  return game
}

parentPort.on('message', ({ id, state, difficulty, options }) => {
  try {
    const move = ai.getBestMove(restoreGame(state), difficulty, options)
    parentPort.postMessage({ id, move, search: ai.lastSearch || null })
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message || String(error) })
  }
})

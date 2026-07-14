import { Worker } from 'node:worker_threads'

const DEFAULT_QUEUE_LIMIT = 16

function snapshotGame(game) {
  return {
    board: game.cloneBoard(),
    currentTurn: game.currentTurn,
    enPassantTarget: game.enPassantTarget ? { ...game.enPassantTarget } : null,
    castlingRights: structuredClone(game.castlingRights),
    capturedByWhite: [...game.capturedByWhite],
    capturedByBlack: [...game.capturedByBlack],
    status: game.status,
    winner: game.winner,
    halfmoveClock: game.halfmoveClock,
    positionCounts: [...game.positionCounts.entries()],
  }
}

// One bounded worker is enough for the current one-game DS and is also safe for
// the multi-session prototype: searches queue instead of multiplying CPU until
// PeerJS heartbeats starve. A timed-out worker is terminated and replaced.
export class AISearchPool {
  constructor({ queueLimit = Number(process.env.BOT_AI_QUEUE_LIMIT) || DEFAULT_QUEUE_LIMIT } = {}) {
    this.queueLimit = Math.max(1, Math.min(64, Number(queueLimit) || DEFAULT_QUEUE_LIMIT))
    this.queue = []
    this.current = null
    this.seq = 0
    this.worker = null
    this.workerReady = false
    this.closing = false
  }

  search(game, difficulty, options = {}) {
    if (this.closing) return Promise.reject(new Error('AI search pool is closed'))
    if (this.queue.length + (this.current ? 1 : 0) >= this.queueLimit) {
      return Promise.reject(new Error('AI search queue is full'))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.seq, state: snapshotGame(game), difficulty, options, resolve, reject })
      this._pump()
    })
  }

  async close() {
    this.closing = true
    const error = new Error('AI search pool closed')
    for (const task of this.queue.splice(0)) task.reject(error)
    if (this.current) {
      clearTimeout(this.current.timer)
      this.current.reject(error)
    }
    this.current = null
    if (this.worker) await this.worker.terminate().catch(() => {})
    this.worker = null
    this.workerReady = false
  }

  _ensureWorker() {
    if (this.worker) return
    const worker = new Worker(new URL('./ai-worker.mjs', import.meta.url))
    this.workerReady = false
    worker.unref()
    worker.on('message', message => this._onMessage(worker, message))
    worker.on('error', error => this._replaceWorker(worker, error))
    worker.on('exit', code => {
      if (!this.closing) this._replaceWorker(worker, new Error(`AI worker exited ${code}`))
    })
    this.worker = worker
  }

  _pump() {
    if (this.current || this.queue.length === 0 || this.closing) return
    this._ensureWorker()
    const task = this.queue.shift()
    this.current = task
    this._dispatchCurrent()
  }

  _dispatchCurrent() {
    const task = this.current
    if (!task || task.dispatched || !this.workerReady || !this.worker) return
    task.dispatched = true
    const budget = Math.max(25, Math.min(1000, Number(task.options.timeBudgetMs) || 220))
    task.timer = setTimeout(() => {
      if (this.current?.id !== task.id) return
      task.reject(new Error(`AI search exceeded ${budget}ms budget`))
      this.current = null
      const old = this.worker
      this.worker = null
      this.workerReady = false
      Promise.resolve(old?.terminate()).catch(() => {}).finally(() => this._pump())
    }, budget + 100)
    this.worker.postMessage({ id: task.id, state: task.state, difficulty: task.difficulty, options: task.options })
  }

  _onMessage(worker, message) {
    if (worker !== this.worker) return
    if (message?.ready) {
      this.workerReady = true
      this._dispatchCurrent()
      return
    }
    if (!this.current || message.id !== this.current.id) return
    const task = this.current
    this.current = null
    clearTimeout(task.timer)
    if (message.error) task.reject(new Error(message.error))
    else task.resolve({ move: message.move, search: message.search })
    this._pump()
  }

  _replaceWorker(worker, error) {
    if (worker !== this.worker) return
    this.worker = null
    this.workerReady = false
    if (this.current) {
      clearTimeout(this.current.timer)
      this.current.reject(error)
      this.current = null
    }
    this._pump()
  }
}

export const aiSearchPool = new AISearchPool()

export function serializeGameForWorker(source) {
  return {
    board: source.cloneBoard(),
    currentTurn: source.currentTurn,
    enPassantTarget: source.enPassantTarget ? { ...source.enPassantTarget } : null,
    castlingRights: JSON.parse(JSON.stringify(source.castlingRights)),
    moveHistory: [],
    capturedByWhite: source.capturedByWhite.map(piece => ({ ...piece })),
    capturedByBlack: source.capturedByBlack.map(piece => ({ ...piece })),
    status: source.status,
    winner: source.winner,
    halfmoveClock: source.halfmoveClock,
    positionCounts: [...source.positionCounts.entries()],
  }
}

export function createChessWorkerClient() {
  let worker = null
  let nextId = 0
  const pending = new Map()

  function ensureWorker() {
    if (worker || typeof Worker === 'undefined') return worker
    worker = new Worker(new URL('analysis-worker.js', document.baseURI).href, {
      type: 'module',
      name: 'chess-analysis',
    })
    worker.addEventListener('message', event => {
      const request = pending.get(event.data?.id)
      if (!request) return
      pending.delete(event.data.id)
      if (event.data.error) request.reject(new Error(event.data.error))
      else request.resolve(event.data.result)
    })
    worker.addEventListener('error', error => {
      for (const request of pending.values()) request.reject(error)
      pending.clear()
      worker?.terminate()
      worker = null
    })
    return worker
  }

  function request(type, payload) {
    const activeWorker = ensureWorker()
    if (!activeWorker) return Promise.reject(new Error('Web Workers are unavailable'))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        activeWorker.postMessage({ id, type, payload })
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
  }

  return {
    bestMove: (source, difficulty, options = {}) => request('best-move', {
      position: serializeGameForWorker(source), difficulty, options,
    }),
    gradePosition: (source, move, names = {}, options = {}) => request('grade-position', {
      position: serializeGameForWorker(source), move, names, options,
    }),
    analyzeMatch: (match, options = {}) => request('analyze-match', {
      moves: match.moves || [],
      names: { whiteName: match.whiteName, blackName: match.blackName },
      playerColor: match.myColor,
      scope: options.scope || 'all',
      options,
    }),
    terminate() {
      worker?.terminate()
      worker = null
      for (const request of pending.values()) request.reject(new Error('Chess worker terminated'))
      pending.clear()
    },
  }
}

export function prefetchAnalysisWorker() {
  if (document.querySelector('link[data-analysis-worker-prefetch]')) return
  const link = document.createElement('link')
  link.rel = 'prefetch'
  link.as = 'script'
  link.href = new URL('analysis-worker.js', document.baseURI).href
  link.dataset.analysisWorkerPrefetch = '1'
  document.head.appendChild(link)
}

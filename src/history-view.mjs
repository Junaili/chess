// Pure view-model helpers for the Match History list (dev-plan §9.1). No DOM,
// no network, no CloudSave — src/main.js owns rendering, fetching, and paging
// state. Only derives from fields already on the public chess-match-history
// record (dev-plan §2.2); never assumes a field added after this milestone.

import { toAlgebraic } from './match-stats.mjs'

export const HISTORY_PAGE_SIZE = 5

// Mirrors the table already duplicated in src/main.js (renderChessStats) and
// src/journal-data.mjs (openingSignal) — first-move-only, not full ECO
// classification (dev-plan §9.1: "Do not add full ECO classification").
const OPENING_NAMES = {
  e2e4: '1. e4', d2d4: '1. d4', g1f3: '1. Nf3', c2c4: '1. c4',
  b2b3: '1. b3', g2g3: '1. g3', f2f4: '1. f4', b1c3: '1. Nc3',
}

const END_REASON_LABELS = {
  checkmate: 'Checkmate',
  resignation: 'Resigned',
  forfeit: 'Forfeit',
  stalemate: 'Stalemate',
  'draw-insufficient': 'Draw · insufficient material',
  'draw-fifty-move': 'Draw · 50-move rule',
  'draw-repetition': 'Draw · repetition',
}

// firstMoveLabel: the RECORDING PLAYER's first move, not White's — a Black
// game's opening line is their first reply, not White's opening move
// (dev-plan §9.5: "first-move labeling uses the recording player's color").
export function firstMoveLabel(match) {
  if (!Array.isArray(match?.moves) || !match.moves.length) return ''
  if (match.myColor !== 'white' && match.myColor !== 'black') return ''
  const move = match.moves[match.myColor === 'white' ? 0 : 1]
  if (!move) return ''
  const key = `${toAlgebraic(move.fr, move.fc)}${toAlgebraic(move.toR, move.toC)}`
  return OPENING_NAMES[key] || ''
}

// formatHistoryDuration: zero/invalid durations are omitted rather than
// rendered as a misleading "0:00" (dev-plan §6.1 legacy fallback rules).
export function formatHistoryDuration(durationMs) {
  const ms = Number(durationMs)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// historyRowView: pure per-match presentation model (dev-plan §9.1). `now` is
// accepted for future recency-based labels but unused today.
export function historyRowView(match, now = Date.now()) {
  const hasMoves = Array.isArray(match?.moves) && match.moves.length > 0
  // Replay/review needs a stable identifier for the by-ID lookup (§9.3) — a
  // match without one degrades to a non-interactive row rather than risking
  // a collision with another id-less row.
  const canReplay = hasMoves && !!match?.id

  const ended = new Date(match?.endedAt)
  const dateLabel = Number.isNaN(ended.getTime())
    ? 'Unknown time'
    : ended.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  const rawResult = (match?.result || 'completed').toLowerCase()
  const resultClass = ['win', 'loss', 'draw'].includes(rawResult) ? rawResult : 'completed'
  const resultLabel = rawResult[0].toUpperCase() + rawResult.slice(1)

  const modeLabel = match?.mode === 'computer' ? 'Computer' : match?.mode === 'online' ? 'Online' : 'Match'
  const colorLabel = match?.myColor === 'white' ? 'White' : match?.myColor === 'black' ? 'Black' : ''

  const plyCount = Array.isArray(match?.moves) ? match.moves.length : 0
  const moveCount = Math.ceil(plyCount / 2)
  const moveCountLabel = plyCount > 0 ? `${moveCount} move${moveCount === 1 ? '' : 's'}` : ''

  return {
    id: match?.id || '',
    resultLabel,
    resultClass,
    opponent: match?.opponentName || 'Opponent',
    modeLabel,
    dateLabel,
    durationLabel: formatHistoryDuration(match?.durationMs),
    colorLabel,
    moveCountLabel,
    endReasonLabel: END_REASON_LABELS[match?.endReason] || '',
    openingLabel: firstMoveLabel(match),
    canReplay,
  }
}

const RESULT_VALUES = new Set(['win', 'loss', 'draw'])

// filterHistory: client-only composition of result + color + mode. Any
// filter left at 'all' (the default) is a no-op.
export function filterHistory(matches, filters = {}) {
  const { result = 'all', color = 'all', mode = 'all' } = filters || {}
  return (matches || []).filter(match => {
    if (result !== 'all') {
      const rawResult = (match?.result || '').toLowerCase()
      if (rawResult !== result) return false
    }
    if (color !== 'all' && match?.myColor !== color) return false
    if (mode !== 'all' && match?.mode !== mode) return false
    return true
  })
}

// historyFilterCounts: counts for the result chips' badges. Computed over the
// UNFILTERED list so switching chips shows how many matches each one holds.
export function historyFilterCounts(matches) {
  const list = matches || []
  const counts = { all: list.length, win: 0, loss: 0, draw: 0 }
  for (const match of list) {
    const rawResult = (match?.result || '').toLowerCase()
    if (RESULT_VALUES.has(rawResult)) counts[rawResult]++
  }
  return counts
}

// pageHistory: returns one stable page and clamps stale page requests after a
// filter or viewport change. Pages never overlap, so replay IDs remain stable.
export function pageHistory(matches, requestedPage = 1, pageSize = HISTORY_PAGE_SIZE) {
  const list = matches || []
  const size = Number.isFinite(pageSize) && pageSize > 0
    ? Math.floor(pageSize)
    : HISTORY_PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(list.length / size))
  const normalizedPage = Number.isFinite(requestedPage)
    ? Math.floor(requestedPage)
    : 1
  const page = Math.min(Math.max(normalizedPage, 1), pageCount)
  const startIndex = (page - 1) * size
  const endIndex = Math.min(startIndex + size, list.length)

  return {
    visible: list.slice(startIndex, endIndex),
    page,
    pageCount,
    pageSize: size,
    startIndex,
    endIndex,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
    totalCount: list.length,
  }
}

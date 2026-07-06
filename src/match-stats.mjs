// Derived chess stats computed from the match-history CloudSave record
// (src/stats.js: chess-match-history) — pure functions, no AGS calls. Several
// of these only work for matches recorded after myColor/endReason/captured
// pieces were added to the history entry; older matches are still counted
// wherever the field they need isn't required.

const PIECE_VALUES = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 }

function materialValue(capturedTypes) {
  return (capturedTypes || []).reduce((sum, type) => sum + (PIECE_VALUES[type] || 0), 0)
}

export function toAlgebraic(row, col) {
  return 'abcdefgh'[col] + (8 - row)
}

function isCastleMove(move, color) {
  const homeRow = color === 'white' ? 7 : 0
  return move.fr === homeRow && move.fc === 4 && move.toR === homeRow && Math.abs(move.toC - 4) === 2
}

const RATING_K_FACTOR = 32

// Standard Elo update, K=32 (casual-game constant — no separate provisional
// period since this app has no concept of "placement matches").
export function computeEloUpdate(myRating, opponentRating, score) {
  const expected = 1 / (1 + 10 ** ((opponentRating - myRating) / 400))
  return Math.round(myRating + RATING_K_FACTOR * (score - expected))
}

function emptyRecord() {
  return { wins: 0, losses: 0, draws: 0, games: 0 }
}

function tally(record, result) {
  record.games++
  if (result === 'win') record.wins++
  else if (result === 'loss') record.losses++
  else if (result === 'draw') record.draws++
}

function winRate(record) {
  if (!record.games) return null
  return (record.wins + record.draws * 0.5) / record.games
}

export function computeMatchStats(matches) {
  const list = Array.isArray(matches) ? matches : []

  const byColor = { white: emptyRecord(), black: emptyRecord() }
  const byOpponentType = { vsBot: emptyRecord(), vsHuman: emptyRecord() }
  const headToHeadMap = new Map() // opponentUserId -> { name, ...record }
  const openingCounts = new Map() // "e2e4" -> { count, record }
  const endReasonCounts = { checkmate: 0, resignation: 0, stalemate: 0, 'draw-insufficient': 0, 'draw-fifty-move': 0, 'draw-repetition': 0, unknown: 0 }
  const castling = { kingside: 0, queenside: 0, never: 0, total: 0 }

  let totalDurationMs = 0
  let durationSampleCount = 0
  let longest = null // { durationMs, id }
  let shortest = null
  let fastestCheckmateMoves = null
  let mostMoves = null
  let comebackWins = 0

  for (const match of list) {
    const moveCount = Array.isArray(match.moves) ? match.moves.length : 0
    const durationMs = Number(match.durationMs) || 0

    // Time played
    if (durationMs > 0) {
      totalDurationMs += durationMs
      durationSampleCount++
      if (!longest || durationMs > longest.durationMs) longest = { durationMs, id: match.id }
      if (!shortest || durationMs < shortest.durationMs) shortest = { durationMs, id: match.id }
    }
    if (mostMoves === null || moveCount > mostMoves) mostMoves = moveCount
    if (match.result === 'win' && match.endReason === 'checkmate') {
      if (fastestCheckmateMoves === null || moveCount < fastestCheckmateMoves) fastestCheckmateMoves = moveCount
    }

    // End-reason breakdown (only matches recorded with the field populated)
    if (match.endReason) {
      endReasonCounts[match.endReason] = (endReasonCounts[match.endReason] || 0) + 1
    } else {
      endReasonCounts.unknown++
    }

    // vs bot / vs human
    if (match.mode === 'computer') tally(byOpponentType.vsBot, match.result)
    else if (match.mode === 'online') tally(byOpponentType.vsHuman, match.result)

    // Head-to-head (online matches with a real opponent id only)
    if (match.mode === 'online' && match.opponentUserId) {
      let entry = headToHeadMap.get(match.opponentUserId)
      if (!entry) {
        entry = { opponentUserId: match.opponentUserId, name: match.opponentName || 'Opponent', ...emptyRecord() }
        headToHeadMap.set(match.opponentUserId, entry)
      }
      entry.name = match.opponentName || entry.name
      tally(entry, match.result)
    }

    // Fields below require knowing which color the recording player played —
    // absent on matches recorded before this field existed.
    if (match.myColor !== 'white' && match.myColor !== 'black') continue

    tally(byColor[match.myColor], match.result)

    if (moveCount > 0) {
      const myFirstMoveIndex = match.myColor === 'white' ? 0 : 1
      const myFirstMove = match.moves[myFirstMoveIndex]
      if (myFirstMove) {
        const key = `${toAlgebraic(myFirstMove.fr, myFirstMove.fc)}${toAlgebraic(myFirstMove.toR, myFirstMove.toC)}`
        let opening = openingCounts.get(key)
        if (!opening) {
          opening = { key, count: 0, ...emptyRecord() }
          openingCounts.set(key, opening)
        }
        opening.count++
        tally(opening, match.result)
      }

      const myMoves = match.moves.filter((_, i) => i % 2 === (match.myColor === 'white' ? 0 : 1))
      const castled = myMoves.some(m => isCastleMove(m, match.myColor))
      if (castled) {
        const kingside = myMoves.some(m => isCastleMove(m, match.myColor) && m.toC === 6)
        castling[kingside ? 'kingside' : 'queenside']++
      } else {
        castling.never++
      }
      castling.total++
    }

    // Comeback win: won while having captured less material than the opponent
    if (match.result === 'win' && Array.isArray(match.capturedByWhite) && Array.isArray(match.capturedByBlack)) {
      const myCaptures = materialValue(match.myColor === 'white' ? match.capturedByWhite : match.capturedByBlack)
      const opponentCaptures = materialValue(match.myColor === 'white' ? match.capturedByBlack : match.capturedByWhite)
      if (myCaptures < opponentCaptures) comebackWins++
    }
  }

  const headToHead = [...headToHeadMap.values()].sort((a, b) => b.games - a.games)
  const nemesis = headToHead
    .filter(entry => entry.games >= 3)
    .reduce((worst, entry) => {
      const rate = winRate(entry)
      return !worst || rate < worst.rate ? { ...entry, rate } : worst
    }, null)

  const favoriteOpening = [...openingCounts.values()].sort((a, b) => b.count - a.count)[0] || null

  return {
    totalGames: list.length,
    winRateByColor: {
      white: { ...byColor.white, rate: winRate(byColor.white) },
      black: { ...byColor.black, rate: winRate(byColor.black) },
    },
    winRateByOpponentType: {
      vsBot: { ...byOpponentType.vsBot, rate: winRate(byOpponentType.vsBot) },
      vsHuman: { ...byOpponentType.vsHuman, rate: winRate(byOpponentType.vsHuman) },
    },
    headToHead,
    nemesis,
    favoriteOpening: favoriteOpening && { ...favoriteOpening, rate: winRate(favoriteOpening) },
    timePlayed: {
      totalMs: totalDurationMs,
      avgMs: durationSampleCount ? Math.round(totalDurationMs / durationSampleCount) : 0,
      longest,
      shortest,
    },
    fastestCheckmateMoves,
    mostMovesInAGame: mostMoves,
    castlingRate: {
      ...castling,
      kingsidePct: castling.total ? castling.kingside / castling.total : null,
      queensidePct: castling.total ? castling.queenside / castling.total : null,
      neverPct: castling.total ? castling.never / castling.total : null,
    },
    endReasonCounts,
    comebackWins,
  }
}

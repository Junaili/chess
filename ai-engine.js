'use strict';

import { ChessGame } from './chess-engine.js';

// How far a quiescence search may chase captures past a leaf. Deep enough to
// resolve an ordinary exchange on one square, bounded so a busy middlegame
// cannot explode the node count.
const quiesceMaxPlies = 4;

// Knight offsets for Static Exchange Evaluation's own attack geometry (kept
// separate from the move generator: SEE needs "does this piece attack this
// square" independent of whose turn it is or whether the square is currently
// occupied by the right color, which chess-engine.js's move generator does
// not expose as a standalone query).
const seeKnightOffsets = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

// Ceiling on a caller's requested think time. The bot now searches inside its
// human-like move delay (seconds), where the old 1s ceiling silently truncated
// the search it was being given time for.
const maxSearchBudgetMs = 5000;

// Strength ladder. The old three names gave daily training nowhere to go: both
// bots reached "hard" and the dial had no rung left, so an improvement could
// only ever be given back. Levels are the dial the trainer moves; the names
// remain as aliases so every existing caller keeps its exact behaviour.
//
// randomChance reproduces the old "easy plays a random move 40% of the time".
// budgetCapMs bounds what a level is designed to use; the caller still supplies
// the actual think time and the smaller of the two wins.
const strengthLevels = [
  null, // levels are 1-based
  { depth: 1, quiescence: false, budgetCapMs: 200, randomChance: 0.4 },
  { depth: 1, quiescence: false, budgetCapMs: 400, randomChance: 0.2 },
  { depth: 2, quiescence: false, budgetCapMs: 600, randomChance: 0 },
  { depth: 2, quiescence: false, budgetCapMs: 1200, randomChance: 0 },
  { depth: 2, quiescence: true, budgetCapMs: 1800, randomChance: 0 },
  { depth: 3, quiescence: true, budgetCapMs: 2400, randomChance: 0 },
  { depth: 4, quiescence: true, budgetCapMs: 4000, randomChance: 0 },
  { depth: 4, quiescence: true, budgetCapMs: 6000, randomChance: 0 },
  // Depth 5 costs ~16s with today's move ordering, so 9 and 10 are headroom for
  // after the search work rather than levels to promote into now.
  { depth: 5, quiescence: true, budgetCapMs: 9000, randomChance: 0 },
  { depth: 5, quiescence: true, budgetCapMs: 12000, randomChance: 0 },
];

const maxStrengthLevel = strengthLevels.length - 1;

// The three historical names keep their exact old behaviour rather than
// pointing at ladder rungs. Mapping `hard` onto a rung would have handed the
// browser opponent quiescence — a strength change to the game Ethan practises
// against, smuggled in by a refactor. The AMS bots pass quiescence explicitly,
// so they are unaffected by this staying off here.
const legacyDifficulties = {
  easy: { depth: 1, quiescence: false, budgetCapMs: maxSearchBudgetMs, randomChance: 0.4 },
  medium: { depth: 2, quiescence: false, budgetCapMs: maxSearchBudgetMs, randomChance: 0 },
  hard: { depth: 4, quiescence: false, budgetCapMs: maxSearchBudgetMs, randomChance: 0 },
};

function resolveStrengthLevel(difficulty, level) {
  const n = Number(level);
  if (Number.isFinite(n) && n >= 1) {
    return strengthLevels[Math.max(1, Math.min(Math.round(n), maxStrengthLevel))];
  }
  return legacyDifficulties[difficulty] || legacyDifficulties.medium;
}

class ChessAI {
  constructor() {
    this.pieceVal = { pawn:100, knight:320, bishop:330, rook:500, queen:900, king:20000 };
    this._deadline = Infinity;
    this._timedOut = false;
    this._nodes = 0;
    this._maxNodes = Infinity;
    this._quiescence = false;
    this._killers = [];
    this._history = new Int32Array(4096);
    this._pvIndex = -1;
    this._scoreScratch = null;
    this._tt = new Map();

    // Piece-square tables from white's perspective (row 0 = rank 8)
    this.pst = {
      pawn: [
        [0,  0,  0,  0,  0,  0,  0,  0],
        [50,50, 50, 50, 50, 50, 50, 50],
        [10,10, 20, 30, 30, 20, 10, 10],
        [5,  5, 10, 25, 25, 10,  5,  5],
        [0,  0,  0, 20, 20,  0,  0,  0],
        [5, -5,-10,  0,  0,-10, -5,  5],
        [5, 10, 10,-20,-20, 10, 10,  5],
        [0,  0,  0,  0,  0,  0,  0,  0]
      ],
      knight: [
        [-50,-40,-30,-30,-30,-30,-40,-50],
        [-40,-20,  0,  0,  0,  0,-20,-40],
        [-30,  0, 10, 15, 15, 10,  0,-30],
        [-30,  5, 15, 20, 20, 15,  5,-30],
        [-30,  0, 15, 20, 20, 15,  0,-30],
        [-30,  5, 10, 15, 15, 10,  5,-30],
        [-40,-20,  0,  5,  5,  0,-20,-40],
        [-50,-40,-30,-30,-30,-30,-40,-50]
      ],
      bishop: [
        [-20,-10,-10,-10,-10,-10,-10,-20],
        [-10,  0,  0,  0,  0,  0,  0,-10],
        [-10,  0,  5, 10, 10,  5,  0,-10],
        [-10,  5,  5, 10, 10,  5,  5,-10],
        [-10,  0, 10, 10, 10, 10,  0,-10],
        [-10, 10, 10, 10, 10, 10, 10,-10],
        [-10,  5,  0,  0,  0,  0,  5,-10],
        [-20,-10,-10,-10,-10,-10,-10,-20]
      ],
      rook: [
        [0,  0,  0,  0,  0,  0,  0,  0],
        [5, 10, 10, 10, 10, 10, 10,  5],
        [-5,  0,  0,  0,  0,  0,  0, -5],
        [-5,  0,  0,  0,  0,  0,  0, -5],
        [-5,  0,  0,  0,  0,  0,  0, -5],
        [-5,  0,  0,  0,  0,  0,  0, -5],
        [-5,  0,  0,  0,  0,  0,  0, -5],
        [0,  0,  0,  5,  5,  0,  0,  0]
      ],
      queen: [
        [-20,-10,-10, -5, -5,-10,-10,-20],
        [-10,  0,  0,  0,  0,  0,  0,-10],
        [-10,  0,  5,  5,  5,  5,  0,-10],
        [-5,   0,  5,  5,  5,  5,  0, -5],
        [0,    0,  5,  5,  5,  5,  0, -5],
        [-10,  5,  5,  5,  5,  5,  0,-10],
        [-10,  0,  5,  0,  0,  0,  0,-10],
        [-20,-10,-10, -5, -5,-10,-10,-20]
      ],
      king: [
        [-30,-40,-40,-50,-50,-40,-40,-30],
        [-30,-40,-40,-50,-50,-40,-40,-30],
        [-30,-40,-40,-50,-50,-40,-40,-30],
        [-30,-40,-40,-50,-50,-40,-40,-30],
        [-20,-30,-30,-40,-40,-30,-30,-20],
        [-10,-20,-20,-20,-20,-20,-20,-10],
        [20, 20,  0,  0,  0,  0, 20, 20],
        [20, 30, 10,  0,  0, 10, 30, 20]
      ]
    };
  }

  getPST(piece, r, c) {
    const table = this.pst[piece.type];
    if (!table) return 0;
    // Black uses flipped table
    const row = piece.color === 'white' ? r : 7 - r;
    return table[row][c];
  }

  evaluate(game) {
    if (game.status === 'checkmate')
      return game.winner === 'white' ? 100000 : -100000;
    if (game.status === 'stalemate' || game.status.startsWith('draw-')) return 0;

    let score = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = game.board[r][c];
        if (!p) continue;
        const v = this.pieceVal[p.type] + this.getPST(p, r, c);
        score += p.color === 'white' ? v : -v;
      }
    }
    return score;
  }

  // ── Static Exchange Evaluation ──────────────────────────────────────────
  // Delta pruning (a flat "even winning the whole piece plus a margin can't
  // help" filter) measured net negative at depth 4: it can only rule out a
  // capture when even its BEST case is hopeless, so it barely fires in a real
  // middlegame where most captures are simply recaptured for roughly equal
  // value. SEE instead plays out the actual exchange on the square and
  // returns its true net material result, which is what tells quiescence
  // "queen takes a pawn defended by a pawn" is a loser, not just "a queen
  // capture is playable in principle."
  //
  // Pins are ignored — the standard SEE simplification. An attacker that is
  // pinned and could not legally recapture is still counted as if it could.
  // This can occasionally overvalue a defender; it costs some search
  // accuracy, never legality, since SEE only orders/prunes candidates that
  // getAllLegalMoves already certified legal.

  // Does the piece at (r,c) attack (tr,tc) on this occupancy grid? Pure
  // geometry: unlike the move generator, this does not care whose turn it is
  // or what currently sits on the target square — a pawn "attacks" the
  // square diagonally ahead of it whether or not an enemy is standing there.
  _seeAttacks(occ, piece, r, c, tr, tc) {
    switch (piece.type) {
      case 'pawn': {
        const dir = piece.color === 'white' ? -1 : 1;
        return (tr - r) === dir && Math.abs(tc - c) === 1;
      }
      case 'knight':
        return seeKnightOffsets.some(([dr, dc]) => r + dr === tr && c + dc === tc);
      case 'king':
        return Math.abs(tr - r) <= 1 && Math.abs(tc - c) <= 1 && (tr !== r || tc !== c);
      case 'bishop':
        return this._seeSlide(occ, r, c, tr, tc, true, false);
      case 'rook':
        return this._seeSlide(occ, r, c, tr, tc, false, true);
      case 'queen':
        return this._seeSlide(occ, r, c, tr, tc, true, true);
      default:
        return false;
    }
  }

  // Ray-walks from (r,c) toward (tr,tc); true only if the line is the right
  // shape for this piece AND nothing sits between the two squares. The target
  // square's own occupant is never checked as a blocker — nothing in an
  // exchange sequence attacks THROUGH the contested square, only onto it.
  _seeSlide(occ, r, c, tr, tc, diagonal, orthogonal) {
    const dr = tr - r, dc = tc - c;
    if (dr === 0 && dc === 0) return false;
    const isDiagonalLine = Math.abs(dr) === Math.abs(dc);
    const isOrthogonalLine = dr === 0 || dc === 0;
    if (isDiagonalLine && !diagonal) return false;
    if (isOrthogonalLine && !orthogonal) return false;
    if (!isDiagonalLine && !isOrthogonalLine) return false;
    const stepR = Math.sign(dr), stepC = Math.sign(dc);
    let cr = r + stepR, cc = c + stepC;
    while (cr !== tr || cc !== tc) {
      if (occ[cr][cc]) return false;
      cr += stepR; cc += stepC;
    }
    return true;
  }

  // A pawn landing on the back rank promotes — this engine always to a queen,
  // since move generation never offers an under-promotion choice (matches
  // _cloneGame/minimax's own `promType || 'queen'` default elsewhere). What
  // sits on the square afterward, and what it costs to commit there, is a
  // queen's worth, not a pawn's.
  _seeLandingValue(piece, tr) {
    return piece.type === 'pawn' && (tr === 0 || tr === 7) ? this.pieceVal.queen : this.pieceVal[piece.type];
  }

  // Every piece on this occupancy grid that attacks (tr,tc), regardless of
  // color. Recomputed fresh from the current grid on every call, which is
  // what lets x-ray attackers (a rook behind a pawn, revealed once the pawn
  // is captured away) appear naturally — no separate reveal-tracking needed.
  // `value` is what landing this attacker on (tr,tc) commits, so a promoting
  // pawn sorts as the queen it is about to become, not as a pawn.
  _seeAttackersOn(occ, tr, tc) {
    const found = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = occ[r][c];
        if (p && this._seeAttacks(occ, p, r, c, tr, tc)) {
          found.push({ r, c, color: p.color, value: this._seeLandingValue(p, tr) });
        }
      }
    }
    return found;
  }

  // Net centipawn result, from the capturing side's perspective, of playing
  // (fr,fc)->(tr,tc) followed by the best sequence of recaptures both sides
  // can make on that square. Positive: color ends up ahead in material.
  // Standard "swap-off" algorithm (Chess Programming Wiki, SEE); operates on
  // a private occupancy copy, never the real board.
  _see(game, fr, fc, tr, tc, color) {
    const occ = game.board.map(row => row.map(p => (p ? { type: p.type, color: p.color } : null)));
    let firstGain = 0;
    if (occ[tr][tc]) {
      firstGain = this.pieceVal[occ[tr][tc].type];
    } else {
      // En passant: the captured pawn sits beside the target square, not on it.
      const passedRow = color === 'white' ? tr + 1 : tr - 1;
      const passed = occ[passedRow]?.[tc];
      if (passed?.type === 'pawn') {
        firstGain = this.pieceVal.pawn;
        occ[passedRow][tc] = null;
      }
    }
    const gain = [firstGain];
    let attackerValue = this._seeLandingValue(occ[fr][fc], tr);
    occ[fr][fc] = null; // may reveal an x-ray attacker behind it
    let side = color === 'white' ? 'black' : 'white';
    let depth = 0;
    while (true) {
      const attackers = this._seeAttackersOn(occ, tr, tc).filter(a => a.color === side);
      if (!attackers.length) break;
      attackers.sort((a, b) => a.value - b.value); // cheapest attacker recaptures first
      const next = attackers[0];
      depth++;
      gain[depth] = attackerValue - gain[depth - 1];
      // A side that cannot possibly improve on stopping here, even if this
      // capture is free, has no reason to continue the sequence.
      if (Math.max(-gain[depth - 1], gain[depth]) < 0) break;
      occ[next.r][next.c] = null;
      attackerValue = next.value;
      side = side === 'white' ? 'black' : 'white';
    }
    while (depth > 0) {
      gain[depth - 1] = -Math.max(-gain[depth - 1], gain[depth]);
      depth--;
    }
    return gain[0];
  }

  // Captures ordered by their SEE (best exchange first). Exchanges that lose
  // material are dropped, not just deprioritized: quiescence exists to
  // resolve tactical noise near the horizon, not to search sacrifices, and a
  // capture SEE already certifies as a net loss cannot become a net gain by
  // being searched deeper.
  _captureMoves(game, color) {
    const scored = [];
    for (const m of game.getAllLegalMoves(color)) {
      const mover = game.board[m.fr][m.fc];
      const target = game.board[m.toR][m.toC];
      // A pawn changing file onto an empty square is an en-passant capture.
      const enPassant = !target && mover?.type === 'pawn' && m.fc !== m.toC;
      if (!target && !enPassant) continue;
      const see = this._see(game, m.fr, m.fc, m.toR, m.toC, color);
      if (see < 0) continue;
      scored.push({ m, see });
    }
    return scored.sort((a, b) => b.see - a.see).map(entry => entry.m);
  }

  // Search on past a noisy leaf until the position is quiet, so the score
  // reflects the end of the capture sequence rather than the middle of it.
  _quiesce(game, alpha, beta, maximizing, plies) {
    this._nodes++;
    if (this._nodes > this._maxNodes || ((this._nodes & 63) === 0 && Date.now() >= this._deadline)) {
      this._timedOut = true;
      return this.evaluate(game);
    }
    const standPat = this.evaluate(game);
    if (plies === 0 || game.status === 'checkmate' || game.status === 'stalemate' || game.status.startsWith('draw-'))
      return standPat;

    // Standing pat: the side to move is never forced to capture, so its score
    // is at least what it already has.
    if (maximizing) {
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
    } else {
      if (standPat <= alpha) return standPat;
      if (standPat < beta) beta = standPat;
    }

    for (const m of this._captureMoves(game, maximizing ? 'white' : 'black')) {
      const clone = this._cloneGame(game);
      clone.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
      const val = this._quiesce(clone, alpha, beta, !maximizing, plies - 1);
      if (this._timedOut) return val;
      if (maximizing) {
        if (val > alpha) alpha = val;
      } else if (val < beta) {
        beta = val;
      }
      if (beta <= alpha) break;
    }
    return maximizing ? alpha : beta;
  }

  // ply is the distance from the root, used to index killer moves. It is
  // optional so existing callers (the journal grader in main.js) still work.
  minimax(game, depth, alpha, beta, maximizing, ply = 0) {
    this._nodes++;
    if (this._nodes > this._maxNodes || (this._nodes & 63) === 0 && Date.now() >= this._deadline) {
      this._timedOut = true;
      return this.evaluate(game);
    }
    if (game.status === 'checkmate' || game.status === 'stalemate' || game.status.startsWith('draw-'))
      return this.evaluate(game);
    if (depth === 0) {
      // Without quiescence, a leaf can land in the middle of a capture sequence
      // and be scored as if the recapture never happens — that is how the bot
      // hangs pieces right at the horizon. Opt-in so the browser opponent keeps
      // the strength it was tuned for.
      return this._quiescence
        ? this._quiesce(game, alpha, beta, maximizing, quiesceMaxPlies)
        : this.evaluate(game);
    }

    const color = maximizing ? 'white' : 'black';
    const key = depth > 1 ? this._positionKey(game, depth, maximizing) : '';
    if (key && this._tt.has(key)) return this._tt.get(key);
    const moves = this._orderMovesAt(game, game.getAllLegalMoves(color), ply);

    if (maximizing) {
      let best = -Infinity;
      let cutoff = false;
      for (const m of moves) {
        // Clone game state for simulation
        const clone = this._cloneGame(game);
        const isCapture = !!game.board[m.toR]?.[m.toC];
        clone.makeMove(m.fr, m.fc, m.toR, m.toC);
        const val = this.minimax(clone, depth - 1, alpha, beta, false, ply + 1);
        if (this._timedOut) return val;
        best = Math.max(best, val);
        alpha = Math.max(alpha, val);
        if (beta <= alpha) { this._rememberCutoff(m, depth, ply, isCapture); cutoff = true; break; }
      }
      // A pruned alpha-beta value is a bound, not an exact score. Cache only
      // complete subtrees so a later branch cannot mistake a bound for truth.
      if (key && !cutoff) this._tt.set(key, best);
      return best;
    } else {
      let best = Infinity;
      let cutoff = false;
      for (const m of moves) {
        const clone = this._cloneGame(game);
        const isCapture = !!game.board[m.toR]?.[m.toC];
        clone.makeMove(m.fr, m.fc, m.toR, m.toC);
        const val = this.minimax(clone, depth - 1, alpha, beta, true, ply + 1);
        if (this._timedOut) return val;
        best = Math.min(best, val);
        beta = Math.min(beta, val);
        if (beta <= alpha) { this._rememberCutoff(m, depth, ply, isCapture); cutoff = true; break; }
      }
      if (key && !cutoff) this._tt.set(key, best);
      return best;
    }
  }

  _cloneGame(game) {
    const clone = new ChessGame();
    clone.board = game.cloneBoard();
    clone.currentTurn = game.currentTurn;
    clone.enPassantTarget = game.enPassantTarget ? { ...game.enPassantTarget } : null;
    // A JSON round-trip ran here on EVERY node of the search. The shape is two
    // fixed objects of two booleans; serialising them was costing more than the
    // move generation it accompanied.
    const cr = game.castlingRights;
    clone.castlingRights = {
      white: { kingSide: cr.white.kingSide, queenSide: cr.white.queenSide },
      black: { kingSide: cr.black.kingSide, queenSide: cr.black.queenSide },
    };
    clone.capturedByWhite = [...game.capturedByWhite];
    clone.capturedByBlack = [...game.capturedByBlack];
    clone.status = game.status;
    clone.winner = game.winner;
    clone.halfmoveClock = game.halfmoveClock;
    clone.positionCounts = new Map(game.positionCounts);
    clone.moveHistory = [];
    return clone;
  }

  _positionKey(game, depth, maximizing) {
    const boardState = typeof game._positionKey === 'function'
      ? game._positionKey()
      : JSON.stringify([game.board, game.currentTurn, game.castlingRights, game.enPassantTarget]);
    // Draw state is part of the position evaluation. Include the half-move
    // clock and any already-repeated historical positions so a transposition
    // never reuses a score across incompatible fifty-move/repetition states.
    const repeated = [...(game.positionCounts || new Map()).entries()]
      .filter(([, count]) => count >= 2)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => `${key}:${count}`)
      .join(';');
    return `${depth}|${maximizing ? 1 : 0}|${boardState}|${game.halfmoveClock || 0}|${repeated}`;
  }

  _movePriority(game, m) {
    const captured = game.board[m.toR]?.[m.toC];
    const mover = game.board[m.fr]?.[m.fc];
    let score = captured ? 10000 + (this.pieceVal[captured.type] || 0) - (this.pieceVal[mover?.type] || 0) / 10 : 0;
    if (m.promType) score += this.pieceVal[m.promType] || 0;
    return score;
  }

  // A move's identity for the killer and history tables, as a plain integer
  // (from-square * 64 + to-square). This is a hot path: a string key here cost
  // more in allocation than the better ordering saved, and measured a whole
  // ply SHALLOWER at the same time budget.
  _moveIndex(m) {
    return ((m.fr << 3) | m.fc) * 64 + ((m.toR << 3) | m.toC);
  }

  // Quiet moves that caused a cutoff are the cheapest ordering signal there is:
  // the same refutation usually works for sibling positions at the same ply.
  // Captures are excluded because they are already ordered ahead of everything.
  _rememberCutoff(m, depth, ply, isCapture) {
    if (isCapture) return;
    const idx = this._moveIndex(m);
    const killers = this._killers[ply] || (this._killers[ply] = [-1, -1]);
    if (killers[0] !== idx) {
      killers[1] = killers[0];
      killers[0] = idx;
    }
    // depth² weighting: a cutoff found deeper in the tree saved more work, so
    // it says more about the move than one found near a leaf.
    this._history[idx] += depth * depth;
  }

  _moveScore(game, m, ply) {
    const idx = this._moveIndex(m);
    if (idx === this._pvIndex) return 1e9; // best move from the previous pass
    const captured = game.board[m.toR]?.[m.toC];
    if (captured) {
      const mover = game.board[m.fr]?.[m.fc];
      return 100000 + (this.pieceVal[captured.type] || 0) - (this.pieceVal[mover?.type] || 0) / 10;
    }
    if (m.promType) return 90000 + (this.pieceVal[m.promType] || 0);
    const killers = ply >= 0 ? this._killers[ply] : null;
    if (killers) {
      if (killers[0] === idx) return 80000;
      if (killers[1] === idx) return 79000;
    }
    return this._history[idx];
  }

  // Sorts in place with a shared scratch buffer, because this runs at every
  // node: the obvious version — score each move into a {move, score} object and
  // sort those — allocated ~40 objects per node and measured 22x SLOWER per
  // node, swamping the 43% node reduction the ordering itself buys.
  //
  // The scratch is safe to share across the recursion: scoring and sorting both
  // finish before this returns, and the search only recurses afterwards.
  // Insertion sort beats a comparator call here at typical move-list sizes.
  _orderMovesAt(game, moves, ply) {
    const n = moves.length;
    if (n < 2) return moves;
    if (!this._scoreScratch || this._scoreScratch.length < n) {
      this._scoreScratch = new Float64Array(Math.max(n, 128));
    }
    const scores = this._scoreScratch;
    for (let i = 0; i < n; i++) scores[i] = this._moveScore(game, moves[i], ply);
    for (let i = 1; i < n; i++) {
      const move = moves[i];
      const score = scores[i];
      let j = i - 1;
      while (j >= 0 && scores[j] < score) {
        moves[j + 1] = moves[j];
        scores[j + 1] = scores[j];
        j--;
      }
      moves[j + 1] = move;
      scores[j + 1] = score;
    }
    return moves;
  }

  _orderMoves(game, moves) {
    return [...moves].sort((a, b) => this._movePriority(game, b) - this._movePriority(game, a));
  }

  _styleBias(gameBefore, gameAfter, move, color, style = {}) {
    const captured = gameBefore.board[move.toR]?.[move.toC];
    const unit = value => Math.max(0, Math.min(1, Number(value) || 0));
    const aggression = unit(style.aggression);
    const kingAttack = unit(style.kingAttackFocus ?? style.king_attack_focus);
    const materialGreed = unit(style.materialGreed ?? style.material_greed);
    const risk = unit(style.riskTolerance ?? style.risk_tolerance);
    let bonus = 0;
    if (captured) bonus += 8 * aggression + (this.pieceVal[captured.type] || 0) * 0.025 * materialGreed;
    if (gameAfter.status === 'check' || gameAfter.status === 'checkmate') bonus += 22 * kingAttack;
    const advanced = color === 'white' ? move.toR < move.fr : move.toR > move.fr;
    if (advanced) bonus += 4 * risk;
    return color === 'white' ? bonus : -bonus;
  }

  getBestMove(game, difficulty, options = {}) {
    // options.level, when present, is authoritative; the difficulty name is the
    // fallback so callers that never learned about levels are unaffected.
    const rung = resolveStrengthLevel(difficulty, options.level);
    const targetDepth = rung.depth;
    const color = game.currentTurn;
    const maximizing = color === 'white';
    const moves = this._orderMoves(game, game.getAllLegalMoves(color));
    if (!moves.length) {
      this.lastSearch = { nodes: 0, timedOut: false, completedDepth: 0, targetDepth, budgetMs: 0 };
      return null;
    }

    // The lowest rungs blunder on purpose — that is what makes them beatable by
    // a beginner, rather than just shallow.
    if (rung.randomChance > 0 && Math.random() < rung.randomChance) {
      this.lastSearch = { nodes: 0, timedOut: false, completedDepth: 0, targetDepth, budgetMs: 0, random: true };
      return moves[Math.floor(Math.random() * moves.length)];
    }

    const requested = Number(options.timeBudgetMs);
    const budget = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, rung.budgetCapMs)
      : rung.budgetCapMs;
    this._deadline = Date.now() + Math.max(25, Math.min(maxSearchBudgetMs, budget));
    this._maxNodes = Number.isFinite(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : Infinity;
    // An explicit quiescence option still wins, so the bots can opt in without
    // waiting for a level that carries it.
    this._quiescence = options.quiescence === true || rung.quiescence;
    this._nodes = 0;
    this._timedOut = false;
    this._tt = new Map();
    this._killers = [];
    this._history = new Int32Array(4096); // from-square*64 + to-square
    this._pvIndex = -1;

    let bestMove = moves[0]; // always retain a legal fallback
    let completedDepth = 0;
    for (let depth = 1; depth <= targetDepth; depth++) {
      // Search the previous pass's best move first. It is usually still best,
      // and an early high score is what lets alpha-beta discard its siblings —
      // this is most of what makes iterative deepening pay for itself.
      this._pvIndex = completedDepth > 0 ? this._moveIndex(bestMove) : -1;
      const rootMoves = this._orderMovesAt(game, moves, 0);
      let iterationMove = null;
      let iterationVal = maximizing ? -Infinity : Infinity;
      this._timedOut = false;
      for (const m of rootMoves) {
        if (Date.now() >= this._deadline || this._nodes >= this._maxNodes) {
          this._timedOut = true;
          break;
        }
        const clone = this._cloneGame(game);
        clone.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
        // Full window at the root on purpose: _styleBias is added to the raw
        // score afterwards, so narrowing here could prune a move that the bias
        // would have preferred.
        let val = this.minimax(clone, depth - 1, -Infinity, Infinity, !maximizing, 1);
        val += this._styleBias(game, clone, m, color, options.style);
        if (this._timedOut) break;
        if ((maximizing && val > iterationVal) || (!maximizing && val < iterationVal)) {
          iterationVal = val;
          iterationMove = m;
        }
      }
      if (this._timedOut || !iterationMove) break; // discard an incomplete depth
      bestMove = iterationMove;
      completedDepth = depth;
    }
    this.lastSearch = {
      nodes: this._nodes, timedOut: this._timedOut, completedDepth, targetDepth,
      budgetMs: budget || 0, quiescence: this._quiescence,
    };
    return bestMove;
  }

  // Returns best move from BEFORE player's move, used for move suggestions
  getSuggestedMove(game, color) {
    const savedTurn = game.currentTurn;
    game.currentTurn = color;
    const best = this.getBestMove(game, 'medium');
    game.currentTurn = savedTurn;
    return best;
  }
}

export { ChessAI };

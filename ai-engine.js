'use strict';

import { ChessGame } from './chess-engine.js';

class ChessAI {
  constructor() {
    this.pieceVal = { pawn:100, knight:320, bishop:330, rook:500, queen:900, king:20000 };
    this._deadline = Infinity;
    this._timedOut = false;
    this._nodes = 0;
    this._maxNodes = Infinity;
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

  minimax(game, depth, alpha, beta, maximizing) {
    this._nodes++;
    if (this._nodes > this._maxNodes || (this._nodes & 63) === 0 && Date.now() >= this._deadline) {
      this._timedOut = true;
      return this.evaluate(game);
    }
    if (depth === 0 || game.status === 'checkmate' || game.status === 'stalemate' || game.status.startsWith('draw-'))
      return this.evaluate(game);

    const color = maximizing ? 'white' : 'black';
    const key = depth > 1 ? this._positionKey(game, depth, maximizing) : '';
    if (key && this._tt.has(key)) return this._tt.get(key);
    const moves = this._orderMoves(game, game.getAllLegalMoves(color));

    if (maximizing) {
      let best = -Infinity;
      let cutoff = false;
      for (const m of moves) {
        // Clone game state for simulation
        const clone = this._cloneGame(game);
        clone.makeMove(m.fr, m.fc, m.toR, m.toC);
        const val = this.minimax(clone, depth - 1, alpha, beta, false);
        if (this._timedOut) return val;
        best = Math.max(best, val);
        alpha = Math.max(alpha, val);
        if (beta <= alpha) { cutoff = true; break; }
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
        clone.makeMove(m.fr, m.fc, m.toR, m.toC);
        const val = this.minimax(clone, depth - 1, alpha, beta, true);
        if (this._timedOut) return val;
        best = Math.min(best, val);
        beta = Math.min(beta, val);
        if (beta <= alpha) { cutoff = true; break; }
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
    clone.castlingRights = JSON.parse(JSON.stringify(game.castlingRights));
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
    const depths = { easy: 1, medium: 2, hard: 4 };
    const targetDepth = depths[difficulty] || 2;
    const color = game.currentTurn;
    const maximizing = color === 'white';
    const moves = this._orderMoves(game, game.getAllLegalMoves(color));
    if (!moves.length) {
      this.lastSearch = { nodes: 0, timedOut: false, completedDepth: 0, targetDepth, budgetMs: 0 };
      return null;
    }

    // Easy: 40% random
    if (difficulty === 'easy' && Math.random() < 0.4) {
      this.lastSearch = { nodes: 0, timedOut: false, completedDepth: 0, targetDepth, budgetMs: 0, random: true };
      return moves[Math.floor(Math.random() * moves.length)];
    }

    const budget = Number(options.timeBudgetMs);
    this._deadline = Number.isFinite(budget) && budget > 0 ? Date.now() + Math.max(25, Math.min(1000, budget)) : Infinity;
    this._maxNodes = Number.isFinite(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : Infinity;
    this._nodes = 0;
    this._timedOut = false;
    this._tt = new Map();

    let bestMove = moves[0]; // always retain a legal fallback
    let completedDepth = 0;
    for (let depth = 1; depth <= targetDepth; depth++) {
      let iterationMove = null;
      let iterationVal = maximizing ? -Infinity : Infinity;
      this._timedOut = false;
      for (const m of moves) {
        if (Date.now() >= this._deadline || this._nodes >= this._maxNodes) {
          this._timedOut = true;
          break;
        }
        const clone = this._cloneGame(game);
        clone.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
        let val = this.minimax(clone, depth - 1, -Infinity, Infinity, !maximizing);
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
    this.lastSearch = { nodes: this._nodes, timedOut: this._timedOut, completedDepth, targetDepth, budgetMs: budget || 0 };
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

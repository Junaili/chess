'use strict';

class ChessAI {
  constructor() {
    this.pieceVal = { pawn:100, knight:320, bishop:330, rook:500, queen:900, king:20000 };

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
    if (depth === 0 || game.status === 'checkmate' || game.status === 'stalemate' || game.status.startsWith('draw-'))
      return this.evaluate(game);

    const color = maximizing ? 'white' : 'black';
    const moves = game.getAllLegalMoves(color);

    if (maximizing) {
      let best = -Infinity;
      for (const m of moves) {
        // Clone game state for simulation
        const clone = this._cloneGame(game);
        clone.makeMove(m.fr, m.fc, m.toR, m.toC);
        const val = this.minimax(clone, depth - 1, alpha, beta, false);
        best = Math.max(best, val);
        alpha = Math.max(alpha, val);
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const m of moves) {
        const clone = this._cloneGame(game);
        clone.makeMove(m.fr, m.fc, m.toR, m.toC);
        const val = this.minimax(clone, depth - 1, alpha, beta, true);
        best = Math.min(best, val);
        beta = Math.min(beta, val);
        if (beta <= alpha) break;
      }
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

  getBestMove(game, difficulty) {
    const depths = { easy: 1, medium: 2, hard: 4 };
    const depth = depths[difficulty] || 2;
    const color = game.currentTurn;
    const maximizing = color === 'white';
    const moves = game.getAllLegalMoves(color);
    if (!moves.length) return null;

    // Easy: 40% random
    if (difficulty === 'easy' && Math.random() < 0.4)
      return moves[Math.floor(Math.random() * moves.length)];

    let bestMove = null;
    let bestVal = maximizing ? -Infinity : Infinity;

    for (const m of moves) {
      const clone = this._cloneGame(game);
      clone.makeMove(m.fr, m.fc, m.toR, m.toC);
      const val = this.minimax(clone, depth - 1, -Infinity, Infinity, !maximizing);
      if ((maximizing && val > bestVal) || (!maximizing && val < bestVal)) {
        bestVal = val;
        bestMove = m;
      }
    }
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

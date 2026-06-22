'use strict';

class ChessGame {
  constructor() {
    this.reset();
  }

  reset() {
    this.board = this._createInitialBoard();
    this.currentTurn = 'white';
    this.enPassantTarget = null;
    this.castlingRights = {
      white: { kingSide: true, queenSide: true },
      black: { kingSide: true, queenSide: true }
    };
    this.moveHistory = [];
    this.capturedByWhite = [];
    this.capturedByBlack = [];
    this.status = 'playing';
    this.winner = null;
    this.lastMoveHint = null;
  }

  _createInitialBoard() {
    const b = Array(8).fill(null).map(() => Array(8).fill(null));
    const backRank = ['rook','knight','bishop','queen','king','bishop','knight','rook'];
    for (let c = 0; c < 8; c++) {
      b[0][c] = { type: backRank[c], color: 'black', hasMoved: false };
      b[1][c] = { type: 'pawn',      color: 'black', hasMoved: false };
      b[6][c] = { type: 'pawn',      color: 'white', hasMoved: false };
      b[7][c] = { type: backRank[c], color: 'white', hasMoved: false };
    }
    return b;
  }

  isValidSquare(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

  cloneBoard(src = this.board) {
    return src.map(row => row.map(cell => cell ? { ...cell } : null));
  }

  findKing(color, board = this.board) {
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (board[r][c]?.type === 'king' && board[r][c].color === color)
          return { r, c };
    return null;
  }

  // ─── Raw move generators ───────────────────────────────────────────────────

  _pawnMoves(r, c, board) {
    const p = board[r][c];
    const moves = [];
    const dir = p.color === 'white' ? -1 : 1;

    // Forward 1
    if (this.isValidSquare(r + dir, c) && !board[r + dir][c]) {
      moves.push({ toR: r + dir, toC: c });
      // Forward 2 on first move
      if (!p.hasMoved && !board[r + 2 * dir][c])
        moves.push({ toR: r + 2 * dir, toC: c, doublePush: true });
    }
    // Captures
    for (const dc of [-1, 1]) {
      const nr = r + dir, nc = c + dc;
      if (!this.isValidSquare(nr, nc)) continue;
      const target = board[nr][nc];
      if (target && target.color !== p.color)
        moves.push({ toR: nr, toC: nc });
      // En passant
      if (this.enPassantTarget?.r === nr && this.enPassantTarget?.c === nc)
        moves.push({ toR: nr, toC: nc, enPassant: true });
    }
    return moves;
  }

  _knightMoves(r, c, board) {
    const p = board[r][c];
    const moves = [];
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const nr = r + dr, nc = c + dc;
      if (this.isValidSquare(nr, nc)) {
        const t = board[nr][nc];
        if (!t || t.color !== p.color) moves.push({ toR: nr, toC: nc });
      }
    }
    return moves;
  }

  _sliderMoves(r, c, board, dirs) {
    const p = board[r][c];
    const moves = [];
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (this.isValidSquare(nr, nc)) {
        const t = board[nr][nc];
        if (t) { if (t.color !== p.color) moves.push({ toR: nr, toC: nc }); break; }
        moves.push({ toR: nr, toC: nc });
        nr += dr; nc += dc;
      }
    }
    return moves;
  }

  _bishopMoves(r, c, board) {
    return this._sliderMoves(r, c, board, [[-1,-1],[-1,1],[1,-1],[1,1]]);
  }

  _rookMoves(r, c, board) {
    return this._sliderMoves(r, c, board, [[-1,0],[1,0],[0,-1],[0,1]]);
  }

  _queenMoves(r, c, board) {
    return this._sliderMoves(r, c, board,
      [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]);
  }

  _kingMovesBasic(r, c, board) {
    const p = board[r][c];
    const moves = [];
    for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
      const nr = r + dr, nc = c + dc;
      if (this.isValidSquare(nr, nc)) {
        const t = board[nr][nc];
        if (!t || t.color !== p.color) moves.push({ toR: nr, toC: nc });
      }
    }
    return moves;
  }

  _kingMoves(r, c, board) {
    const p = board[r][c];
    const opp = p.color === 'white' ? 'black' : 'white';
    const moves = this._kingMovesBasic(r, c, board);

    if (!p.hasMoved && !this.isAttacked(r, c, opp, board)) {
      const rights = this.castlingRights[p.color];

      // King-side
      if (rights.kingSide) {
        const rook = board[r][7];
        if (rook?.type === 'rook' && rook.color === p.color && !rook.hasMoved &&
            !board[r][5] && !board[r][6] &&
            !this.isAttacked(r, 5, opp, board) && !this.isAttacked(r, 6, opp, board))
          moves.push({ toR: r, toC: 6, castling: 'kingSide' });
      }
      // Queen-side
      if (rights.queenSide) {
        const rook = board[r][0];
        if (rook?.type === 'rook' && rook.color === p.color && !rook.hasMoved &&
            !board[r][1] && !board[r][2] && !board[r][3] &&
            !this.isAttacked(r, 3, opp, board) && !this.isAttacked(r, 2, opp, board))
          moves.push({ toR: r, toC: 2, castling: 'queenSide' });
      }
    }
    return moves;
  }

  getRawMoves(r, c, board = this.board) {
    const p = board[r][c];
    if (!p) return [];
    switch (p.type) {
      case 'pawn':   return this._pawnMoves(r, c, board);
      case 'knight': return this._knightMoves(r, c, board);
      case 'bishop': return this._bishopMoves(r, c, board);
      case 'rook':   return this._rookMoves(r, c, board);
      case 'queen':  return this._queenMoves(r, c, board);
      case 'king':   return this._kingMoves(r, c, board);
    }
    return [];
  }

  // ─── Attack detection ──────────────────────────────────────────────────────

  isAttacked(r, c, byColor, board = this.board) {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const p = board[row][col];
        if (!p || p.color !== byColor) continue;
        // Use basic king moves to avoid recursion
        const moves = p.type === 'king'
          ? this._kingMovesBasic(row, col, board)
          : this.getRawMoves(row, col, board);
        if (moves.some(m => m.toR === r && m.toC === c)) return true;
      }
    }
    return false;
  }

  // ─── Legal moves ───────────────────────────────────────────────────────────

  _applyToBoard(board, fr, fc, move, promType = 'queen') {
    const p = board[fr][fc];
    if (move.enPassant) {
      const cr = p.color === 'white' ? move.toR + 1 : move.toR - 1;
      board[cr][move.toC] = null;
    }
    if (move.castling === 'kingSide') {
      board[fr][5] = { ...board[fr][7], hasMoved: true };
      board[fr][7] = null;
    } else if (move.castling === 'queenSide') {
      board[fr][3] = { ...board[fr][0], hasMoved: true };
      board[fr][0] = null;
    }
    board[move.toR][move.toC] = { ...p, hasMoved: true };
    board[fr][fc] = null;
    if (p.type === 'pawn' && (move.toR === 0 || move.toR === 7))
      board[move.toR][move.toC] = { type: promType, color: p.color, hasMoved: true };
  }

  isLegal(fr, fc, move) {
    const p = this.board[fr][fc];
    const copy = this.cloneBoard();
    this._applyToBoard(copy, fr, fc, move);
    const king = this.findKing(p.color, copy);
    if (!king) return false;
    const opp = p.color === 'white' ? 'black' : 'white';
    return !this.isAttacked(king.r, king.c, opp, copy);
  }

  getLegalMoves(r, c) {
    const p = this.board[r][c];
    if (!p || p.color !== this.currentTurn) return [];
    return this.getRawMoves(r, c).filter(m => this.isLegal(r, c, m));
  }

  getAllLegalMoves(color) {
    const saved = this.currentTurn;
    this.currentTurn = color;
    const moves = [];
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = this.board[r][c];
        if (p?.color === color)
          for (const m of this.getLegalMoves(r, c))
            moves.push({ fr: r, fc: c, ...m });
      }
    this.currentTurn = saved;
    return moves;
  }

  // ─── Game status ───────────────────────────────────────────────────────────

  isInCheck(color) {
    const king = this.findKing(color);
    if (!king) return false;
    return this.isAttacked(king.r, king.c, color === 'white' ? 'black' : 'white');
  }

  _updateStatus() {
    const color = this.currentTurn;
    const moves = this.getAllLegalMoves(color);
    if (moves.length === 0) {
      if (this.isInCheck(color)) {
        this.status = 'checkmate';
        this.winner = color === 'white' ? 'black' : 'white';
      } else {
        this.status = 'stalemate';
      }
    } else if (this.isInCheck(color)) {
      this.status = 'check';
    } else {
      this.status = 'playing';
    }
  }

  // ─── Make move ─────────────────────────────────────────────────────────────

  makeMove(fr, fc, toR, toC, promType = 'queen') {
    const legal = this.getLegalMoves(fr, fc);
    const move = legal.find(m => m.toR === toR && m.toC === toC);
    if (!move) return false;

    const piece = this.board[fr][fc];
    const captured = this.board[toR][toC];

    // Record history for undo
    const record = {
      fr, fc, toR, toC,
      piece: { ...piece },
      captured: captured ? { ...captured } : null,
      move: { ...move },
      promType,
      prevEP: this.enPassantTarget,
      prevCR: JSON.parse(JSON.stringify(this.castlingRights)),
      prevStatus: this.status
    };

    // Track captures
    if (captured) (piece.color === 'white' ? this.capturedByWhite : this.capturedByBlack).push(captured);

    // En passant capture
    if (move.enPassant) {
      const cr = piece.color === 'white' ? toR + 1 : toR - 1;
      const epPiece = this.board[cr][toC];
      if (epPiece) (piece.color === 'white' ? this.capturedByWhite : this.capturedByBlack).push(epPiece);
      this.board[cr][toC] = null;
      record.epCaptureR = cr;
      record.epCaptureC = toC;
    }

    // Castling
    if (move.castling === 'kingSide') {
      this.board[fr][5] = { ...this.board[fr][7], hasMoved: true };
      this.board[fr][7] = null;
    } else if (move.castling === 'queenSide') {
      this.board[fr][3] = { ...this.board[fr][0], hasMoved: true };
      this.board[fr][0] = null;
    }

    // Move piece
    this.board[toR][toC] = { ...piece, hasMoved: true };
    this.board[fr][fc] = null;

    // Promotion
    const isPromotion = piece.type === 'pawn' && (toR === 0 || toR === 7);
    if (isPromotion)
      this.board[toR][toC] = { type: promType, color: piece.color, hasMoved: true };

    // En passant target
    this.enPassantTarget = move.doublePush
      ? { r: piece.color === 'white' ? toR + 1 : toR - 1, c: toC }
      : null;

    // Castling rights
    if (piece.type === 'king') {
      this.castlingRights[piece.color].kingSide = false;
      this.castlingRights[piece.color].queenSide = false;
    }
    if (piece.type === 'rook') {
      if (fc === 0) this.castlingRights[piece.color].queenSide = false;
      if (fc === 7) this.castlingRights[piece.color].kingSide = false;
    }

    this.moveHistory.push(record);
    this.currentTurn = this.currentTurn === 'white' ? 'black' : 'white';
    this._updateStatus();
    return { move, isPromotion };
  }

  // ─── Notation ──────────────────────────────────────────────────────────────

  toAlgebraic(r, c) {
    return 'abcdefgh'[c] + (8 - r);
  }

  getMoveNotation(fr, fc, toR, toC, promType) {
    const p = this.board[fr][fc];
    if (!p) return '';
    const letters = { pawn:'', knight:'N', bishop:'B', rook:'R', queen:'Q', king:'K' };
    const dest = this.toAlgebraic(toR, toC);
    if (p.type === 'pawn') {
      const cap = toC !== fc ? 'abcdefgh'[fc] + 'x' + dest : dest;
      const prom = (toR === 0 || toR === 7) ? '=' + letters[promType] : '';
      return cap + prom;
    }
    const cap = this.board[toR][toC] ? 'x' : '';
    return letters[p.type] + cap + dest;
  }
}

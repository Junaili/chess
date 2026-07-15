const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const engineSource = fs.readFileSync(path.join(__dirname, '..', '..', 'chess-engine.js'), 'utf8')
  .replace(/^export\s+\{[^\n]+$/gm, '');
const context = {};
vm.createContext(context);
vm.runInContext(`${engineSource}\nthis.ChessGame = ChessGame;`, context);
const ChessGame = context.ChessGame;

function move(game, from, to, promotion = 'queen') {
  const files = 'abcdefgh';
  return game.makeMove(
    8 - Number(from[1]),
    files.indexOf(from[0]),
    8 - Number(to[1]),
    files.indexOf(to[0]),
    promotion
  );
}

function emptyGame() {
  const game = new ChessGame();
  game.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  game.currentTurn = 'white';
  game.enPassantTarget = null;
  game.castlingRights = {
    white: { kingSide: false, queenSide: false },
    black: { kingSide: false, queenSide: false },
  };
  game.moveHistory = [];
  game.capturedByWhite = [];
  game.capturedByBlack = [];
  game.status = 'playing';
  game.winner = null;
  game.halfmoveClock = 0;
  game.positionCounts = new Map();
  return game;
}

test('detects checkmate before any draw rule', () => {
  const game = new ChessGame();
  move(game, 'f2', 'f3');
  move(game, 'e7', 'e5');
  move(game, 'g2', 'g4');
  move(game, 'd8', 'h4');
  assert.equal(game.status, 'checkmate');
  assert.equal(game.winner, 'black');
});

test('detects insufficient material', async t => {
  await t.test('king versus king', () => {
    const game = emptyGame();
    game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
    game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
    game._updateStatus();
    assert.equal(game.status, 'draw-insufficient');
  });

  await t.test('king and bishop versus king', () => {
    const game = emptyGame();
    game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
    game.board[6][3] = { type: 'bishop', color: 'white', hasMoved: true };
    game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
    game._updateStatus();
    assert.equal(game.status, 'draw-insufficient');
  });

  await t.test('bishops confined to one square color', () => {
    const game = emptyGame();
    game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
    game.board[6][3] = { type: 'bishop', color: 'white', hasMoved: true };
    game.board[1][2] = { type: 'bishop', color: 'black', hasMoved: true };
    game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
    game._updateStatus();
    assert.equal(game.status, 'draw-insufficient');
  });
});

test('detects the fifty-move rule after 100 halfmoves', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[6][0] = { type: 'rook', color: 'white', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  game.halfmoveClock = 99;
  game._recordCurrentPosition();

  assert.ok(game.makeMove(6, 0, 6, 1));
  assert.equal(game.halfmoveClock, 100);
  assert.equal(game.status, 'draw-fifty-move');
});

test('pawn moves reset the fifty-move counter', () => {
  const game = new ChessGame();
  game.halfmoveClock = 42;
  assert.ok(move(game, 'e2', 'e4'));
  assert.equal(game.halfmoveClock, 0);
});

test('detects threefold repetition', () => {
  const game = new ChessGame();
  for (let cycle = 0; cycle < 2; cycle++) {
    assert.ok(move(game, 'g1', 'f3'));
    assert.ok(move(game, 'g8', 'f6'));
    assert.ok(move(game, 'f3', 'g1'));
    assert.ok(move(game, 'f6', 'g8'));
  }
  assert.equal(game.status, 'draw-repetition');
});

test('captures reset the fifty-move counter', () => {
  const game = new ChessGame();
  assert.ok(move(game, 'e2', 'e4'));
  assert.ok(move(game, 'd7', 'd5'));
  game.halfmoveClock = 42;
  assert.ok(move(game, 'e4', 'd5')); // pawn takes pawn
  assert.equal(game.halfmoveClock, 0);
});

test('single knight is insufficient material', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[5][5] = { type: 'knight', color: 'white', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  game._updateStatus();
  assert.equal(game.status, 'draw-insufficient');
});

test('opposite-colored bishops are NOT insufficient material', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[6][3] = { type: 'bishop', color: 'white', hasMoved: true }; // (6+3)%2 = 1
  game.board[1][3] = { type: 'bishop', color: 'black', hasMoved: true }; // (1+3)%2 = 0
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  game._updateStatus();
  assert.equal(game.status, 'playing');
});

test('a rook is NOT insufficient material', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[6][0] = { type: 'rook', color: 'white', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  game._updateStatus();
  assert.equal(game.status, 'playing');
});

test('losing castling rights breaks position repetition', () => {
  // Rook shuffles that RETURN to the same squares are not "the same position"
  // the first time around: the initial position still had castling rights and
  // the returned one does not, so their repetition keys differ.
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: false };
  game.board[7][7] = { type: 'rook', color: 'white', hasMoved: false };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: false };
  game.board[0][7] = { type: 'rook', color: 'black', hasMoved: false };
  game.castlingRights = {
    white: { kingSide: true, queenSide: false },
    black: { kingSide: true, queenSide: false },
  };
  game.positionCounts = new Map();
  game._recordCurrentPosition();

  const shuffle = () => {
    assert.ok(game.makeMove(7, 7, 6, 7)); // Rh1-h2
    assert.ok(game.makeMove(0, 7, 1, 7)); // Rh8-h7
    assert.ok(game.makeMove(6, 7, 7, 7)); // Rh2-h1
    assert.ok(game.makeMove(1, 7, 0, 7)); // Rh7-h8
  };

  shuffle();
  // Same piece layout as the start, but castling rights differ → count is 1.
  assert.equal(game._currentPositionCount(), 1);
  assert.equal(game.status, 'playing');

  shuffle(); // the rights-less position seen a second time
  assert.equal(game.status, 'playing');
  shuffle(); // …and a third time → draw
  assert.equal(game.status, 'draw-repetition');
});

test('position key only records en passant when a capture is legal', () => {
  const game = new ChessGame();
  assert.ok(move(game, 'e2', 'e4')); // double push, but no black pawn can take
  assert.ok(game.enPassantTarget, 'engine still tracks the ep square internally');
  assert.ok(game._positionKey().endsWith(' -'), 'key ignores uncapturable ep');
});

// ─── Piece movement & special moves ──────────────────────────────────────────

test('rejects an illegal move and accepts a legal one', () => {
  const game = new ChessGame();
  assert.equal(move(game, 'e2', 'e5'), false, 'pawn cannot jump three squares');
  assert.ok(move(game, 'e2', 'e4'), 'pawn double-push from start is legal');
  assert.equal(game.currentTurn, 'black');
});

test('white king-side castling moves king and rook together', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: false };
  game.board[7][7] = { type: 'rook', color: 'white', hasMoved: false };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: false };
  game.castlingRights.white.kingSide = true;
  game._updateStatus();

  assert.ok(move(game, 'e1', 'g1'), 'king-side castle should be legal');
  assert.equal(game.board[7][6]?.type, 'king', 'king lands on g1');
  assert.equal(game.board[7][5]?.type, 'rook', 'rook lands on f1');
  assert.equal(game.board[7][7], null, 'original rook square empty');
});

test('white queen-side castling moves king and rook together', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: false };
  game.board[7][0] = { type: 'rook', color: 'white', hasMoved: false };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: false };
  game.castlingRights.white.queenSide = true;
  game._updateStatus();

  assert.ok(move(game, 'e1', 'c1'), 'queen-side castle should be legal');
  assert.equal(game.board[7][2]?.type, 'king', 'king lands on c1');
  assert.equal(game.board[7][3]?.type, 'rook', 'rook lands on d1');
});

test('castling is forbidden through an attacked square', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: false };
  game.board[7][7] = { type: 'rook', color: 'white', hasMoved: false };
  // Black rook on f8 attacks f1 (the square the king passes through)
  game.board[0][5] = { type: 'rook', color: 'black', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: false };
  game.castlingRights.white.kingSide = true;
  game._updateStatus();

  assert.equal(move(game, 'e1', 'g1'), false, 'cannot castle through check');
});

test('en passant captures the passed pawn', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  game.board[3][4] = { type: 'pawn', color: 'white', hasMoved: true };  // e5
  game.board[1][5] = { type: 'pawn', color: 'black', hasMoved: false }; // f7
  game.currentTurn = 'black';
  game._recordCurrentPosition();
  game._updateStatus();

  assert.ok(move(game, 'f7', 'f5'), 'black double-push sets en passant target');
  assert.ok(move(game, 'e5', 'f6'), 'white captures en passant');
  assert.equal(game.board[2][5]?.type, 'pawn', 'white pawn now on f6');
  assert.equal(game.board[3][5], null, 'captured black pawn removed from f5');
  assert.equal(game.capturedByWhite.length, 1, 'capture is recorded');
});

test('pawn auto-promotes to a queen by default', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[0][0] = { type: 'king', color: 'black', hasMoved: true };
  game.board[1][7] = { type: 'pawn', color: 'white', hasMoved: true }; // h7
  game.currentTurn = 'white';
  game._recordCurrentPosition();
  game._updateStatus();

  const result = move(game, 'h7', 'h8');
  assert.ok(result, 'promotion move is legal');
  assert.equal(game.board[0][7]?.type, 'queen', 'pawn became a queen');
});

test('underpromotion to knight is honoured', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[0][0] = { type: 'king', color: 'black', hasMoved: true };
  game.board[1][7] = { type: 'pawn', color: 'white', hasMoved: true };
  game.currentTurn = 'white';
  game._recordCurrentPosition();
  game._updateStatus();

  assert.ok(move(game, 'h7', 'h8', 'knight'));
  assert.equal(game.board[0][7]?.type, 'knight', 'pawn became a knight');
});

test('a pinned piece cannot expose its king', () => {
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };  // e1
  game.board[6][4] = { type: 'bishop', color: 'white', hasMoved: true }; // e2 (pinned)
  game.board[0][4] = { type: 'rook', color: 'black', hasMoved: true };   // e8 pins along e-file
  game.board[0][0] = { type: 'king', color: 'black', hasMoved: true };
  game.currentTurn = 'white';
  game._recordCurrentPosition();
  game._updateStatus();

  // Bishop on e2 may not leave the e-file — doing so exposes the king.
  assert.equal(move(game, 'e2', 'd3'), false, 'pinned bishop cannot move off the pin');
  assert.equal(game.getLegalMoves(6, 4).length, 0, 'pinned bishop has no legal moves here');
});

test('detects stalemate (no legal move, not in check)', () => {
  const game = emptyGame();
  game.board[0][7] = { type: 'king', color: 'black', hasMoved: true }; // h8
  game.board[2][6] = { type: 'queen', color: 'white', hasMoved: true }; // g6
  game.board[2][5] = { type: 'king', color: 'white', hasMoved: true };  // f6
  game.currentTurn = 'black';
  game._recordCurrentPosition();
  game._updateStatus();

  assert.equal(game.status, 'stalemate');
  assert.equal(game.winner, null);
});

test('reports check without ending the game', () => {
  const game = emptyGame();
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true }; // e8
  game.board[7][4] = { type: 'rook', color: 'white', hasMoved: true }; // e1, open e-file
  game.board[7][0] = { type: 'king', color: 'white', hasMoved: true }; // a1
  game.currentTurn = 'black';
  game._recordCurrentPosition();
  game._updateStatus();

  assert.equal(game.isInCheck('black'), true, 'black king is in check along the e-file');
  assert.equal(game.status, 'check', 'game continues — black can step off the file');
});

test('move notation renders captures and piece letters', () => {
  const game = new ChessGame();
  assert.equal(game.getMoveNotation(6, 4, 4, 4), 'e4', 'pawn push');
  assert.equal(game.getMoveNotation(7, 6, 5, 5), 'Nf3', 'knight move with piece letter');
});

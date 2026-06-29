const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// ai-engine.js references ChessGame (for cloning), so both sources share one VM.
const root = path.join(__dirname, '..', '..');
const engineSource = fs.readFileSync(path.join(root, 'chess-engine.js'), 'utf8');
const aiSource = fs.readFileSync(path.join(root, 'ai-engine.js'), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(
  `${engineSource}\n${aiSource}\nthis.ChessGame = ChessGame; this.ChessAI = ChessAI;`,
  context
);
const { ChessGame, ChessAI } = context;

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

test('getBestMove returns a legal move for the side to move', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  const best = ai.getBestMove(game, 'medium');
  assert.ok(best, 'a move is returned from the opening position');
  const legal = game.getLegalMoves(best.fr, best.fc);
  assert.ok(
    legal.some(m => m.toR === best.toR && m.toC === best.toC),
    'the suggested move is among the legal moves'
  );
});

test('getBestMove returns null when there are no moves (checkmate)', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  // Fool's mate — black has just delivered checkmate; white has no moves.
  const files = 'abcdefgh';
  const mv = (from, to) => game.makeMove(8 - +from[1], files.indexOf(from[0]), 8 - +to[1], files.indexOf(to[0]));
  mv('f2', 'f3'); mv('e7', 'e5'); mv('g2', 'g4'); mv('d8', 'h4');
  assert.equal(game.status, 'checkmate');
  assert.equal(ai.getBestMove(game, 'hard'), null);
});

test('the engine takes a free hanging queen', () => {
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };  // e1
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };  // e8
  game.board[4][3] = { type: 'rook', color: 'white', hasMoved: true };  // d4
  game.board[4][6] = { type: 'queen', color: 'black', hasMoved: true }; // g4 — hanging on the 4th rank
  game.currentTurn = 'white';
  game._recordCurrentPosition();
  game._updateStatus();

  const best = ai.getBestMove(game, 'medium');
  assert.ok(best, 'engine produces a move');
  assert.equal(best.toR, 4, 'capture lands on the 4th rank');
  assert.equal(best.toC, 6, 'engine grabs the undefended queen on g4');
});

test('evaluate is material-symmetric and sign-correct', () => {
  const ai = new ChessAI();
  const even = new ChessGame();
  assert.equal(ai.evaluate(even), 0, 'the starting position is balanced');

  const up = emptyGame();
  up.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  up.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  up.board[4][4] = { type: 'queen', color: 'white', hasMoved: true };
  assert.ok(ai.evaluate(up) > 0, 'an extra white queen favours white (positive score)');
});

test('harder difficulty searches deeper without throwing', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const m = ai.getBestMove(game, difficulty);
    assert.ok(m && Number.isInteger(m.fr), `${difficulty} returns a structured move`);
  }
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// ai-engine.js references ChessGame (for cloning), so both sources share one VM.
const root = path.join(__dirname, '..', '..');
const asClassicScript = source => source
  .replace(/^import\s+[^\n]+$/gm, '')
  .replace(/^export\s+\{[^\n]+$/gm, '');
const engineSource = asClassicScript(fs.readFileSync(path.join(root, 'chess-engine.js'), 'utf8'));
const aiSource = asClassicScript(fs.readFileSync(path.join(root, 'ai-engine.js'), 'utf8'));
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

test('hard search obeys a bounded budget and always keeps a legal fallback', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  const started = Date.now();
  const best = ai.getBestMove(game, 'hard', { timeBudgetMs: 40, maxNodes: 5000 });
  const elapsed = Date.now() - started;

  assert.ok(best, 'bounded search returns a move');
  assert.ok(
    game.getLegalMoves(best.fr, best.fc).some(m => m.toR === best.toR && m.toC === best.toC),
    'bounded fallback remains legal'
  );
  assert.ok(elapsed < 750, `search should not block the event loop indefinitely (took ${elapsed}ms)`);
  assert.ok(ai.lastSearch.nodes <= 5001, `node budget exceeded: ${ai.lastSearch.nodes}`);
});

test('transposition key distinguishes kings and knights', () => {
  const ai = new ChessAI();
  const knight = emptyGame();
  knight.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  knight.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  knight.board[4][4] = { type: 'knight', color: 'white', hasMoved: true };
  const king = emptyGame();
  king.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  king.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  king.board[4][4] = { type: 'king', color: 'white', hasMoved: true };
  assert.notEqual(ai._positionKey(knight, 2, true), ai._positionKey(king, 2, true));
});

test('learned style values are clamped before they bias search', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  const move = { fr: 6, fc: 4, toR: 4, toC: 4 };
  const after = ai._cloneGame(game);
  after.makeMove(move.fr, move.fc, move.toR, move.toC);
  const bias = ai._styleBias(game, after, move, 'white', {
    aggression: 1e9,
    kingAttackFocus: 1e9,
    materialGreed: 1e9,
    riskTolerance: 1e9,
  });
  assert.ok(bias >= 0 && bias <= 4, `untrusted style escaped its unit bounds: ${bias}`);
});

test('quiescence stays off unless a caller asks for it', () => {
  // The browser opponent was tuned without it; only the AMS bots opt in.
  const ai = new ChessAI();
  const game = new ChessGame();
  ai.getBestMove(game, 'medium');
  assert.equal(ai._quiescence, false, 'quiescence must not switch itself on');
  ai.getBestMove(game, 'medium', { quiescence: true });
  assert.equal(ai._quiescence, true);
});

test('quiescence scores a hanging piece the leaf would have missed', () => {
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };  // e1
  game.board[7][3] = { type: 'rook', color: 'white', hasMoved: true };  // d1
  game.board[0][7] = { type: 'king', color: 'black', hasMoved: true };  // h8
  game.board[0][3] = { type: 'queen', color: 'black', hasMoved: true }; // d8 — free, king is far away
  game.currentTurn = 'white';

  const staticScore = ai.evaluate(game);
  ai._deadline = Infinity; ai._maxNodes = Infinity; ai._nodes = 0; ai._timedOut = false;
  const quiesced = ai._quiesce(game, -Infinity, Infinity, true, 4);

  // Static eval sees white down a queen; the capture is one ply away.
  assert.ok(
    quiesced > staticScore + 500,
    `quiescence missed the free queen: static ${staticScore}, quiesced ${quiesced}`
  );
});

test('quiescence never scores below standing pat for the side to move', () => {
  // The side to move is never forced to capture, so resolving the position
  // cannot be worse than simply stopping there.
  const ai = new ChessAI();
  const game = new ChessGame();
  const files = 'abcdefgh';
  const mv = (from, to) => game.makeMove(8 - +from[1], files.indexOf(from[0]), 8 - +to[1], files.indexOf(to[0]));
  mv('e2', 'e4'); mv('d7', 'd5'); mv('g1', 'f3'); mv('b8', 'c6');

  const standPat = ai.evaluate(game);
  ai._deadline = Infinity; ai._maxNodes = Infinity; ai._nodes = 0; ai._timedOut = false;
  const quiesced = ai._quiesce(game, -Infinity, Infinity, game.currentTurn === 'white', 4);
  if (game.currentTurn === 'white') {
    assert.ok(quiesced >= standPat, `white lost ground by resolving captures: ${quiesced} < ${standPat}`);
  } else {
    assert.ok(quiesced <= standPat, `black lost ground by resolving captures: ${quiesced} > ${standPat}`);
  }
});

test('quiescence respects the node ceiling instead of running away', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  ai._deadline = Infinity; ai._maxNodes = 5; ai._nodes = 0; ai._timedOut = false;
  ai._quiesce(game, -Infinity, Infinity, true, 4);
  assert.ok(ai._nodes <= 200, `quiescence ignored its node budget: ${ai._nodes}`);
});

test('the legacy difficulty names keep their old search behaviour', () => {
  // A refactor must not change the opponent Ethan practises against. easy/
  // medium/hard resolve to 1/2/4 ply with quiescence OFF, as before levels.
  const ai = new ChessAI();
  const game = new ChessGame();
  for (const [difficulty, depth] of [['medium', 2], ['hard', 4]]) {
    ai.getBestMove(game, difficulty, { timeBudgetMs: 4000 });
    assert.equal(ai.lastSearch.targetDepth, depth, `${difficulty} target depth`);
    assert.equal(ai.lastSearch.quiescence, false, `${difficulty} must not gain quiescence`);
  }
});

test('a numeric level overrides the difficulty name', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  ai.getBestMove(game, 'easy', { level: 7, timeBudgetMs: 4000 });
  assert.equal(ai.lastSearch.targetDepth, 4, 'level 7 searches 4 ply');
  assert.equal(ai.lastSearch.quiescence, true, 'level 7 carries quiescence');
});

test('a bad level falls back to the name; a too-high one clamps to the top', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  // Above the ladder: clamp, so a trainer overshoot still plays at full strength.
  ai.getBestMove(game, 'medium', { level: 999, timeBudgetMs: 1000 });
  assert.equal(ai.lastSearch.targetDepth, 5, 'level 999 clamps to the top rung');
  // Not a usable level: fall back to the difficulty name rather than silently
  // becoming the weakest possible opponent.
  for (const bad of [-5, 0, NaN, 'abc', null, undefined]) {
    ai.getBestMove(game, 'medium', { level: bad, timeBudgetMs: 1000 });
    assert.equal(ai.lastSearch.targetDepth, 2, `level ${String(bad)} should fall back to medium`);
  }
});

test('a level caps the think time it was designed for', () => {
  // Level 1 is a 200ms rung; handing it 4s must not turn it into a deep search.
  const ai = new ChessAI();
  const game = new ChessGame();
  ai.getBestMove(game, 'medium', { level: 1, timeBudgetMs: 4000 });
  assert.ok(ai.lastSearch.budgetMs <= 200, `budget not capped: ${ai.lastSearch.budgetMs}`);
});

test('the ladder never gets weaker as the level rises', () => {
  const ai = new ChessAI();
  const game = new ChessGame();
  let prevDepth = 0;
  for (let level = 1; level <= 10; level++) {
    ai.getBestMove(game, 'medium', { level, timeBudgetMs: 50 });
    const d = ai.lastSearch.targetDepth;
    assert.ok(d >= prevDepth, `level ${level} target depth ${d} regressed from ${prevDepth}`);
    prevDepth = d;
  }
});

// ── Static Exchange Evaluation ──────────────────────────────────────────────

test('SEE: a clean, undefended capture wins exactly the piece taken', () => {
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };  // e1
  game.board[0][7] = { type: 'king', color: 'black', hasMoved: true };  // h8
  game.board[4][3] = { type: 'pawn', color: 'white', hasMoved: true };  // d4
  game.board[3][4] = { type: 'pawn', color: 'black', hasMoved: true };  // e5, undefended
  const see = ai._see(game, 4, 3, 3, 4, 'white');
  assert.equal(see, 100, `undefended pawn capture: got ${see}`);
});

test('SEE: capturing a defended pawn with the queen is a clear loss', () => {
  // Queen takes d5 pawn; a second black pawn on e6 recaptures. Losing the
  // queen for a pawn must read as strongly negative, not merely "not great".
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };  // e1
  game.board[7][3] = { type: 'queen', color: 'white', hasMoved: true }; // d1
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };  // e8
  game.board[3][3] = { type: 'pawn', color: 'black', hasMoved: true };  // d5, the target
  game.board[2][4] = { type: 'pawn', color: 'black', hasMoved: true };  // e6, defends d5
  const see = ai._see(game, 7, 3, 3, 3, 'white');
  assert.equal(see, -800, `queen for a defended pawn: got ${see}`);
});

test('SEE: knight takes a pawn defended once nets a piece-for-pawn loss', () => {
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  game.board[5][2] = { type: 'knight', color: 'white', hasMoved: true }; // c3
  game.board[3][3] = { type: 'pawn', color: 'black', hasMoved: true };   // d5, target
  game.board[2][4] = { type: 'pawn', color: 'black', hasMoved: true };   // e6, defends d5
  const see = ai._see(game, 5, 2, 3, 3, 'white');
  assert.equal(see, -220, `knight(320) for pawn(100), recaptured: got ${see}`);
});

test('SEE: en passant credits the captured pawn even though the square is empty', () => {
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  game.board[3][3] = { type: 'pawn', color: 'white', hasMoved: true }; // d5
  game.board[3][4] = { type: 'pawn', color: 'black', hasMoved: true }; // e5, captured en passant
  // White plays d5xe6 e.p.: target square (2,4) is empty; the captured pawn
  // is the one sitting on (3,4), one rank behind the target for White.
  const see = ai._see(game, 3, 3, 2, 4, 'white');
  assert.equal(see, 100, `en passant should still win a pawn: got ${see}`);
});

test('SEE: an x-ray attacker revealed mid-exchange changes a loss into a gain', () => {
  // White rook d3 takes a knight on d5 (defended by a bishop on c6). A SECOND
  // white rook sits on d1, directly behind d3 on the same file — blocked
  // today, but the moment the d3 rook moves onto d5, its line to d5 opens.
  // A SEE that does not re-derive attackers from the live board after each
  // capture (i.e. does not naturally x-ray) would stop after the bishop
  // recaptures and call this a losing trade (rook for knight, -180). It is
  // actually a net gain once the hidden rook joins in.
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][7] = { type: 'king', color: 'white', hasMoved: true };  // h1
  game.board[0][7] = { type: 'king', color: 'black', hasMoved: true };  // h8
  game.board[7][3] = { type: 'rook', color: 'white', hasMoved: true };  // d1 (hidden until d3 vacates)
  game.board[5][3] = { type: 'rook', color: 'white', hasMoved: true };  // d3 (first capturer)
  game.board[3][3] = { type: 'knight', color: 'black', hasMoved: true }; // d5 (target)
  game.board[2][2] = { type: 'bishop', color: 'black', hasMoved: true }; // c6 (defends d5)

  const see = ai._see(game, 5, 3, 3, 3, 'white');
  // Knight(320) + Bishop(330) won, Rook(500) given up: (320+330)-500 = 150.
  assert.equal(see, 150, `x-ray reveal not applied: got ${see}`);
});

test('SEE: _captureMoves drops losing exchanges and orders the rest best-first', () => {
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  // A clean pawn capture (SEE +100)...
  game.board[4][3] = { type: 'pawn', color: 'white', hasMoved: true };  // d4
  game.board[3][4] = { type: 'pawn', color: 'black', hasMoved: true };  // e5, undefended
  // ...and a losing queen capture of a defended pawn (SEE -800), offered by
  // the same side so both appear in one _captureMoves call.
  game.board[7][3] = { type: 'queen', color: 'white', hasMoved: true }; // d1
  game.board[3][3] = { type: 'pawn', color: 'black', hasMoved: true };  // d5, target
  game.board[2][4] = { type: 'pawn', color: 'black', hasMoved: true };  // e6, defends d5

  const moves = ai._captureMoves(game, 'white');
  assert.ok(moves.length >= 1, 'the winning capture must survive');
  assert.ok(
    !moves.some(m => m.fr === 7 && m.fc === 3 && m.toR === 3 && m.toC === 3),
    'the losing queen capture must be dropped, not merely deprioritised'
  );
  assert.ok(
    moves.some(m => m.fr === 4 && m.fc === 3 && m.toR === 3 && m.toC === 4),
    'the clean pawn capture must remain'
  );
});

test('SEE: a promoting capture is valued as landing a queen, not a pawn', () => {
  // White pawn captures on the 8th rank and promotes; a black rook then
  // retakes the new queen. Losing "a pawn" for a rook would misprice this as
  // a great trade; losing a QUEEN for a rook is what actually happens.
  const ai = new ChessAI();
  const game = emptyGame();
  game.board[7][4] = { type: 'king', color: 'white', hasMoved: true };
  game.board[0][4] = { type: 'king', color: 'black', hasMoved: true };
  game.board[1][3] = { type: 'pawn', color: 'white', hasMoved: true };  // d7
  game.board[0][2] = { type: 'knight', color: 'black', hasMoved: true }; // c8, target
  game.board[0][0] = { type: 'rook', color: 'black', hasMoved: true };  // a8, defends c8 along the back rank
  const see = ai._see(game, 1, 3, 0, 2, 'white');
  // Wins the knight (320), loses the promoted queen (900) to the rook: -580.
  // A pawn-valued mover would have (wrongly) read this as +220.
  assert.equal(see, -580, `promotion not valued as a queen: got ${see}`);
});

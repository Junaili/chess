const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');

test('bot hard search runs off-thread and returns a legal move', async () => {
  const [{ AISearchPool }, { ChessGame }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'peerjs-bot-spike', 'ai-pool.mjs')).href),
    import(pathToFileURL(path.join(root, 'peerjs-bot-spike', 'engine.mjs')).href),
  ]);
  const pool = new AISearchPool({ queueLimit: 2 });
  const game = new ChessGame();
  try {
    const result = await pool.search(game, 'hard', { timeBudgetMs: 100, maxNodes: 10000 });
    assert.ok(result.move, 'worker returns a move');
    assert.ok(
      game.getLegalMoves(result.move.fr, result.move.fc)
        .some(m => m.toR === result.move.toR && m.toC === result.move.toC),
      'worker move is legal in the source position'
    );
    assert.ok(result.search.nodes <= 10001, `node budget exceeded: ${result.search.nodes}`);
  } finally {
    await pool.close();
  }
});

test('bot AI pool enforces queue capacity', async () => {
  const [{ AISearchPool }, { ChessGame }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'peerjs-bot-spike', 'ai-pool.mjs')).href),
    import(pathToFileURL(path.join(root, 'peerjs-bot-spike', 'engine.mjs')).href),
  ]);
  const pool = new AISearchPool({ queueLimit: 1 });
  // This assertion is about admission control, so give the accepted search
  // enough wall-clock slack to survive unrelated test-file CPU contention.
  const first = pool.search(new ChessGame(), 'hard', { timeBudgetMs: 500, maxNodes: 1000 });
  await assert.rejects(
    pool.search(new ChessGame(), 'hard', { timeBudgetMs: 500, maxNodes: 1000 }),
    /queue is full/
  );
  await first;
  await pool.close();
});

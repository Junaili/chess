'use strict';

// Runs every CPU-heavy chess search away from WKWebView's main thread. The
// worker and both engines are modules, so none of them enter the launch graph.
import { ChessGame } from './chess-engine.js';
import { ChessAI } from './ai-engine.js';

const ai = new ChessAI();

function restoreGame(snapshot) {
  const game = new ChessGame();
  game.board = (snapshot.board || []).map(row => row.map(piece => piece ? { ...piece } : null));
  game.currentTurn = snapshot.currentTurn || 'white';
  game.enPassantTarget = snapshot.enPassantTarget ? { ...snapshot.enPassantTarget } : null;
  game.castlingRights = snapshot.castlingRights
    ? JSON.parse(JSON.stringify(snapshot.castlingRights))
    : game.castlingRights;
  game.moveHistory = Array.isArray(snapshot.moveHistory) ? snapshot.moveHistory.map(move => ({ ...move })) : [];
  game.capturedByWhite = Array.isArray(snapshot.capturedByWhite) ? snapshot.capturedByWhite.map(piece => ({ ...piece })) : [];
  game.capturedByBlack = Array.isArray(snapshot.capturedByBlack) ? snapshot.capturedByBlack.map(piece => ({ ...piece })) : [];
  game.status = snapshot.status || 'playing';
  game.winner = snapshot.winner || null;
  game.halfmoveClock = Number(snapshot.halfmoveClock) || 0;
  game.positionCounts = new Map(Array.isArray(snapshot.positionCounts) ? snapshot.positionCounts : []);
  return game;
}

function scoreForColor(score, color) {
  return color === 'white' ? score : -score;
}

function sameMove(a, b) {
  if (!a || !b) return false;
  return a.fr === b.fr && a.fc === b.fc && a.toR === b.toR && a.toC === b.toC
    && (a.promType || 'queen') === (b.promType || 'queen');
}

function formatPawnLoss(cp) {
  const pawns = Math.max(0, cp) / 100;
  if (pawns < 0.15) return 'about equal';
  if (pawns < 1) return `${pawns.toFixed(1)} pawn`;
  return `${pawns.toFixed(1)} pawns`;
}

function gradePosition(before, played, names = {}, options = {}) {
  const mover = before.currentTurn;
  const promotion = played.promType || 'queen';
  const playedNotation = before.getMoveNotation(played.fr, played.fc, played.toR, played.toC, promotion);
  const best = ai.getBestMove(before, 'medium', {
    timeBudgetMs: Number(options.timeBudgetMs) || 150,
    maxNodes: Number(options.maxNodes) || 25_000,
  });
  if (!best) {
    return {
      grade: 'Forced',
      text: `${playedNotation} was played in a position with no meaningful alternative.`,
      recommendation: '',
      playedNotation,
      bestNotation: '',
      loss: 0,
      playedScore: null,
      bestScore: null,
      preScore: scoreForColor(ai.evaluate(before), mover),
      matchedBest: false,
    };
  }

  const bestNotation = before.getMoveNotation(best.fr, best.fc, best.toR, best.toC, best.promType || 'queen');
  const preScore = scoreForColor(ai.evaluate(before), mover);
  const playedAfter = ai._cloneGame(before);
  playedAfter.makeMove(played.fr, played.fc, played.toR, played.toC, promotion);
  const bestAfter = ai._cloneGame(before);
  bestAfter.makeMove(best.fr, best.fc, best.toR, best.toC, best.promType || 'queen');
  // Candidate scoring is a separate shallow comparison. Do not inherit an
  // expired iterative-deepening deadline from the preferred-move search.
  ai._deadline = Infinity;
  ai._maxNodes = Infinity;
  ai._nodes = 0;
  ai._timedOut = false;
  const opponentIsWhite = mover !== 'white';
  const playedScore = scoreForColor(ai.minimax(playedAfter, 1, -Infinity, Infinity, opponentIsWhite), mover);
  const bestScore = scoreForColor(ai.minimax(bestAfter, 1, -Infinity, Infinity, opponentIsWhite), mover);
  const loss = bestScore - playedScore;
  const matchedBest = sameMove(played, best);
  const moverName = mover === 'white' ? (names.whiteName || 'White') : (names.blackName || 'Black');
  const raw = { playedNotation, bestNotation, loss, playedScore, bestScore, preScore, matchedBest };

  if (matchedBest || loss < 35) {
    return {
      grade: 'Strong move',
      text: `${moverName}'s ${playedNotation} matches the engine's preferred idea.`,
      recommendation: 'No better move found at this depth.',
      ...raw,
    };
  }
  if (loss < 120) {
    return {
      grade: 'Playable',
      text: `${moverName}'s ${playedNotation} is playable, but it gives up ${formatPawnLoss(loss)} compared with the best line.`,
      recommendation: `Consider ${bestNotation} instead.`,
      ...raw,
    };
  }
  return {
    grade: 'Better move available',
    text: `${moverName}'s ${playedNotation} misses a stronger continuation and gives up ${formatPawnLoss(loss)}.`,
    recommendation: `Recommended: ${bestNotation}.`,
    ...raw,
  };
}

function analyzeMatch(payload) {
  const moves = Array.isArray(payload.moves) ? payload.moves : [];
  const game = new ChessGame();
  const grades = [];
  const playerParity = payload.playerColor === 'black' ? 1 : 0;
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index];
    const shouldGrade = payload.scope === 'all' || index % 2 === playerParity;
    if (shouldGrade) {
      const result = gradePosition(game, move, payload.names, payload.options);
      grades.push({ moveIndex: index, mover: game.currentTurn, ...result });
    }
    if (!game.makeMove(move.fr, move.fc, move.toR, move.toC, move.promType || 'queen')) break;
  }
  return grades;
}

self.addEventListener('message', event => {
  const { id, type, payload = {} } = event.data || {};
  if (!id) return;
  try {
    let result;
    if (type === 'best-move') {
      result = ai.getBestMove(restoreGame(payload.position), payload.difficulty || 'medium', payload.options || {});
    } else if (type === 'grade-position') {
      result = gradePosition(restoreGame(payload.position), payload.move, payload.names, payload.options);
    } else if (type === 'analyze-match') {
      result = analyzeMatch(payload);
    } else {
      throw new Error(`Unknown chess worker request: ${type}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
});

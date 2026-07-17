'use strict';

import { ChessGame } from './chess-engine.js';
import { createChessWorkerClient, prefetchAnalysisWorker, serializeGameForWorker } from './src/chess-worker-client.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PIECE_LABELS = {
  king: 'king',
  queen: 'queen',
  rook: 'rook',
  bishop: 'bishop',
  knight: 'knight',
  pawn: 'pawn',
};

// Vector artwork keeps chess pieces independent of system symbol and emoji
// fonts. iOS Simulator runtimes can omit AppleColorEmoji.ttc, causing Unicode
// chess characters to render as boxed question marks.
const PIECE_VECTOR_CONTENT = {
  king: `
    <path class="piece-vector-shape" d="M46 7h8v11h11v8H54v11h-8V26H35v-8h11z"/>
    <path class="piece-vector-shape" d="M36 42c0-8 6-13 14-13s14 5 14 13c0 6-3 10-7 14l7 17H36l7-17c-4-4-7-8-7-14z"/>
    <path class="piece-vector-shape" d="M29 73h42l6 12H23z"/>
    <path class="piece-vector-detail" d="M34 73h32M28 85h44"/>
  `,
  queen: `
    <circle class="piece-vector-shape" cx="24" cy="23" r="6"/>
    <circle class="piece-vector-shape" cx="50" cy="15" r="6"/>
    <circle class="piece-vector-shape" cx="76" cy="23" r="6"/>
    <path class="piece-vector-shape" d="M24 30l12 18 14-25 14 25 12-18-8 39H32z"/>
    <path class="piece-vector-shape" d="M29 69h42l6 16H23z"/>
    <path class="piece-vector-detail" d="M31 61h38M28 77h44"/>
  `,
  rook: `
    <path class="piece-vector-shape" d="M25 14h12v12h10V14h12v12h10V14h12v25H25z"/>
    <path class="piece-vector-shape" d="M34 38h32l5 34H29z"/>
    <path class="piece-vector-shape" d="M25 70h50l7 15H18z"/>
    <path class="piece-vector-detail" d="M30 42h40M25 72h50"/>
  `,
  bishop: `
    <path class="piece-vector-shape" d="M50 10c11 9 18 18 18 29 0 10-6 17-13 23h-10c-7-6-13-13-13-23 0-11 7-20 18-29z"/>
    <path class="piece-vector-detail" d="M58 22L43 46"/>
    <path class="piece-vector-shape" d="M37 59h26l8 14H29z"/>
    <path class="piece-vector-shape" d="M25 72h50l7 13H18z"/>
    <path class="piece-vector-detail" d="M28 73h44"/>
  `,
  knight: `
    <path class="piece-vector-shape" d="M27 74c3-18 10-31 24-42l-9-14c16 1 29 8 36 21-8 2-13 7-16 14l-9-7c-8 7-12 15-13 28h33l8 12H19z"/>
    <circle class="piece-vector-detail-fill" cx="59" cy="31" r="3"/>
    <path class="piece-vector-detail" d="M43 52c8 1 14 4 18 10M28 74h47"/>
  `,
  pawn: `
    <circle class="piece-vector-shape" cx="50" cy="25" r="14"/>
    <path class="piece-vector-shape" d="M39 39h22c-1 13 3 22 10 31H29c7-9 11-18 10-31z"/>
    <path class="piece-vector-shape" d="M25 69h50l7 16H18z"/>
    <path class="piece-vector-detail" d="M28 70h44"/>
  `,
};

function renderChessPieceSVG(type, extraClass = '') {
  const artwork = PIECE_VECTOR_CONTENT[type] || PIECE_VECTOR_CONTENT.pawn;
  return `<svg class="chess-piece-svg${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${artwork}</svg>`;
}

function setChessPieceGraphic(element, type, color, label = '') {
  if (!element) return;
  const renderKey = `${color}:${type}`;
  if (element.dataset.pieceRender !== renderKey) {
    element.innerHTML = renderChessPieceSVG(type);
    element.dataset.pieceRender = renderKey;
  }
  if (element.dataset.pieceType !== type) element.dataset.pieceType = type;
  if (element.dataset.pieceColor !== color) element.dataset.pieceColor = color;
  const accessibleLabel = label || `${color} ${PIECE_LABELS[type] || type}`;
  if (element.getAttribute('aria-label') !== accessibleLabel) {
    element.setAttribute('aria-label', accessibleLabel);
  }
}

function hydrateStaticPieceIcons(root = document) {
  root.querySelectorAll('[data-static-piece]').forEach(element => {
    const type = element.dataset.pieceType || 'pawn';
    const color = element.dataset.pieceColor || 'black';
    element.classList.add(color);
    setChessPieceGraphic(element, type, color, element.getAttribute('aria-label') || '');
  });
}

window.renderChessPieceSVG = renderChessPieceSVG;
window.setChessPieceGraphic = setChessPieceGraphic;

const PIECE_COLORS = {
  white: [
    { name: 'Classic',  hex: '#f5f5f0' },
    { name: 'Sky',      hex: '#87ceeb' },
    { name: 'Mint',     hex: '#98d8b0' },
    { name: 'Rose',     hex: '#f4a0b0' },
    { name: 'Gold',     hex: '#ffd080' },
  ],
  black: [
    { name: 'Obsidian', hex: '#2a2a3a' },
    { name: 'Forest',   hex: '#1a3a1a' },
    { name: 'Crimson',  hex: '#5a1a1a' },
    { name: 'Amethyst', hex: '#3a1a5a' },
    { name: 'Bronze',   hex: '#5a3a10' },
  ]
};

const PING_MS        = 5_000;
const PONG_TIMEOUT   = 16_000;
const MAX_RECONNECTS = 3;

// ─── App State ────────────────────────────────────────────────────────────────

let game = null;
let ai = null;
let aiRuntimePromise = null;

function prepareAIRuntime() {
  if (ai) return Promise.resolve(ai);
  if (!aiRuntimePromise) {
    performance.mark?.('analysis-runtime:start');
    aiRuntimePromise = import('./ai-engine.js').then(({ ChessAI }) => {
      ai = new ChessAI();
      performance.mark?.('analysis-runtime:end');
      try { performance.measure?.('analysis-runtime', 'analysis-runtime:start', 'analysis-runtime:end'); } catch {}
      return ai;
    }).catch(error => {
      aiRuntimePromise = null;
      throw error;
    });
  }
  return aiRuntimePromise;
}

function cloneGameForAnalysis(source) {
  const clone = new ChessGame();
  clone.board = source.cloneBoard();
  clone.currentTurn = source.currentTurn;
  clone.enPassantTarget = source.enPassantTarget ? { ...source.enPassantTarget } : null;
  clone.castlingRights = JSON.parse(JSON.stringify(source.castlingRights));
  clone.moveHistory = source.moveHistory.map(move => ({ ...move }));
  clone.capturedByWhite = source.capturedByWhite.map(piece => ({ ...piece }));
  clone.capturedByBlack = source.capturedByBlack.map(piece => ({ ...piece }));
  clone.status = source.status;
  clone.winner = source.winner;
  clone.halfmoveClock = source.halfmoveClock;
  clone.positionCounts = new Map(source.positionCounts);
  return clone;
}

// Gameplay and long-running reports use separate queues. A five-game coaching
// report can never delay the computer's next move or an explicitly requested hint.
window.chessGameplayWorker ||= createChessWorkerClient();
window.chessBackgroundWorker ||= createChessWorkerClient();
window.serializeGameForWorker = serializeGameForWorker;

// ── Journal practice loop state ──────────────────────────────────────────────
// retryContext: set while playing on from a mid-game position (journal "try
// again" / puzzle drills). judge=true means src/journal.js wants the player's
// first move graded (window.agsJournalJudgeMove).
let retryContext = null;
// Coach Mode (vs computer): grade each of your moves as you play; on a real
// blunder, offer a take-back before the AI replies. Opt-in, persisted.
let coachModeEnabled = localStorage.getItem('chess_coach_mode') === '1';
let coachPromptPending = false;
let playerColor = 'white';
let gameMode = 'computer';   // 'computer' | 'online'
let difficulty = 'medium';
let selectedSquare = null;
let validMoves = [];
let dragging = null;
let pendingPromotion = null;
let suggestedMoveBeforePlay = null;
let selectedPieceColor = null;
let aiThinking = false;
let gameplaySearchGeneration = 0;
let suggestionGeneration = 0;
let suggestionSearch = null;
let contacts = JSON.parse(localStorage.getItem('chess_contacts') || '[]');
let playerName = localStorage.getItem('chess_player_name') || '';
let leaderboard = JSON.parse(localStorage.getItem('chess_leaderboard') || '[]');

window.setPlayerFromAGS = function(name) {
  playerName = name;
  localStorage.setItem('chess_player_name', name);
  const nameInput = document.getElementById('player-name-input');
  if (nameInput) nameInput.value = name;
};

// ─── Online / PeerJS State ────────────────────────────────────────────────────

let peer = null;
let peerConn = null;
let peerLifecycleGeneration = 0;
let peerOpenTimer = null;
let currentInviteLink = '';
let connRole       = null;   // 'host' | 'joiner'
let pingInterval   = null;
let lastPongTime   = 0;
let reconnectTimer = null;
let reconnectCount = 0;
let moveQueue      = [];     // moves queued while connection is down
let moveLog        = [];     // host-only: all moves sent, used for resync
let connectionLost = false;
let rematchPending = false;  // true while waiting for opponent to respond to our rematch request
let matchmakingActive = false;
let matchmakingWaitInterval = null;
let chatMessages   = [];
let chatTransportState = { state: 'idle', detail: '', topicId: '' };
let pendingChatContext = null;
let chatActivationKey = '';
let matchChatFriendState = 'unknown';
let matchChatFriendRequestSent = false;
let matchChatFriendCheckToken = 0;
let currentOpponent = null;
let currentOpponentBlocked = false;
let activeSafetyReport = null;
let pendingFriendMatchInvite = null;
let pendingFriendMatchInviteTimer = null;
let activeFriendInviteId = '';
let matchStartedAt = null;
let matchHistoryRecorded = false;
// Resignation reuses game.status = 'checkmate' (so all the existing win/loss
// UI, sounds, and status-bar logic keep working unmodified) — this flag is the
// only place resignation is distinguished, read once when the match-history
// record is built.
let gameEndedByResignation = false;
// Match resiliency: chess-active-match survives a reload/crash (localStorage,
// not sessionStorage) so a player can resume up to 10 minutes after a
// disconnect. See docs/ags-plans (match resiliency plan) for the full design.
const ACTIVE_MATCH_KEY = 'chess-active-match';
let currentMatchId = null;
// Snapshot of currentMatchId taken at the top of showGameOver(), before
// clearActiveMatch() nulls it out — the High Five button needs a matchId
// after the modal is already showing, when currentMatchId itself is gone.
let lastCompletedMatchId = null;
// Full match-history record built by recordMatchHistoryOnce(), snapshotted
// for the same reason as lastCompletedMatchId above — reviewGameFromGameOver()
// needs moves/myColor/names AFTER destroyPeer() has already nulled `game`.
let lastCompletedMatchRecord = null;
let gameOverCountdownTimer = null;
let gameOverCountdownRemaining = 0;
let boardFlipped = false;
let matchClockTimer = null;
let matchClockLastTick = 0;
let matchClockElapsed = { white: 0, black: 0 };
let homeIdleTimer = null;
let homeIdleShown = false;

function isDrawStatus(status) {
  return status === 'stalemate' || String(status || '').startsWith('draw-');
}

function isGameOverStatus(status) {
  return status === 'checkmate' || isDrawStatus(status);
}

function isGameActiveStatus(status) {
  return status === 'playing' || status === 'check';
}

function getDrawMessage(status) {
  if (status === 'draw-insufficient') return 'Draw by insufficient material.';
  if (status === 'draw-fifty-move') return 'Draw by the fifty-move rule.';
  if (status === 'draw-repetition') return 'Draw by threefold repetition.';
  return 'The game ended in stalemate.';
}

// ─── Audio State ──────────────────────────────────────────────────────────────

let audioCtx = null;

// ─── Video / Voice Chat State ─────────────────────────────────────────────────

let remotePeerId = null;
let localStream  = null;
let mediaCall    = null;
let pendingCall  = null;
let audioEnabled = true;
let camEnabled   = true;
let remoteMediaStream = null;
let videoCallState = 'idle';
let videoCallDirection = '';
let videoCallMonitor = null;
let videoCallTimeout = null;
let videoReconnectTimer = null;
let pendingCallTimeout = null;
let videoReconnectAttempts = 0;
let videoCallGeneration = 0;
let videoCallAttemptStartedAt = 0;
let videoCallStartedAt = 0;
let videoCallLastTelemetryAt = 0;
let videoCallEnding = false;
let callFacingMode = 'user';
let selectedCallAudioDeviceId = '';
let selectedCallVideoDeviceId = '';

const VIDEO_CALL_DEVICE_PREFS_KEY = 'chess-video-call-devices-v1';

// Video calls are friends-only (seeing/hearing a stranger from random
// matchmaking is a child-safety issue). false until AGS confirms mutual
// friendship with the current opponent; gates both the button and incoming
// rings. Checks are tokened because the opponent can change mid-flight
// (rematch, resume, late player_info).
let videoChatAllowed    = false;
let videoChatCheckToken = 0;

function updateVideoChatAvailability() {
  const token = ++videoChatCheckToken;
  videoChatAllowed = false;
  const btn = document.getElementById('btn-video-chat');
  if (btn && !mediaCall) btn.style.display = 'none';
  if (gameMode !== 'online' || !currentOpponent?.userId || currentOpponentBlocked) return;
  if (typeof window.agsIsFriendWith !== 'function') return;
  window.agsIsFriendWith(currentOpponent.userId).then(isFriend => {
    if (token !== videoChatCheckToken || !isFriend) return;
    videoChatAllowed = true;
    if (btn && gameMode === 'online') btn.style.display = '';
  }).catch(() => {});
}

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(name) {
  if (typeof window.agsSyncScreenState === 'function') {
    window.agsSyncScreenState(name);
  } else {
    document.querySelectorAll('.screen').forEach(s => {
      const selected = s.id === 'screen-' + name;
      s.classList.toggle('active', selected);
      s.setAttribute('aria-hidden', String(!selected));
    });
  }
  clearTimeout(homeIdleTimer);
  homeIdleTimer = null;
  if (name === 'home') {
    if (typeof window.agsSetPresence === 'function') {
      window.agsSetPresence('online');
    }
    if (typeof window.agsRefreshLeaderboard === 'function') {
      window.agsRefreshLeaderboard()
    } else {
      renderLeaderboard()
    }
    if (!homeIdleShown) {
      homeIdleTimer = setTimeout(() => {
        homeIdleShown = true;
        const prompt = document.getElementById('home-idle-prompt');
        if (!prompt) return;
        const inviteUrl = window.agsGetInviteUrl?.();
        if (inviteUrl) {
          const rowEl = document.getElementById('home-idle-share-row');
          if (rowEl && !rowEl.querySelector('.share-row') && typeof window.agsShareRow === 'function') {
            window.agsShareRow(rowEl, inviteUrl);
          }
        } else {
          const btn = document.getElementById('home-idle-signup-btn');
          if (btn) btn.style.display = '';
        }
        prompt.style.display = 'block';
      }, 30000);
    }
  }
}

// ─── Home / Setup screens ─────────────────────────────────────────────────────

function showColorSelect(mode) {
  savePlayerName();
  gameMode = mode;
  if (mode === 'computer') prefetchAnalysisWorker();
  if (mode === 'online') {
    // Hide the lazy PeerJS download behind the color/piece-selection steps.
    if (!document.querySelector('link[data-peer-preconnect]')) {
      const preconnect = document.createElement('link');
      preconnect.rel = 'preconnect';
      preconnect.href = 'https://0.peerjs.com';
      preconnect.crossOrigin = 'anonymous';
      preconnect.dataset.peerPreconnect = '1';
      document.head.appendChild(preconnect);
    }
    void window.agsPrepareRealtimeRuntime?.().catch(error => {
      console.warn('Could not prewarm online play:', error?.message || error);
    });
  }
  selectedPieceColor = null;
  document.documentElement.style.removeProperty('--white-piece-color');
  document.documentElement.style.removeProperty('--black-piece-color');
  showScreen('color-select');
}

function selectColor(color) {
  playerColor = color;
  showPieceColorSelect();
}

function showPieceColorSelect() {
  const colors = PIECE_COLORS[playerColor];
  const sub = document.getElementById('piece-color-sub');
  sub.textContent = playerColor === 'white'
    ? 'Pick a light shade for your pieces'
    : 'Pick a dark shade for your pieces';

  const squareBg   = playerColor === 'white' ? '#b58863' : '#f0d9b5';
  const isCustom   = selectedPieceColor && !colors.some(c => c.hex === selectedPieceColor);

  const container = document.getElementById('piece-color-options');
  container.innerHTML = '';

  colors.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'piece-color-btn' + (selectedPieceColor === c.hex ? ' selected' : '');
    btn.innerHTML =
      '<span class="color-swatch-bg" style="background:' + squareBg + '">' +
        '<span class="color-swatch-piece ' + playerColor + '" style="color:' + c.hex + '">' + renderChessPieceSVG('king') + '</span>' +
      '</span>' +
      '<span class="piece-color-name">' + c.name + '</span>';
    btn.setAttribute('aria-label', `${c.name} ${playerColor} pieces`);
    btn.onclick = () => selectPieceColor(c.hex);
    container.appendChild(btn);
  });

  // Custom color button
  const customBtn = document.createElement('button');
  customBtn.className = 'piece-color-btn' + (isCustom ? ' selected' : '');
  if (isCustom) {
    customBtn.innerHTML =
      '<span class="color-swatch-bg" style="background:' + squareBg + '">' +
        '<span class="color-swatch-piece ' + playerColor + '" style="color:' + selectedPieceColor + '">' + renderChessPieceSVG('king') + '</span>' +
      '</span>' +
      '<span class="piece-color-name">Custom</span>';
  } else {
    customBtn.innerHTML =
      '<span class="color-swatch-bg custom-swatch-gradient">' +
        '<span class="custom-swatch-plus">+</span>' +
      '</span>' +
      '<span class="piece-color-name">Custom</span>';
  }
  customBtn.onclick = () => openCustomColorPicker();
  container.appendChild(customBtn);

  showScreen('piece-color');
}

function openCustomColorPicker() {
  let picker = document.getElementById('custom-color-picker');
  if (!picker) {
    picker = document.createElement('input');
    picker.type  = 'color';
    picker.id    = 'custom-color-picker';
    picker.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:0;height:0';
    document.body.appendChild(picker);
  }
  picker.value = selectedPieceColor || (playerColor === 'white' ? '#ffffff' : '#111111');
  picker.onchange = e => selectPieceColor(e.target.value);
  picker.click();
}

function selectPieceColor(hex) {
  selectedPieceColor = hex;
  document.documentElement.style.setProperty(
    playerColor === 'white' ? '--white-piece-color' : '--black-piece-color',
    hex
  );
  if (gameMode === 'computer') {
    showScreen('difficulty');
  } else if (gameMode === 'online') {
    void createOnlineRoom();
  }
}

function startVsComputer(diff) {
  difficulty = diff;
  startGame();
}

// ─── Game init ────────────────────────────────────────────────────────────────

function setPlayerInfo(color, name, userId) {
  const nameEl = document.getElementById(color + '-player-name');
  const idEl   = document.getElementById(color + '-player-id');
  if (nameEl) nameEl.textContent = name;
  if (idEl)   idEl.textContent   = '';
  if (userId) loadPlayerStats(color, userId);
}

async function loadPlayerStats(color, userId) {
  const idEl = document.getElementById(color + '-player-id');
  if (!idEl || !userId) return;
  if (typeof window.agsGetStats !== 'function') return;
  idEl.textContent = '…';
  const stats = await window.agsGetStats(userId);
  if (idEl !== document.getElementById(color + '-player-id')) return; // guard stale update
  idEl.textContent = stats ? `W ${stats.wins}  ·  L ${stats.losses}` : '';
}

function setCurrentOpponent(name, userId) {
  currentOpponent = userId ? { name: name || 'Opponent', userId } : null;
  currentOpponentBlocked = !!(userId && window.agsIsBlockedPlayer?.(userId));
  window.agsLastOpponent = currentOpponent;
  // Opponent identity drives the friends-only video chat gate; re-check on
  // every change (the host learns who it's playing only when player_info
  // arrives, after startGame()).
  updateVideoChatAvailability();
}

// Test seam (mirrors setCurrentOpponent above — this file is a plain
// script, not a module, so there's no import.meta.env.DEV gate available;
// e2e specs set match/opponent state directly the same way production code
// does, via these exported setters, not by poking module-scoped `let`s).
function setCurrentMatchIdForTesting(id) {
  currentMatchId = id;
}

function setGameModeForTesting(mode) {
  gameMode = mode;
}

function setPeerConnForTesting(fakeConn) {
  peerConn = fakeConn;
}

// Mirrors exactly what resignGame() does to `game` internally — `game` is a
// module-scoped `let`, not reachable as window.game from a test.
function forceGameOverStateForTesting(status, winner) {
  if (!game) return;
  game.status = status;
  game.winner = winner;
}

function startGame() {
  gameplaySearchGeneration++;
  suggestionGeneration++;
  if (typeof window.agsSetPresence === 'function') {
    window.agsSetPresence('in-match');
  }
  if (typeof window.agsSendEvent === 'function') {
    window.agsSendEvent('game_started', {
      mode: gameMode,
      color: playerColor,
      ...(gameMode === 'computer' ? { difficulty } : {}),
    });
  }
  matchStartedAt = new Date();
  matchHistoryRecorded = false;
  gameEndedByResignation = false;
  retryContext = null;
  hideCoachPrompt();
  updateCoachModeButton();
  boardFlipped = playerColor === 'black';
  resetMatchClocks();
  game = new ChessGame();
  selectedSquare = null;
  validMoves = [];
  dragging = null;
  pendingPromotion = null;
  suggestedMoveBeforePlay = null;
  suggestionSearch = null;
  aiThinking = false;

  document.getElementById('hint-box').style.display = 'none';
  document.getElementById('btn-hint-back-to-journal').style.display = 'none';
  document.getElementById('move-list').innerHTML = '';
  document.getElementById('captured-by-white').innerHTML = '';
  document.getElementById('captured-by-black').innerHTML = '';
  document.getElementById('black-score').textContent = 'Even';
  document.getElementById('white-score').textContent = 'Even';
  resetChatState();

  const isOnline = gameMode === 'online';
  const myName = document.getElementById('ags-signedin-name')?.textContent || playerName || 'You';
  const myId   = window.agsCurrentUserId || '';

  if (isOnline) {
    setPlayerInfo(playerColor, myName, myId);
    if (currentOpponent) {
      setPlayerInfo(playerColor === 'white' ? 'black' : 'white', currentOpponent.name, currentOpponent.userId);
      saveActiveMatch(); // no-ops if already saved, or if the host doesn't know the opponent yet
    } else {
      setPlayerInfo(playerColor === 'white' ? 'black' : 'white', 'Opponent', '');
    }
  } else if (gameMode === 'computer') {
    setCurrentOpponent('', '');
    setPlayerInfo(playerColor, myName, myId);
    setPlayerInfo(playerColor === 'white' ? 'black' : 'white', 'Computer AI', '');
  } else {
    setPlayerInfo('white', 'White', '');
    setPlayerInfo('black', 'Black', '');
  }

  // Hide hint button during online games. Video chat is friends-only: the
  // button stays hidden until updateVideoChatAvailability() confirms mutual
  // friendship with this opponent.
  document.getElementById('btn-hint').style.display = isOnline ? 'none' : '';
  document.getElementById('btn-video-chat').style.display = 'none';
  updateVideoChatAvailability();
  // New Game + Resign apply to vs-computer play
  const showVsComputerControls = gameMode === 'computer';
  const ngBtn = document.getElementById('btn-new-game');
  const rsBtn = document.getElementById('btn-resign');
  if (ngBtn) ngBtn.style.display = showVsComputerControls ? '' : 'none';
  if (rsBtn) rsBtn.style.display = showVsComputerControls ? '' : 'none';
  document.getElementById('online-chat').style.display = isOnline ? 'flex' : 'none';
  document.getElementById('match-chat-unavailable').style.display = isOnline ? 'none' : '';
  if (!isOnline) {
    matchChatFriendState = 'unknown';
    hideMatchChatGate();
  }
  document.getElementById('match-chat-tab').style.display = isOnline ? '' : 'none';
  document.getElementById('btn-match-safety').style.display = isOnline ? '' : 'none';
  showMatchTab('moves');
  arrangePlayerStrips();
  updateChatAvailability();
  if (isOnline) refreshMatchChatFriendGate();

  showScreen('game');
  renderBoard();
  updateStatus();
  startMatchClocks();

  if (gameMode === 'computer' && playerColor === 'black') {
    scheduleAIMove();
  } else if (gameMode === 'computer') {
    primeSuggestedMove();
  }
}

function startNewGame() {
  closeModal('game-over-modal');
  destroyPeer();
  showScreen('home');
}

function playAgainFromGameOver() {
  closeModal('game-over-modal');
  startGame();
}

// ─── Board rendering ──────────────────────────────────────────────────────────

function initBoard() {
  const boardEl = document.getElementById('chess-board');
  const previousFocus = boardEl.querySelector('.square[tabindex="0"]');
  const previousFocusKey = previousFocus ? `${previousFocus.dataset.r}:${previousFocus.dataset.c}` : '';
  boardEl.innerHTML = '';
  delete boardEl.dataset.arrowKey;
  const flipped = boardFlipped;
  boardEl.dataset.flipped = flipped;

  for (let ri = 0; ri < 8; ri++) {
    for (let ci = 0; ci < 8; ci++) {
      const r = flipped ? 7 - ri : ri;
      const c = flipped ? 7 - ci : ci;

      const sq = document.createElement('button');
      sq.type = 'button';
      sq.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      sq.dataset.r = r;
      sq.dataset.c = c;
      sq.setAttribute('role', 'gridcell');
      sq.setAttribute('aria-rowindex', String(ri + 1));
      sq.setAttribute('aria-colindex', String(ci + 1));
      sq.tabIndex = previousFocusKey
        ? (previousFocusKey === `${r}:${c}` ? 0 : -1)
        : (ri === 0 && ci === 0 ? 0 : -1);
      addCoordinateLabels(sq, r, c, ri, ci);
      sq.addEventListener('click', () => {
        boardEl.querySelector('.square[tabindex="0"]')?.setAttribute('tabindex', '-1');
        sq.tabIndex = 0;
        onSquareClick(r, c);
      });
      sq.addEventListener('keydown', event => moveBoardFocus(event, sq));
      sq.addEventListener('dragover', e => e.preventDefault());
      sq.addEventListener('drop', e => onDrop(e, r, c));
      boardEl.appendChild(sq);
    }
  }
}

function moveBoardFocus(event, currentSquare) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const boardEl = currentSquare.closest('.chess-board');
  const squares = [...boardEl.querySelectorAll('.square')];
  const index = squares.indexOf(currentSquare);
  if (index < 0) return;

  let nextIndex = index;
  if (event.key === 'ArrowLeft') nextIndex = Math.max(0, index - 1);
  if (event.key === 'ArrowRight') nextIndex = Math.min(63, index + 1);
  if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 8);
  if (event.key === 'ArrowDown') nextIndex = Math.min(63, index + 8);
  if (event.key === 'Home') nextIndex = Math.floor(index / 8) * 8;
  if (event.key === 'End') nextIndex = Math.floor(index / 8) * 8 + 7;
  event.preventDefault();
  if (nextIndex === index) return;
  currentSquare.tabIndex = -1;
  squares[nextIndex].tabIndex = 0;
  squares[nextIndex].focus();
}

function renderBoard() {
  const boardEl = document.getElementById('chess-board');
  const flipped = boardFlipped;

  // Rebuild DOM only when orientation changes or board is not yet initialized
  if (boardEl.children.length !== 64 || boardEl.dataset.flipped !== String(flipped)) {
    initBoard();
  }

  const last = game.moveHistory.length > 0 ? game.moveHistory[game.moveHistory.length - 1] : null;
  const validTargets = new Set(validMoves.map(move => move.toR * 8 + move.toC));
  let checkKing = null;
  if (game.status === 'check' || game.status === 'checkmate') {
    checkKing = game.findKing(game.currentTurn);
  }

  const squares = boardEl.children;
  for (let i = 0; i < 64; i++) {
    const sq = squares[i];
    const r = +sq.dataset.r;
    const c = +sq.dataset.c;

    const isSelected  = selectedSquare?.r === r && selectedSquare?.c === c;
    const isValid     = validTargets.has(r * 8 + c);
    const isLastFrom  = !!last && last.fr === r && last.fc === c;
    const isLastTo    = !!last && last.toR === r && last.toC === c;
    const isInCheck   = !!checkKing && checkKing.r === r && checkKing.c === c;

    const visualState = `${+isSelected}${+isValid}${+isLastFrom}${+isLastTo}${+isInCheck}`;
    if (sq.dataset.visualState !== visualState) {
      sq.dataset.visualState = visualState;
      sq.classList.toggle('selected',       isSelected);
      sq.classList.toggle('valid-move',     isValid);
      sq.classList.toggle('last-move',      isLastFrom || isLastTo);
      sq.classList.toggle('last-move-from', isLastFrom);
      sq.classList.toggle('last-move-to',   isLastTo);
      sq.classList.toggle('in-check',       isInCheck);
    }

    const piece = game.board[r][c];
    let pieceEl = sq._pieceElement || null;
    if (piece) {
      if (!pieceEl) {
        pieceEl = document.createElement('div');
        pieceEl.draggable = true;
        pieceEl.addEventListener('dragstart', e => onDragStart(e, r, c));
        sq.appendChild(pieceEl);
        sq._pieceElement = pieceEl;
      }
      const className = 'piece ' + piece.color;
      if (pieceEl.className !== className) pieceEl.className = className;
      setChessPieceGraphic(
        pieceEl,
        piece.type,
        piece.color,
        `${piece.color} ${PIECE_LABELS[piece.type]} on ${game.toAlgebraic(r, c)}`
      );
    } else if (pieceEl) {
      pieceEl.remove();
      sq._pieceElement = null;
    }

    const coordinate = game.toAlgebraic(r, c);
    const squareContents = piece
      ? `${piece.color} ${PIECE_LABELS[piece.type]}`
      : 'empty';
    const state = [
      isSelected ? 'selected' : '',
      isValid ? 'legal move' : '',
      isLastFrom ? 'last move from here' : '',
      isLastTo ? 'last move to here' : '',
      isInCheck ? 'in check' : '',
    ].filter(Boolean);
    sq.setAttribute('aria-label', `${coordinate}, ${squareContents}${state.length ? `, ${state.join(', ')}` : ''}`);
    sq.setAttribute('aria-selected', String(isSelected));
    const boardInteractive = isPlayerTurn() && !aiThinking && !pendingPromotion && !connectionLost &&
      !isGameOverStatus(game.status);
    sq.setAttribute('aria-disabled', String(!boardInteractive));
  }

  renderLastMoveArrow(boardEl, flipped);
}

function addCoordinateLabels(squareEl, r, c, displayRow, displayCol) {
  if (displayCol === 0) {
    const rank = document.createElement('span');
    rank.className = 'coord-label coord-rank';
    rank.textContent = String(8 - r);
    squareEl.appendChild(rank);
  }
  if (displayRow === 7) {
    const file = document.createElement('span');
    file.className = 'coord-label coord-file';
    file.textContent = 'abcdefgh'[c];
    squareEl.appendChild(file);
  }
}

function renderLastMoveArrow(boardEl, flipped) {
  if (!game?.moveHistory.length) {
    boardEl.querySelector('.last-move-arrow')?.remove();
    delete boardEl.dataset.arrowKey;
    return;
  }

  const last = game.moveHistory[game.moveHistory.length - 1];
  const arrowKey = `${+flipped}:${last.fr}:${last.fc}:${last.toR}:${last.toC}`;
  if (boardEl.dataset.arrowKey === arrowKey && boardEl.querySelector('.last-move-arrow')) return;
  boardEl.querySelector('.last-move-arrow')?.remove();
  boardEl.dataset.arrowKey = arrowKey;
  const fromCol = flipped ? 7 - last.fc : last.fc;
  const fromRow = flipped ? 7 - last.fr : last.fr;
  const toCol = flipped ? 7 - last.toC : last.toC;
  const toRow = flipped ? 7 - last.toR : last.toR;
  const dx = toCol - fromCol;
  const dy = toRow - fromRow;
  const length = Math.hypot(dx, dy);
  if (!length) return;

  const arrow = document.createElement('div');
  arrow.className = 'last-move-arrow';
  arrow.style.left = `${fromCol * 12.5 + 6.25}%`;
  arrow.style.top = `${fromRow * 12.5 + 6.25}%`;
  arrow.style.width = `${length * 12.5}%`;
  arrow.style.transform = `translateY(-50%) rotate(${Math.atan2(dy, dx)}rad)`;
  boardEl.appendChild(arrow);
}

// ─── Input handling ───────────────────────────────────────────────────────────

function isPlayerTurn() {
  return game.currentTurn === playerColor;
}

function onSquareClick(r, c) {
  if (!isPlayerTurn() || aiThinking || pendingPromotion || connectionLost) return;
  if (isGameOverStatus(game.status)) return;

  const piece = game.board[r][c];

  if (selectedSquare) {
    const move = validMoves.find(m => m.toR === r && m.toC === c);
    if (move) { tryMove(selectedSquare.r, selectedSquare.c, r, c, move); return; }
    if (piece && piece.color === game.currentTurn) { selectSquare(r, c); return; }
    selectedSquare = null;
    validMoves = [];
    renderBoard();
    return;
  }

  if (piece && piece.color === game.currentTurn) selectSquare(r, c);
}

function selectSquare(r, c) {
  if (!suggestedMoveBeforePlay && gameMode !== 'online') primeSuggestedMove();
  selectedSquare = { r, c };
  validMoves = game.getLegalMoves(r, c);
  renderBoard();
}

function onDragStart(e, r, c) {
  if (!isPlayerTurn() || aiThinking || pendingPromotion || connectionLost) { e.preventDefault(); return; }
  const piece = game.board[r][c];
  if (!piece || piece.color !== game.currentTurn) { e.preventDefault(); return; }
  if (!suggestedMoveBeforePlay && gameMode !== 'online') primeSuggestedMove();
  dragging = { r, c };
  selectedSquare = { r, c };
  validMoves = game.getLegalMoves(r, c);
  renderBoard();
}

function onDrop(e, r, c) {
  e.preventDefault();
  if (!dragging) return;
  const move = validMoves.find(m => m.toR === r && m.toC === c);
  if (move) tryMove(dragging.r, dragging.c, r, c, move);
  dragging = null;
}

function tryMove(fr, fc, toR, toC, move) {
  const piece = game.board[fr][fc];
  if (piece.type === 'pawn' && (toR === 0 || toR === 7)) {
    pendingPromotion = { fr, fc, toR, toC };
    showPromotionModal(piece.color);
    return;
  }
  executeMove(fr, fc, toR, toC, 'queen');
}

function executeMove(fr, fc, toR, toC, promType) {
  const notation = game.getMoveNotation(fr, fc, toR, toC, promType);
  const capturesBefore = game.capturedByWhite.length + game.capturedByBlack.length;
  const movingColor = game.board[fr][fc]?.color;
  // Journal drills grade the player's first move; Coach Mode grades every
  // player move. Both need the position BEFORE the move — clone it now.
  const wantsJudge = gameMode === 'computer' && movingColor === playerColor
    && retryContext?.judge && !retryContext.judged
    && typeof window.agsJournalJudgeMove === 'function';
  const wantsCoach = gameMode === 'computer' && movingColor === playerColor
    && coachModeEnabled && !retryContext
    && typeof window.agsGradeMoveInPosition === 'function';
  const positionBefore = (wantsJudge || wantsCoach) ? cloneGameForAnalysis(game) : null;
  if (!game.makeMove(fr, fc, toR, toC, promType)) return;
  if (game.capturedByWhite.length + game.capturedByBlack.length > capturesBefore) {
    movingColor !== playerColor ? playDunDunDun() : playCapture();
  }

  selectedSquare = null;
  validMoves = [];

  // Relay to opponent
  if (gameMode === 'online') {
    const msg = { type: 'move', fr, fc, toR, toC, promType };
    if (connRole === 'host') {
      moveLog.push(msg);
      if (moveLog.length > 500) moveLog = moveLog.slice(-500);
    }
    sendOrQueue(msg);
  }

  addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
  updateCapturedPieces();
  updateStatus({ notation, actor: getMoveActor(movingColor, true) });
  renderBoard();
  showMoveHint(fr, fc, toR, toC);
  suggestedMoveBeforePlay = null;
  if (gameMode === 'online') window.agsPublishLiveMove?.()

  if (isGameOverStatus(game.status)) {
    setTimeout(showGameOver, 600);
    return;
  }

  // Move grading is CPU-heavy engine work. It returns a Promise in production
  // (worker-backed), but Promise.resolve preserves the synchronous e2e seam.
  // Hold the computer's reply until the verdict arrives so Coach Mode can still
  // offer a take-back before the position advances.
  if ((wantsJudge || wantsCoach) && positionBefore) {
    const gameAtRequest = game;
    const plyAtRequest = game.moveHistory.length;
    const playedMove = { fr, fc, toR, toC, promType };
    if (wantsJudge) retryContext.judged = true;
    document.getElementById('turn-indicator').textContent = 'Reviewing your move…';
    const grading = wantsJudge
      ? window.agsJournalJudgeMove(positionBefore, playedMove)
      : window.agsGradeMoveInPosition(positionBefore, playedMove);
    void Promise.resolve(grading).then(review => {
      if (game !== gameAtRequest || game.moveHistory.length !== plyAtRequest) return;
      if (wantsJudge && review) {
        document.getElementById('hint-text').textContent = review.text;
        document.getElementById('hint-box').style.display = 'flex';
        // Optional explicit return to Journal after the judged move
        // (dev-plan §12.5) — the player can also just keep playing normally.
        const backBtn = document.getElementById('btn-hint-back-to-journal');
        if (backBtn) backBtn.style.display = typeof window.agsOpenJournal === 'function' ? '' : 'none';
      }
      if (wantsCoach && review?.grade === 'Better move available') {
        coachPromptPending = true;
        const loss = Math.abs(review.loss || 0);
        const pawns = (loss / 100).toFixed(1);
        document.getElementById('coach-prompt-text').textContent = loss >= 5000
          ? `Careful — ${review.playedNotation} loses the game on the spot. Want another look?`
          : `Hmm — ${review.playedNotation} gives up about ${pawns} pawn${pawns === '1.0' ? '' : 's'}. Want another look?`;
        document.getElementById('coach-prompt').style.display = 'flex';
        return;
      }
      updateStatus();
      if (gameMode === 'computer' && game.currentTurn !== playerColor) scheduleAIMove();
    }).catch(error => {
      console.warn('[analysis] move grading failed:', error?.message || error);
      if (game !== gameAtRequest || game.moveHistory.length !== plyAtRequest) return;
      updateStatus();
      if (gameMode === 'computer' && game.currentTurn !== playerColor) scheduleAIMove();
    });
    return;
  }

  if (gameMode === 'computer' && game.currentTurn !== playerColor)
    scheduleAIMove();
  else if (gameMode === 'computer')
    primeSuggestedMove();
}

// Apply a move received from the online opponent
function applyOpponentMove(fr, fc, toR, toC, promType = 'queen') {
  const notation = game.getMoveNotation(fr, fc, toR, toC, promType);
  const capturesBefore = game.capturedByWhite.length + game.capturedByBlack.length;
  if (!game.makeMove(fr, fc, toR, toC, promType)) return;
  if (game.capturedByWhite.length + game.capturedByBlack.length > capturesBefore) playDunDunDun();

  selectedSquare = null;
  validMoves = [];
  addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
  updateCapturedPieces();
  updateStatus({ notation, actor: getMoveActor(game.currentTurn === 'white' ? 'black' : 'white', false) });
  renderBoard();
  window.agsPublishLiveMove?.()

  if (isGameOverStatus(game.status))
    setTimeout(showGameOver, 600);
}

// ─── Audio ────────────────────────────────────────────────────────────────────

function playCapture() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const ctx = audioCtx;
    const t = ctx.currentTime;

    // Wooden thud: triangle oscillator with fast pitch drop
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.08);
    oscGain.gain.setValueAtTime(0.55, t);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.18);

    // Snap transient: filtered noise burst
    const snapLen = Math.floor(ctx.sampleRate * 0.035);
    const snapBuf = ctx.createBuffer(1, snapLen, ctx.sampleRate);
    const snapData = snapBuf.getChannelData(0);
    for (let i = 0; i < snapLen; i++) {
      snapData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / snapLen, 4);
    }
    const snap = ctx.createBufferSource();
    snap.buffer = snapBuf;
    const snapFilter = ctx.createBiquadFilter();
    snapFilter.type = 'highpass';
    snapFilter.frequency.value = 800;
    const snapGain = ctx.createGain();
    snapGain.gain.setValueAtTime(0.4, t);
    snap.connect(snapFilter);
    snapFilter.connect(snapGain);
    snapGain.connect(ctx.destination);
    snap.start(t);
  } catch (e) { /* audio not available */ }
}

function playDunDunDun() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;

    const go = () => {
      const t = ctx.currentTime;

      const dun = (freq, start, dur, vol) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.8, start + dur);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(vol, start + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.05);
      };

      dun(220, t,        0.35, 1.4);  // Dun
      dun(220, t + 0.42, 0.35, 1.4);  // Dun
      dun(165, t + 0.84, 0.75, 1.8);  // Duuun (lower, louder, longer)
    };

    if (ctx.state === 'suspended') { ctx.resume().then(go); } else { go(); }
  } catch (e) { /* audio not available */ }
}

// ─── AI ───────────────────────────────────────────────────────────────────────

async function requestBestMove(source, requestedDifficulty, options) {
  try {
    return await window.chessGameplayWorker.bestMove(source, requestedDifficulty, options);
  } catch (error) {
    console.warn('[analysis] worker search unavailable; using bounded fallback:', error?.message || error);
    const fallbackAI = await prepareAIRuntime();
    return fallbackAI.getBestMove(source, requestedDifficulty, options);
  }
}

function primeSuggestedMove() {
  if (!game || gameMode === 'online' || game.currentTurn !== playerColor || isGameOverStatus(game.status)) return;
  const gameAtRequest = game;
  const plyAtRequest = game.moveHistory.length;
  if (suggestionSearch?.game === gameAtRequest && suggestionSearch.ply === plyAtRequest) return;
  const generation = ++suggestionGeneration;
  const request = requestBestMove(game, 'medium', { timeBudgetMs: 120, maxNodes: 20_000 });
  suggestionSearch = { game: gameAtRequest, ply: plyAtRequest, request };
  void request.then(move => {
    if (generation !== suggestionGeneration || game !== gameAtRequest) return;
    if (game.moveHistory.length !== plyAtRequest || game.currentTurn !== playerColor) return;
    suggestedMoveBeforePlay = move;
  }).catch(error => {
    console.warn('[analysis] suggestion search failed:', error?.message || error);
  }).finally(() => {
    if (suggestionSearch?.request === request) suggestionSearch = null;
  });
}

async function scheduleAIMove() {
  const generation = ++gameplaySearchGeneration;
  const gameAtRequest = game;
  const plyAtRequest = game?.moveHistory.length;
  aiThinking = true;
  document.getElementById('turn-indicator').textContent = 'Computer is thinking…';
  const budgets = difficulty === 'hard'
    ? { timeBudgetMs: 350, maxNodes: 50_000 }
    : difficulty === 'easy'
      ? { timeBudgetMs: 50, maxNodes: 5_000 }
      : { timeBudgetMs: 120, maxNodes: 20_000 };
  let move;
  try {
    move = await requestBestMove(game, difficulty, budgets);
  } catch (error) {
    console.warn('[analysis] computer search failed:', error?.message || error);
    if (generation === gameplaySearchGeneration && game === gameAtRequest) {
      aiThinking = false;
      updateStatus();
    }
    return;
  }
  if (generation !== gameplaySearchGeneration || game !== gameAtRequest) return;
  if (game.moveHistory.length !== plyAtRequest || game.currentTurn === playerColor) return;
  aiThinking = false;
  if (move) executeMove(move.fr, move.fc, move.toR, move.toC, move.promType || 'queen');
}

// ─── Move hints ───────────────────────────────────────────────────────────────

function showMoveHint(fr, fc, toR, toC) {
  const hintBox = document.getElementById('hint-box');
  if (!suggestedMoveBeforePlay || gameMode === 'online') {
    hintBox.style.display = 'none';
    return;
  }
  const s = suggestedMoveBeforePlay;
  const same = s.fr === fr && s.fc === fc && s.toR === toR && s.toC === toC;
  const cols = 'abcdefgh', rows = '87654321';
  document.getElementById('hint-text').textContent = same
    ? 'Great move! That was the best play.'
    : `A stronger move would have been ${cols[s.fc]}${rows[s.fr]}–${cols[s.toC]}${rows[s.toR]}.`;
  hintBox.style.display = 'flex';
}

async function showHint() {
  if (!game || !isPlayerTurn() || aiThinking || gameMode === 'online') return;
  const gameAtRequest = game;
  const plyAtRequest = game.moveHistory.length;
  const hintText = document.getElementById('hint-text');
  const hintBox = document.getElementById('hint-box');
  hintText.textContent = 'Finding a helpful move…';
  hintBox.style.display = 'flex';
  const best = suggestedMoveBeforePlay || await requestBestMove(game, 'medium', {
    timeBudgetMs: 150,
    maxNodes: 25_000,
  });
  if (game !== gameAtRequest || game.moveHistory.length !== plyAtRequest || !isPlayerTurn()) return;
  if (!best) {
    hintText.textContent = 'No helpful move is available in this position.';
    return;
  }
  if (typeof window.agsSendEvent === 'function') window.agsSendEvent('hint_used', {});
  const cols = 'abcdefgh', rows = '87654321';
  const piece = game.board[best.fr][best.fc];
  hintText.textContent =
    `Try ${PIECE_LABELS[piece.type]} ${cols[best.fc]}${rows[best.fr]} → ${cols[best.toC]}${rows[best.toR]}`;
  hintBox.style.display = 'flex';
  selectedSquare = { r: best.fr, c: best.fc };
  validMoves = [{ toR: best.toR, toC: best.toC }];
  renderBoard();
  setTimeout(() => { selectedSquare = null; validMoves = []; renderBoard(); }, 2000);
}

// ─── Journal practice loop: retry-from-position, drills, Coach Mode ──────────

// Rebuilds the live game (board, move list, captured pieces) from a move
// prefix — the same pattern the online match-resume flow uses.
function rebuildBoardFromMoves(moves) {
  game = new ChessGame();
  selectedSquare = null;
  validMoves = [];
  dragging = null;
  pendingPromotion = null;
  suggestedMoveBeforePlay = null;
  document.getElementById('move-list').innerHTML = '';
  document.getElementById('captured-by-white').innerHTML = '';
  document.getElementById('captured-by-black').innerHTML = '';
  for (const m of moves) {
    const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
    if (!game.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen')) return false;
    addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
  }
  updateCapturedPieces();
  updateStatus();
  renderBoard();
  return true;
}

// Enters a vs-computer game that starts mid-position: the recorded game's
// moves are replayed through uptoPly (exclusive), then the player plays on as
// their original color. Used by the journal's "Try again" and puzzle drills
// (options.judge asks for the first move to be graded via agsJournalJudgeMove).
function startRetryFromPosition(moves, uptoPly, myColor, options = {}) {
  if (!Array.isArray(moves) || !moves.length) return;
  const prefixLength = Math.max(0, Math.min(Number(uptoPly) || 0, moves.length));

  destroyPeer(); // never carry an online session into a drill
  gameMode = 'computer';
  playerColor = myColor === 'black' ? 'black' : 'white';
  difficulty = 'medium'; // matches the grading engine's depth
  startGame();

  if (!rebuildBoardFromMoves(moves.slice(0, prefixLength))) {
    // Corrupt stored moves — fall back to the fresh game startGame() made.
    return;
  }
  retryContext = { judge: !!options.judge, judged: false };

  if (options.label) {
    document.getElementById('hint-text').textContent = options.label;
    document.getElementById('hint-box').style.display = 'flex';
  }
  if (game.currentTurn !== playerColor) scheduleAIMove();
}
window.startRetryFromPosition = startRetryFromPosition;

function hideCoachPrompt() {
  coachPromptPending = false;
  const prompt = document.getElementById('coach-prompt');
  if (prompt) prompt.style.display = 'none';
}

function coachTakeBack() {
  if (!coachPromptPending) return;
  hideCoachPrompt();
  // Undo just the player's flagged move; it's their turn again.
  const prefix = game.moveHistory.slice(0, -1)
    .map(m => ({ fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType: m.promType || 'queen' }));
  rebuildBoardFromMoves(prefix);
  primeSuggestedMove();
  if (typeof window.agsSendEvent === 'function') window.agsSendEvent('coach_take_back', {});
}

function coachPlayOn() {
  if (!coachPromptPending) return;
  hideCoachPrompt();
  if (!isGameOverStatus(game.status) && gameMode === 'computer' && game.currentTurn !== playerColor) {
    scheduleAIMove();
  }
}

function updateCoachModeButton() {
  const btn = document.getElementById('btn-coach-mode');
  if (!btn) return;
  btn.style.display = gameMode === 'computer' ? '' : 'none';
  btn.textContent = `🧑‍🏫 Coach Mode: ${coachModeEnabled ? 'On' : 'Off'}`;
  btn.setAttribute('aria-pressed', String(coachModeEnabled));
}

function toggleCoachMode() {
  coachModeEnabled = !coachModeEnabled;
  localStorage.setItem('chess_coach_mode', coachModeEnabled ? '1' : '0');
  updateCoachModeButton();
  if (!coachModeEnabled && coachPromptPending) coachPlayOn();
  if (typeof window.agsSendEvent === 'function') {
    window.agsSendEvent('coach_mode_toggled', { enabled: coachModeEnabled });
  }
}

function openJournalFromGameOver() {
  closeModal('game-over-modal');
  destroyPeer();
  if (typeof window.agsOpenJournal === 'function') window.agsOpenJournal();
}

// Post-game "Review game" entry point (dev-plan §10.8) — the loop's primary
// funnel. Snapshot the match BEFORE destroyPeer() (it nulls `game`), same
// ordering constraint openJournalFromGameOver doesn't have to worry about
// since Journal only needs a userId, not this game's move list.
function reviewGameFromGameOver() {
  const match = lastCompletedMatchRecord;
  closeModal('game-over-modal');
  destroyPeer();
  if (match && typeof window.agsStartReviewFromGameOver === 'function') {
    window.agsStartReviewFromGameOver(match);
  }
}

// ─── UI updates ───────────────────────────────────────────────────────────────

function showMatchTab(name) {
  document.querySelectorAll('[data-match-tab]').forEach(tab => {
    const selected = tab.dataset.matchTab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('[data-match-panel]').forEach(panel => {
    const selected = panel.dataset.matchPanel === name;
    panel.classList.toggle('active', selected);
    panel.setAttribute('aria-hidden', String(!selected));
    panel.tabIndex = selected ? 0 : -1;
  });
}

function flipBoard() {
  boardFlipped = !boardFlipped;
  renderBoard();
}

function arrangePlayerStrips() {
  const center = document.querySelector('#screen-game .game-center');
  const board = center?.querySelector('.board-container');
  const white = document.getElementById('white-player-card')?.closest('.match-player-strip');
  const black = document.getElementById('black-player-card')?.closest('.match-player-strip');
  if (!center || !board || !white || !black) return;
  const opponent = playerColor === 'white' ? black : white;
  const you = playerColor === 'white' ? white : black;
  opponent.className = 'match-player-strip opponent-strip';
  you.className = 'match-player-strip you-strip';
  center.insertBefore(opponent, board);
  board.insertAdjacentElement('afterend', you);
}

function formatMatchClock(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderMatchClocks() {
  for (const color of ['white', 'black']) {
    const clock = document.getElementById(`${color}-clock`);
    if (!clock) continue;
    clock.textContent = formatMatchClock(matchClockElapsed[color]);
    clock.classList.toggle('active', isGameActiveStatus(game?.status) && game.currentTurn === color);
  }
}

function resetMatchClocks() {
  clearInterval(matchClockTimer);
  matchClockTimer = null;
  matchClockElapsed = { white: 0, black: 0 };
  matchClockLastTick = Date.now();
  renderMatchClocks();
}

function startMatchClocks() {
  clearInterval(matchClockTimer);
  matchClockLastTick = Date.now();
  matchClockTimer = setInterval(() => {
    const now = Date.now();
    if (isGameActiveStatus(game?.status)) {
      matchClockElapsed[game.currentTurn] += now - matchClockLastTick;
      renderMatchClocks();
    }
    matchClockLastTick = now;
  }, 1000);
}

function getMoveActor(moveColor, isLocalMove) {
  if (gameMode === 'computer') return isLocalMove ? 'You' : 'Computer';
  if (gameMode === 'online') return isLocalMove ? 'You' : 'Opponent';
  return moveColor === 'white' ? 'White' : 'Black';
}

function getTurnStatusText() {
  if (game.status === 'checkmate') {
    return `${game.winner === 'white' ? 'White' : 'Black'} wins by checkmate!`;
  }
  if (isDrawStatus(game.status)) return getDrawMessage(game.status);
  if (game.status === 'check') {
    return `${game.currentTurn === 'white' ? 'White' : 'Black'} is in check!`;
  }
  if (gameMode === 'computer' && !aiThinking) {
    return game.currentTurn === playerColor ? 'Your turn' : "Computer's turn";
  }
  if (gameMode === 'online') {
    return game.currentTurn === playerColor ? 'Your turn' : "Opponent's turn";
  }
  return (game.currentTurn === 'white' ? 'White' : 'Black') + "'s turn";
}

function updateStatus(lastMove = null) {
  const el = document.getElementById('turn-indicator');
  updateActivePlayerCards();
  const stateText = getTurnStatusText();
  el.textContent = lastMove?.notation
    ? `${lastMove.actor} played ${lastMove.notation} · ${stateText}`
    : stateText;
  const statusBar = el.closest('.game-status');
  if (statusBar) {
    statusBar.classList.toggle('status-check', game.status === 'check');
    statusBar.classList.toggle('status-checkmate', game.status === 'checkmate');
    statusBar.classList.toggle('status-stalemate', isDrawStatus(game.status));
  }
}

function updateActivePlayerCards() {
  const whiteCard = document.getElementById('white-player-card');
  const blackCard = document.getElementById('black-player-card');
  if (!whiteCard || !blackCard || !game) return;

  const active = isGameActiveStatus(game.status);
  whiteCard.classList.toggle('active-player', active && game.currentTurn === 'white');
  blackCard.classList.toggle('active-player', active && game.currentTurn === 'black');
  whiteCard.classList.toggle('waiting-player', active && game.currentTurn !== 'white');
  blackCard.classList.toggle('waiting-player', active && game.currentTurn !== 'black');
  whiteCard.dataset.turnLabel = active && game.currentTurn === 'white' ? 'To move' : '';
  blackCard.dataset.turnLabel = active && game.currentTurn === 'black' ? 'To move' : '';
}

function updateCapturedPieces() {
  const VALS = { pawn:1, knight:3, bishop:3, rook:5, queen:9, king:0 };
  let wScore = 0, bScore = 0;
  let wHtml = '', bHtml = '';
  for (const p of game.capturedByWhite) {
    wHtml += `<span class="cap-piece ${p.color}" aria-label="captured ${p.color} ${PIECE_LABELS[p.type]}">${renderChessPieceSVG(p.type)}</span>`;
    wScore += VALS[p.type];
  }
  for (const p of game.capturedByBlack) {
    bHtml += `<span class="cap-piece ${p.color}" aria-label="captured ${p.color} ${PIECE_LABELS[p.type]}">${renderChessPieceSVG(p.type)}</span>`;
    bScore += VALS[p.type];
  }
  document.getElementById('captured-by-white').innerHTML = wHtml;
  document.getElementById('captured-by-black').innerHTML = bHtml;
  const balance = wScore - bScore;
  document.getElementById('white-score').textContent = balance > 0 ? `+${balance}` : 'Even';
  document.getElementById('black-score').textContent = balance < 0 ? `+${Math.abs(balance)}` : 'Even';
}

function addMoveToList(notation, color) {
  const listEl = document.getElementById('move-list');
  const moveNum = Math.ceil(game.moveHistory.length / 2);
  listEl.querySelectorAll('.latest-move, .latest-ply').forEach(el => {
    el.classList.remove('latest-move', 'latest-ply');
  });

  let latestEl = null;
  if (color === 'white') {
    const row = document.createElement('div');
    row.className = 'move-row latest-move';
    row.id = `move-row-${moveNum}`;
    row.innerHTML = `<span class="move-num">${moveNum}.</span>
      <span class="move-white latest-ply">${notation}</span><span class="move-black"></span>`;
    listEl.appendChild(row);
    latestEl = row;
  } else {
    const row = document.getElementById(`move-row-${moveNum}`);
    const blackMove = row?.querySelector('.move-black');
    if (row && blackMove) {
      row.classList.add('latest-move');
      blackMove.classList.add('latest-ply');
      blackMove.textContent = notation;
      latestEl = row;
    }
  }
  latestEl?.scrollIntoView({ block: 'nearest' });
}

// ─── Promotion modal ──────────────────────────────────────────────────────────

function showPromotionModal(color) {
  const opts = document.getElementById('promotion-options');
  opts.innerHTML = '';
  for (const type of ['queen','rook','bishop','knight']) {
    const btn = document.createElement('button');
    btn.className = `prom-btn ${color}`;
    btn.innerHTML = renderChessPieceSVG(type);
    btn.title = type[0].toUpperCase() + type.slice(1);
    btn.setAttribute('aria-label', `Promote to ${type}`);
    btn.onclick = () => {
      closeModal('promotion-modal');
      if (pendingPromotion) {
        const { fr, fc, toR, toC } = pendingPromotion;
        pendingPromotion = null;
        executeMove(fr, fc, toR, toC, type);
      }
    };
    opts.appendChild(btn);
  }
  document.getElementById('promotion-modal').style.display = 'flex';
}

// ─── Game over modal ──────────────────────────────────────────────────────────

function showGameOver() {
  clearInterval(matchClockTimer);
  matchClockTimer = null;
  renderMatchClocks();
  recordMatchHistoryOnce();
  window.agsClearLiveMatch?.()
  // Must snapshot before clearActiveMatch() below nulls currentMatchId —
  // the High Five button needs it after this function returns.
  lastCompletedMatchId = currentMatchId;

  const won = game.status === 'checkmate' && game.winner === playerColor;
  const lost = game.status === 'checkmate' && game.winner && game.winner !== playerColor;
  const drew = isDrawStatus(game.status);

  if (won) {
    recordWin();
    if (typeof window.agsIncrementWin === 'function') window.agsIncrementWin();
  } else if (lost) {
    if (typeof window.agsIncrementLoss === 'function') window.agsIncrementLoss();
  } else if (drew) {
    if (typeof window.agsIncrementDraw === 'function') window.agsIncrementDraw();
  }
  if (typeof window.agsIncrementGamePlayed === 'function') window.agsIncrementGamePlayed(gameMode);
  window.agsUpdateStreak?.();
  // Elo rating only applies to online matches against a real opponent whose
  // pre-game rating we actually received over the peer connection —
  // agsRecordEloResult no-ops itself if that never arrived.
  if (gameMode === 'online' && (won || lost || drew)) {
    const score = won ? 1 : lost ? 0 : 0.5;
    window.agsRecordEloResult?.(score);
  }
  clearActiveMatch(); // legitimate game end — nothing left to resume

  const title = document.getElementById('game-over-title');
  const msg   = document.getElementById('game-over-message');
  if (game.status === 'checkmate') {
    const winner = game.winner === 'white' ? 'White' : 'Black';
    title.textContent = `${winner} Wins!`;
    if (gameMode === 'computer')
      msg.textContent = game.winner === playerColor ? 'You won! Great game!' : 'Computer wins. Better luck next time!';
    else if (gameMode === 'online')
      msg.textContent = game.winner === playerColor ? 'You won!' : 'Your opponent won!';
    else
      msg.textContent = `${winner} wins by checkmate!`;
  } else {
    title.textContent = 'Draw!';
    msg.textContent = getDrawMessage(game.status);
  }

  const isOnline = gameMode === 'online';
  document.getElementById('btn-play-again').style.display = isOnline ? 'none' : '';
  const rematchBtn = document.getElementById('btn-rematch');
  rematchBtn.style.display = isOnline && !currentOpponentBlocked ? '' : 'none';
  rematchBtn.textContent = 'Rematch';
  rematchBtn.disabled = false;
  setRematchMessage('');

  const addFriendBtn = document.getElementById('btn-add-match-friend');
  const isGusOpponent = currentOpponent?.userId
    && (
      currentOpponent.userId === window.agsGambitGusUserId
      || currentOpponent.userId === 'gambit-gus'
      || String(currentOpponent.name || '').trim().toLowerCase() === String(window.agsGambitGusName || 'Gambit Gus').trim().toLowerCase()
    );
  if (addFriendBtn) addFriendBtn.style.display = isOnline && currentOpponent?.userId && !currentOpponentBlocked && !isGusOpponent ? '' : 'none';

  // High Five (dev-plan §9): eligibility is decided by window.agsHighFiveButtonState
  // (src/kudos-contract.mjs via src/main.js), the same identity/bot/blocked
  // guards already computed just above — never guess a userId, never show
  // this for a guest/bare-peer opponent.
  const highFiveBtn = document.getElementById('btn-high-five');
  if (highFiveBtn) {
    const state = typeof window.agsHighFiveButtonState === 'function'
      ? window.agsHighFiveButtonState({
          gameMode, recipientUserId: currentOpponent?.userId || '', isBot: !!isGusOpponent,
          isBlocked: currentOpponentBlocked, matchId: lastCompletedMatchId,
        })
      : { visible: false };
    highFiveBtn.style.display = state.visible ? '' : 'none';
    highFiveBtn.disabled = !!state.disabled;
    if (state.visible) highFiveBtn.textContent = state.label;
  }

  const matchFriendMessage = document.getElementById('match-friend-message');
  if (matchFriendMessage) matchFriendMessage.textContent = '';
  if (isOnline && currentOpponent?.userId && !isGusOpponent && typeof window.agsUpdateMatchFriendAction === 'function') {
    window.agsUpdateMatchFriendAction(currentOpponent);
  } else if (matchFriendMessage && isGusOpponent) {
    matchFriendMessage.textContent = 'Gambit Gus cannot be added as a friend.'
  }

  // Post-game journal nudge: reflection lands best right after the game.
  const journalNudge = document.getElementById('btn-journal-nudge');
  if (journalNudge) {
    journalNudge.style.display =
      window.agsCurrentUserId && typeof window.agsOpenJournal === 'function' ? '' : 'none';
  }

  // Post-game "Review game" entry (dev-plan §10.8) — same signed-in gate as
  // the journal nudge, plus a recorded move list and the milestone flag.
  // Absent (never disabled) when the match has no moves to review.
  const reviewGameBtn = document.getElementById('btn-review-game');
  if (reviewGameBtn) {
    const reviewEnabled = typeof window.agsLearningFlags === 'function' && window.agsLearningFlags().reviewV2;
    reviewGameBtn.style.display =
      window.agsCurrentUserId && reviewEnabled && game.moveHistory.length > 0
        && typeof window.agsStartReviewFromGameOver === 'function' ? '' : 'none';
  }

  // Contextual invite prompt
  const invitePrompt = document.getElementById('game-over-invite-prompt');
  if (invitePrompt) {
    invitePrompt.innerHTML = '';
    const isWin  = game.status === 'checkmate' && game.winner === playerColor;
    const isLoss = game.status === 'checkmate' && game.winner && game.winner !== playerColor;
    if (isWin || isLoss) {
      const inviteUrl = window.agsGetInviteUrl?.();
      const nudge = document.createElement('p');
      nudge.className = 'invite-nudge-text';
      if (inviteUrl) {
        nudge.textContent = isWin ? '🎉 Share a challenge link:' : '💪 Share a challenge link with a different opponent:';
        invitePrompt.appendChild(nudge);
        if (typeof window.agsShareRow === 'function') {
          window.agsShareRow(invitePrompt, inviteUrl, {
            campaign: 'post-game-challenge',
            sharePayload: { trigger: 'game_over', mode: gameMode, result: isWin ? 'win' : isLoss ? 'loss' : 'completed' },
          });
        }
      } else {
        nudge.textContent = isWin ? '🎉 Create an account to invite friends!' : '💪 Create an account to invite a different opponent!';
        nudge.className += ' invite-nudge-cta';
        const openRegister = () => {
          closeModal('game-over-modal');
          window.agsOpenRegister?.();
        };
        nudge.setAttribute('role', 'button');
        nudge.tabIndex = 0;
        nudge.addEventListener('click', openRegister);
        nudge.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openRegister();
          }
        });
        invitePrompt.appendChild(nudge);
      }
    }
  }

  document.getElementById('game-over-modal').style.display = 'flex';
  if (won) window.agsTriggerVictoryEffect?.();
  if (gameMode === 'online') startGameOverCountdown();
}

function recordMatchHistoryOnce() {
  if (matchHistoryRecorded || typeof window.agsRecordMatchHistory !== 'function') return;
  matchHistoryRecorded = true;

  const endedAt = new Date();
  const startedAt = matchStartedAt || endedAt;
  const result = isDrawStatus(game.status)
    ? 'draw'
    : game.winner === playerColor
      ? 'win'
      : 'loss';
  // Resignation reuses the 'checkmate' status (see gameEndedByResignation) so
  // existing win/loss UI stays untouched; this is the one place it's split
  // back out, purely for the stats record.
  const endReason = gameEndedByResignation ? 'resignation' : game.status;

  const opponentName = gameMode === 'computer'
    ? 'Computer AI'
    : currentOpponent?.name || 'Opponent';
  const opponentUserId = gameMode === 'online'
    ? currentOpponent?.userId || ''
    : '';

  if (typeof window.agsSendEvent === 'function') {
    window.agsSendEvent('game_completed', {
      mode:            gameMode,
      result,
      duration_ms:     endedAt.getTime() - startedAt.getTime(),
      move_count:      game.moveHistory.length,
      opponent_is_bot: gameMode === 'computer',
    });
  }

  const record = {
    id: 'match-' + endedAt.getTime() + '-' + Math.random().toString(36).slice(2, 8),
    mode: gameMode,
    opponentName,
    opponentUserId,
    result,
    endReason,
    myColor: playerColor,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    moves: game.moveHistory.map(m => ({ fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType: m.promType || 'queen' })),
    whiteName: document.getElementById('white-player-name')?.textContent || 'White',
    blackName: document.getElementById('black-player-name')?.textContent || 'Black',
    // Piece types only (color is implied by which side captured them) — kept
    // compact since match history caps at 50 entries per player.
    capturedByWhite: game.capturedByWhite.map(p => p.type),
    capturedByBlack: game.capturedByBlack.map(p => p.type),
  };
  lastCompletedMatchRecord = record;
  window.agsRecordMatchHistory(record);
}

function closeModal(id) {
  if (id === 'game-over-modal') stopGameOverCountdown();
  document.getElementById(id).style.display = 'none';
}

function startGameOverCountdown() {
  stopGameOverCountdown();
  gameOverCountdownRemaining = 10;
  updateGameOverCountdown();
  gameOverCountdownTimer = setInterval(() => {
    gameOverCountdownRemaining--;
    updateGameOverCountdown();
    if (gameOverCountdownRemaining <= 0) {
      stopGameOverCountdown();
      endOnlineAndGoHome();
    }
  }, 1000);
}

function stopGameOverCountdown() {
  if (gameOverCountdownTimer) {
    clearInterval(gameOverCountdownTimer);
    gameOverCountdownTimer = null;
  }
  const el = document.getElementById('game-over-countdown');
  if (el) el.textContent = '';
}

function updateGameOverCountdown() {
  const el = document.getElementById('game-over-countdown');
  if (!el) return;
  const seconds = Math.max(0, gameOverCountdownRemaining);
  el.textContent = `Returning to Main Menu in ${seconds}s`;
}

// ─── Rematch ──────────────────────────────────────────────────────────────────

function setRematchMessage(text, tone = '') {
  const el = document.getElementById('rematch-message');
  if (!el) return;
  el.className = `rematch-message${tone ? ' ' + tone : ''}`;
  el.textContent = text || '';
}

function requestRematch() {
  if (currentOpponentBlocked) return;
  if (document.getElementById('rematch-notification').style.display === 'flex') {
    acceptRematch();
    return;
  }
  if (!peerConn?.open || rematchPending) return;
  stopGameOverCountdown();
  rematchPending = true;
  const btn = document.getElementById('btn-rematch');
  btn.textContent = 'Waiting for opponent…';
  btn.disabled = true;
  setRematchMessage('Rematch request sent. Waiting for your opponent...', 'pending');
  peerConn.send({ type: 'rematch_request' });
  if (typeof window.agsSendEvent === 'function') window.agsSendEvent('rematch_requested', {});
}

// High Five (dev-plan §9). Server call is authoritative for coins/kudos;
// the optional peer message below is purely a live "they saw it" nicety —
// if the opponent isn't connected anymore, the next /club/status refresh on
// their end still shows the correct balance regardless.
function sendHighFive() {
  const btn = document.getElementById('btn-high-five');
  if (!btn || btn.disabled) return;
  const recipientUserId = currentOpponent?.userId;
  const matchId = lastCompletedMatchId;
  if (!recipientUserId || !matchId || typeof window.agsSendHighFive !== 'function') return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  window.agsSendHighFive(matchId, recipientUserId).then(() => {
    btn.textContent = '🙌 High Five sent';
    try { if (peerConn?.open) peerConn.send({ type: 'highfive', fromName: getCurrentPlayerDisplayName() }); } catch {}
    if (typeof window.agsSendEvent === 'function') window.agsSendEvent('highfive_sent', {});
  }).catch(error => {
    btn.disabled = false;
    btn.textContent = originalText;
    const messageEl = document.getElementById('match-friend-message');
    if (messageEl) messageEl.textContent = error?.message || 'Could not send High Five. Try again.';
  });
}

function acceptRematch() {
  if (currentOpponentBlocked) return;
  stopGameOverCountdown();
  if (typeof window.agsSendEvent === 'function') window.agsSendEvent('rematch_accepted', {});
  document.getElementById('rematch-notification').style.display = 'none';
  setRematchMessage('Rematch accepted. Starting...', 'success');
  if (connRole === 'host') {
    sendRematchStart();
  } else {
    // Joiner accepts — host will send rematch_start to kick off the game
    peerConn.send({ type: 'rematch_accept' });
    closeModal('game-over-modal');
  }
}

function declineRematch() {
  document.getElementById('rematch-notification').style.display = 'none';
  if (peerConn?.open) peerConn.send({ type: 'rematch_decline' });
  setRematchMessage('You declined the rematch request.', 'muted');
  if (document.getElementById('game-over-modal').style.display === 'flex') startGameOverCountdown();
}

function sendRematchStart() {
  // Colors swap each rematch; joiner gets host's current color
  const newJoinerColor = playerColor;
  playerColor = playerColor === 'white' ? 'black' : 'white';
  peerConn.send({ type: 'rematch_start', yourColor: newJoinerColor });
  startRematch();
}

function startRematch() {
  rematchPending = false;
  setRematchMessage('');
  closeModal('game-over-modal');
  document.getElementById('rematch-notification').style.display = 'none';
  moveLog   = [];
  moveQueue = [];
  chatActivationKey = '';
  startGame();
}

function endOnlineAndGoHome() {
  closeModal('game-over-modal');
  destroyPeer();
  showScreen('home');
}

async function forfeitOnlineMatchAndGoHome() {
  if (gameMode !== 'online' || !game || isGameOverStatus(game.status) || !game.moveHistory.length) {
    return false;
  }

  const endedAt = new Date();
  const startedAt = matchStartedAt || endedAt;
  const myName = getCurrentPlayerDisplayName();
  const opponentName = currentOpponent?.name || 'Opponent';
  const opponentUserId = currentOpponent?.userId || '';
  const moves = game.moveHistory.map(m => ({ fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType: m.promType || 'queen' }));
  const capturedByWhite = game.capturedByWhite.map(p => p.type);
  const capturedByBlack = game.capturedByBlack.map(p => p.type);
  const historyEntry = {
    id: 'match-' + endedAt.getTime() + '-' + Math.random().toString(36).slice(2, 8),
    mode: 'online',
    opponentName,
    opponentUserId,
    result: 'loss',
    endReason: 'forfeit',
    myColor: playerColor,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    moves,
    whiteName: playerColor === 'white' ? myName : opponentName,
    blackName: playerColor === 'black' ? myName : opponentName,
    capturedByWhite,
    capturedByBlack,
  };

  // Clear the resumable record first so a peer-close event can't re-save it as
  // a disconnect window after the user already chose to leave.
  clearActiveMatch();

  try { await window.agsIncrementLoss?.(); } catch {}
  try { await window.agsIncrementGamePlayed?.('online'); } catch {}
  try { await window.agsUpdateStreak?.(); } catch {}
  try {
    if (typeof window.agsGetPendingOpponentRating === 'function') {
      const rating = window.agsGetPendingOpponentRating();
      if (typeof rating === 'number') {
        window.agsSetOpponentRating?.(rating);
        await window.agsRecordEloResult?.(0);
      }
    }
  } catch {}
  try { await window.agsRecordMatchHistory?.(historyEntry); } catch {}

  destroyPeer();
  showScreen('home');
  showConnBanner('You left the match. Recorded as a loss.', 'error');
  return true;
}

// ─── PeerJS — Online Multiplayer ──────────────────────────────────────────────

async function createGamePeer(id) {
  if (!window.chessVideoCall?.runtimeReady && window.agsPrepareRealtimeRuntime) {
    await window.agsPrepareRealtimeRuntime();
  }
  if (window.chessVideoCall?.createPeer) return window.chessVideoCall.createPeer(id);
  if (typeof window.Peer === 'function') return id ? new window.Peer(id) : new window.Peer();
  return id ? new Peer(id) : new Peer();
}

const PEER_OPEN_TIMEOUT_MS = 15000;
const RETRYABLE_PEER_SIGNAL_ERRORS = new Set([
  'network',
  'socket-error',
  'socket-closed',
  'server-error',
  'disconnected',
]);

function isRetryablePeerSignalError(error) {
  return RETRYABLE_PEER_SIGNAL_ERRORS.has(String(error?.type || '').toLowerCase());
}

function normalizePeerTarget(value) {
  const peerId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(peerId) ? peerId : '';
}

function showPeerSetupFailure(message, generation = peerLifecycleGeneration) {
  if (generation !== peerLifecycleGeneration) return;
  const sub = document.getElementById('waiting-sub');
  const spinner = document.getElementById('waiting-spinner');
  if (sub) sub.textContent = message;
  if (spinner) spinner.style.display = 'none';
}

function armPeerOpenTimeout(activePeer, generation, message) {
  if (peerOpenTimer) clearTimeout(peerOpenTimer);
  peerOpenTimer = setTimeout(() => {
    if (generation !== peerLifecycleGeneration || peer !== activePeer || activePeer?.open) return;
    peerOpenTimer = null;
    showPeerSetupFailure(message, generation);
    if (game && gameMode === 'online') {
      showConnBanner(message, 'error');
      handleConnectionLost();
    }
    try { activePeer.destroy(); } catch {}
    peer = null;
  }, PEER_OPEN_TIMEOUT_MS);
}

function clearPeerOpenTimeout() {
  if (peerOpenTimer) { clearTimeout(peerOpenTimer); peerOpenTimer = null; }
}

function attachPeerLifecycle(activePeer, generation, reconnectFailureMessage) {
  activePeer.on('disconnected', () => {
    if (generation !== peerLifecycleGeneration || peer !== activePeer) return;
    console.warn('PeerJS signaling disconnected; reconnecting.');
    if (!game) {
      const sub = document.getElementById('waiting-sub');
      const spinner = document.getElementById('waiting-spinner');
      if (sub) sub.textContent = 'Match service connection interrupted — reconnecting…';
      if (spinner) spinner.style.display = 'block';
      armPeerOpenTimeout(activePeer, generation, reconnectFailureMessage);
    }
    try {
      activePeer.reconnect();
    } catch (error) {
      console.warn('PeerJS signaling reconnect failed:', error);
      if (!game) showPeerSetupFailure(reconnectFailureMessage, generation);
    }
  });

  activePeer.on('close', () => {
    if (generation !== peerLifecycleGeneration || peer !== activePeer) return;
    clearPeerOpenTimeout();
    peer = null;
    if (game && gameMode === 'online' && !peerConn?.open) {
      handleConnectionLost();
    } else if (!game) {
      showPeerSetupFailure(reconnectFailureMessage, generation);
    }
  });
}

function destroyPeer() {
  peerLifecycleGeneration += 1;
  clearPeerOpenTimeout();
  clearInterval(matchClockTimer);
  matchClockTimer = null;
  endVideoChat();
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  game = null;          // must be null so a fresh joiner doesn't look like a reconnect
  connectionLost = false;
  rematchPending = false;
  reconnectCount = 0;
  connRole = null;
  moveQueue = [];
  moveLog   = [];
  pendingChatContext = null;
  chatActivationKey = '';
  matchChatFriendState = 'unknown';
  matchChatFriendRequestSent = false;
  matchChatFriendCheckToken += 1;
  if (typeof window.agsDeactivateChat === 'function') window.agsDeactivateChat();
  remotePeerId = null;
  setCurrentOpponent('', '');
  if (peerConn) { try { peerConn.close(); } catch {} peerConn = null; }
  if (peer)     { try { peer.destroy();   } catch {} peer = null; }
  currentInviteLink = '';
  activeFriendInviteId = '';
  resetChatState();
  updateChatAvailability();
  hideConnBanner();
}

// ─── Connection stability ──────────────────────────────────────────────────────

function showConnBanner(msg, type) {
  const el = document.getElementById('conn-banner');
  if (!el) return;
  el.textContent = msg;
  el.className = 'conn-banner ' + type;
  el.style.display = 'block';
  if (type === 'success') setTimeout(hideConnBanner, 3000);
}

function hideConnBanner() {
  const el = document.getElementById('conn-banner');
  if (el) el.style.display = 'none';
}

// ─── Match resume (survives a disconnect/crash/reload) ─────────────────────

function readActiveMatch() {
  try {
    const raw = localStorage.getItem(ACTIVE_MATCH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeActiveMatch(record) {
  try { localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify(record)); } catch {}
}

function clearActiveMatch() {
  try { localStorage.removeItem(ACTIVE_MATCH_KEY); } catch {}
  currentMatchId = null;
}

// Called once both my color and the opponent's identity are known for an
// online match (see startGame() and the player_info handler — the host
// doesn't know the opponent until player_info arrives, after startGame()).
function saveActiveMatch() {
  if (currentMatchId) return; // already saved for this game
  if (gameMode !== 'online' || !window.agsCurrentUserId || !currentOpponent?.userId) return;
  currentMatchId = 'match-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  writeActiveMatch({
    matchId: currentMatchId,
    myUserId: window.agsCurrentUserId,
    myColor: playerColor,
    opponentUserId: currentOpponent.userId,
    opponentName: currentOpponent.name || 'Opponent',
    startedAt: (matchStartedAt || new Date()).toISOString(),
    disconnectedAt: null,
    deadline: null,
    opponentRatingAtStart: null,
  });
}

// Marks the persisted record as disconnected (starts the 10-minute resume
// clock) instead of treating the match as unconditionally lost. Also stashes
// the opponent's rating captured at connection time (agsGetPendingOpponentRating)
// since that's only ever held in memory and won't survive a reload otherwise —
// needed later to record an Elo result for a forfeit with no live peer to
// re-exchange ratings with.
function markMatchDisconnected() {
  const record = readActiveMatch();
  if (!record || record.matchId !== currentMatchId) return;
  const now = new Date().toISOString();
  record.disconnectedAt = record.disconnectedAt || now;
  record.deadline = window.agsComputeDeadline?.(record.disconnectedAt) || record.deadline;
  if (record.opponentRatingAtStart == null) {
    const rating = window.agsGetPendingOpponentRating?.();
    record.opponentRatingAtStart = typeof rating === 'number' ? rating : null;
  }
  writeActiveMatch(record);
}

let pendingResumeRecord = null;

function showResumePrompt(record) {
  pendingResumeRecord = record;
  const modal = document.getElementById('resume-match-modal');
  if (!modal) return;
  const nameEl = document.getElementById('resume-match-opponent');
  if (nameEl) nameEl.textContent = record.opponentName || 'Opponent';
  modal.style.display = 'flex';
}

function hideResumePrompt() {
  const modal = document.getElementById('resume-match-modal');
  if (modal) modal.style.display = 'none';
}

// Entry point, called once per login (see src/main.js hydrateAuthenticatedUser).
window.agsCheckResumableMatch = async function() {
  const record = readActiveMatch();
  if (!record) return;
  if (window.agsIsResumable?.(record) ?? true) {
    showResumePrompt(record);
  } else {
    try {
      await resolveExpiredMatch(record);
    } catch (error) {
      console.warn('Could not verify the expired match:', error);
      showConnBanner('Could not verify the match result. Please try again when online.', 'error');
    }
  }
};

window.agsResumeActiveMatch = function() {
  if (!pendingResumeRecord) return;
  const record = pendingResumeRecord;
  pendingResumeRecord = null;
  hideResumePrompt();
  void attemptResume(record);
};

window.agsDiscardActiveMatch = function() {
  pendingResumeRecord = null;
  hideResumePrompt();
  clearActiveMatch();
};

// Reconstructs match state from the persisted record + both sides' public
// chess-live CloudSave records (longer move list wins — see
// src/match-resume.mjs pickAuthoritativeMoves), then reconnects using the
// same deterministic host/joiner scheme matchmaking already uses. Rebuilding
// `game` *before* opening the peer connection means setupPeerConnection's
// existing on('open') logic naturally treats this as a same-session
// reconnect (its "if (game) …" branch) — reconnect_req/resync already
// handles the rest, no new peer message protocol needed.
async function attemptResume(record) {
  destroyPeer(); // clean slate — also clears any stale game/moveLog/connRole
  const peerGeneration = peerLifecycleGeneration;

  gameMode = 'online';
  playerColor = record.myColor;
  matchStartedAt = new Date(record.startedAt);
  currentMatchId = record.matchId;
  matchHistoryRecorded = false;
  gameEndedByResignation = false;
  setCurrentOpponent(record.opponentName, record.opponentUserId);

  showConnBanner(`Reconnecting to ${record.opponentName}…`, 'warning');

  let myLive;
  let theirLive;
  try {
    const fetchLiveMatch = window.agsFetchLiveMatchStrict || window.agsFetchLiveMatch;
    if (typeof fetchLiveMatch !== 'function') throw new Error('Saved-match service is unavailable.');
    [myLive, theirLive] = await Promise.all([
      fetchLiveMatch(record.myUserId),
      fetchLiveMatch(record.opponentUserId),
    ]);
  } catch (error) {
    if (peerGeneration !== peerLifecycleGeneration) return;
    console.warn('Could not load the saved match state:', error);
    showConnBanner('Could not load the saved match. Check your connection; retrying…', 'warning');
    setTimeout(() => {
      if (peerGeneration !== peerLifecycleGeneration) return;
      const current = readActiveMatch();
      if (current?.matchId === record.matchId) void attemptResume(current);
    }, 10_000);
    return;
  }
  if (peerGeneration !== peerLifecycleGeneration) return;
  const myMoves = myLive?.matchId === record.matchId && Array.isArray(myLive.moves) ? myLive.moves : [];
  const theirMoves = theirLive?.matchId === record.matchId && Array.isArray(theirLive.moves) ? theirLive.moves : [];
  const moves = window.agsPickAuthoritativeMoves?.(myMoves, theirMoves) ?? myMoves;

  const rebuiltGame = new ChessGame();
  const normalized = [];
  for (const raw of moves) {
    const move = normalizePeerMove(raw);
    if (!move || !rebuiltGame.makeMove(move.fr, move.fc, move.toR, move.toC, move.promType)) {
      // Corrupt/unreplayable history — safer to give up on resume than show a broken board.
      clearActiveMatch();
      showConnBanner('Could not recover this match. Returning to menu.', 'error');
      showScreen('home');
      return;
    }
    normalized.push(move);
  }

  game = new ChessGame();
  boardFlipped = playerColor === 'black';
  document.getElementById('move-list').innerHTML = '';
  document.getElementById('captured-by-white').innerHTML = '';
  document.getElementById('captured-by-black').innerHTML = '';
  for (const m of normalized) {
    const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
    game.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
    addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
  }
  updateCapturedPieces();
  updateStatus();
  resetMatchClocks();
  setPlayerInfo(playerColor, getCurrentPlayerDisplayName(), record.myUserId);
  setPlayerInfo(playerColor === 'white' ? 'black' : 'white', record.opponentName, record.opponentUserId);
  showScreen('game');
  renderBoard();
  updateChatAvailability();

  const { iAmHost, peerId } = window.agsDeriveMatchRoles(record.myUserId, record.opponentUserId);
  // Host-only resync source (see the existing reconnect_req handler) — seed
  // it from the same authoritative history in case I'm asked for it.
  moveLog = normalized.map(m => ({ type: 'move', ...m }));

  let createdPeer;
  try {
    createdPeer = await createGamePeer(iAmHost ? peerId : undefined);
  } catch (error) {
    if (peerGeneration !== peerLifecycleGeneration) return;
    console.warn('Could not recreate PeerJS connection:', error);
    handleConnectionLost();
    return;
  }
  if (peerGeneration !== peerLifecycleGeneration) {
    try { createdPeer.destroy(); } catch {}
    return;
  }
  peer = createdPeer;
  setupCallHandler();
  attachPeerLifecycle(createdPeer, peerGeneration, 'Could not reconnect to the saved match. Check your connection and try again.');
  armPeerOpenTimeout(createdPeer, peerGeneration, 'The match reconnect took too long. Check your connection; retrying…');

  if (iAmHost) {
    // Register the data-connection listener once. PeerJS emits `open` again
    // after a signaling reconnect, so nesting this inside `open` would stack
    // duplicate handlers every time the signaling socket recovered.
    createdPeer.on('connection', conn => {
      if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) {
        try { conn.close(); } catch {}
        return;
      }
      if (peerConn) {
        try { conn.close(); } catch {}
        return;
      }
      peerConn = conn;
      setupPeerConnection(conn, 'host');
    });
    createdPeer.on('open', () => {
      if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) return;
      clearPeerOpenTimeout();
    });
  } else {
    createdPeer.on('open', () => {
      if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) return;
      clearPeerOpenTimeout();
      if (peerConn) return;
      try {
        const conn = createdPeer.connect(peerId, { reliable: true });
        peerConn = conn;
        setupPeerConnection(conn, 'joiner');
      } catch (error) {
        console.warn('Could not reconnect to the saved match:', error);
        handleConnectionLost();
      }
    });
  }

  createdPeer.on('error', error => {
    if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) return;
    if (isRetryablePeerSignalError(error)) {
      // PeerJS emits `error: network` immediately before its recoverable
      // `disconnected` event. attachPeerLifecycle owns that reconnect; treating
      // this first event as a lost game would destroy the recovered Peer.
      console.warn('Saved-match signaling interrupted; PeerJS is reconnecting:', error?.message || error);
      if (!peerConn?.open) {
        showConnBanner('Match service connection interrupted — reconnecting…', 'warning');
      }
      return;
    }
    clearPeerOpenTimeout();
    // Opponent isn't back yet (or the connect attempt otherwise failed) —
    // this re-enters the same disconnected state without resetting the
    // original 10-minute deadline (markMatchDisconnected only sets
    // disconnectedAt once), then retries shortly if there's still time left.
    handleConnectionLost();
    const current = readActiveMatch();
    if (current && (window.agsIsResumable?.(current) ?? true)) {
      setTimeout(() => {
        if (peerGeneration === peerLifecycleGeneration) void attemptResume(current);
      }, 10_000);
    } else if (current) {
      void resolveExpiredMatch(current).catch(error => {
        console.warn('Could not resolve the expired match:', error);
        showConnBanner('Could not verify the match result. Please try again when online.', 'error');
      });
    }
  });
}

// Called once the 10-minute window has passed unresumed. Since there's no
// server to adjudicate, whichever side's client is actually running decides:
// if the opponent already recorded a forfeit win naming me as the loser
// (their chess-live record, public), I mirror that as my own loss; otherwise
// I declare myself the winner and leave the same marker for them to find
// whenever their client next runs — could be much later. See the plan's
// "Race note" for the (rare, accepted) case where both sides reach this at
// the same moment.
async function resolveExpiredMatch(record) {
  const fetchLiveMatch = window.agsFetchLiveMatchStrict || window.agsFetchLiveMatch;
  if (typeof fetchLiveMatch !== 'function') throw new Error('Saved-match service is unavailable.');
  const theirLive = await fetchLiveMatch(record.opponentUserId);
  if (readActiveMatch()?.matchId !== record.matchId) return;
  const theirResolution = theirLive?.resolvedForfeit;
  const iAmTheLoser = theirResolution?.matchId === record.matchId
    && theirResolution.loserUserId === record.myUserId;

  const endedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.now() - new Date(record.startedAt).getTime());
  const myName = getCurrentPlayerDisplayName();
  const historyEntry = {
    mode: 'online',
    opponentName: record.opponentName,
    opponentUserId: record.opponentUserId,
    endReason: 'forfeit',
    myColor: record.myColor,
    startedAt: record.startedAt,
    endedAt,
    durationMs,
    moves: [],
    whiteName: record.myColor === 'white' ? myName : record.opponentName,
    blackName: record.myColor === 'black' ? myName : record.opponentName,
  };

  const persistOutcome = async (score, history) => {
    if (typeof record.opponentRatingAtStart === 'number') {
      window.agsSetOpponentRating?.(record.opponentRatingAtStart);
    }
    const writes = [
      score === 1 ? window.agsIncrementWin : window.agsIncrementLoss,
      () => window.agsIncrementGamePlayed?.('online'),
      window.agsUpdateStreak,
      typeof record.opponentRatingAtStart === 'number'
        ? () => window.agsRecordEloResult?.(score)
        : null,
      () => window.agsRecordMatchHistory?.(history),
    ].filter(Boolean).map(write => Promise.resolve().then(() => write?.()));
    const results = await Promise.allSettled(writes);
    if (results.some(result => result.status === 'rejected')) {
      console.warn('Some expired-match outcome writes could not be saved.');
    }
  };

  if (iAmTheLoser) {
    await persistOutcome(0, { ...historyEntry, result: 'loss' });
    showConnBanner(`You didn't reconnect in time — recorded as a loss vs ${record.opponentName}.`, 'error');
  } else {
    if (typeof window.agsResolveMatchForfeit !== 'function') {
      throw new Error('Match-resolution service is unavailable.');
    }
    await window.agsResolveMatchForfeit(record.myUserId, record.matchId, record.opponentUserId);
    await persistOutcome(1, { ...historyEntry, result: 'win' });
    showConnBanner(`${record.opponentName} didn't reconnect in time — recorded as a win.`, 'success');
  }
  if (readActiveMatch()?.matchId === record.matchId) clearActiveMatch();
}

function startHeartbeat(conn) {
  stopHeartbeat();
  lastPongTime = Date.now();
  pingInterval = setInterval(() => {
    if (conn?.open) {
      try { conn.send({ type: 'ping' }); } catch {}
    }
    if (Date.now() - lastPongTime > PONG_TIMEOUT) {
      stopHeartbeat();
      handleConnectionLost();
    }
  }, PING_MS);
}

function stopHeartbeat() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
}

function sendOrQueue(msg) {
  if (peerConn?.open) {
    try { peerConn.send(msg); return; } catch {}
  }
  moveQueue.push(msg);
}

function getCurrentPlayerDisplayName() {
  return document.getElementById('ags-signedin-name')?.textContent || playerName || 'You';
}

function moderateIncomingDisplayName(value, fallback = 'Opponent') {
  const moderation = window.chessContentModeration;
  if (moderation?.moderateIncomingDisplayName) {
    return moderation.moderateIncomingDisplayName(value, fallback);
  }
  return String(value || '').trim() || fallback;
}

function moderateIncomingChat(value) {
  const moderation = window.chessContentModeration;
  if (moderation?.moderateIncomingChat) return moderation.moderateIncomingChat(value);
  return String(value || '').trim();
}

function showChatModerationMessage(message = '') {
  const messageEl = document.getElementById('online-chat-message');
  if (messageEl) messageEl.textContent = message;
}

function resetChatState() {
  chatMessages = [];
  const messagesEl = document.getElementById('online-chat-messages');
  const inputEl = document.getElementById('online-chat-input');
  if (messagesEl) {
    messagesEl.innerHTML = currentOpponentBlocked
      ? '<div class="chat-empty">Chat is hidden because this player is blocked.</div>'
      : '<div class="chat-empty">Chat is available while playing another person online.</div>';
  }
  if (inputEl) inputEl.value = '';
  showChatModerationMessage();
}

function isGusOpponent(opponent = currentOpponent) {
  return !!opponent && typeof window.isGambitGusIdentity === 'function'
    && window.isGambitGusIdentity(opponent.userId, opponent.name);
}

function renderMatchChatGate(state, opponent = currentOpponent) {
  const gate = document.getElementById('match-chat-gate');
  const title = document.getElementById('match-chat-gate-title');
  const message = document.getElementById('match-chat-gate-message');
  const addButton = document.getElementById('btn-match-chat-friend');
  if (!gate || !title || !message || !addButton) return;

  const name = opponent?.name || 'your opponent';
  const copy = {
    checking: ['Checking chat access', `Checking whether you and ${name} are friends…`],
    waiting: ['Chat needs both players', 'Chat will be available once both player accounts are identified.'],
    stranger: ['Chat is for friends', `Add ${name} as a friend to unlock chat after they accept.`],
    requested: ['Friend request sent', `Chat will unlock when ${name} accepts your friend request.`],
    gus: ['Gus is here to play', 'Chat is not available with Gambit Gus, and Gus cannot be added as a friend.'],
    blocked: ['Chat is unavailable', 'Chat is hidden because this player is blocked.'],
  }[state] || ['Chat unavailable', 'Chat is not available for this match.'];

  title.textContent = copy[0];
  message.textContent = copy[1];
  const canRequest = state === 'stranger' && !!opponent?.userId && !currentOpponentBlocked;
  addButton.style.display = canRequest ? '' : 'none';
  addButton.disabled = state === 'requested';
  addButton.textContent = state === 'requested' ? 'Request sent' : `Add ${name}`;
  if (canRequest) {
    addButton.onclick = () => window.agsRequestLastOpponent?.();
  } else {
    addButton.onclick = null;
  }
  gate.hidden = false;
}

function hideMatchChatGate() {
  const gate = document.getElementById('match-chat-gate');
  if (gate) gate.hidden = true;
}

async function refreshMatchChatFriendGate({ requestSent = false } = {}) {
  if (gameMode !== 'online') return;
  const opponent = currentOpponent;
  const token = ++matchChatFriendCheckToken;
  matchChatFriendRequestSent = requestSent || matchChatFriendRequestSent;

  if (currentOpponentBlocked) {
    matchChatFriendState = 'blocked';
    renderMatchChatGate('blocked', opponent);
    updateChatAvailability();
    return;
  }
  if (isGusOpponent(opponent)) {
    matchChatFriendState = 'gus';
    renderMatchChatGate('gus', opponent);
    chatTransportState = { state: 'unavailable', detail: 'Chat is not available with Gambit Gus.', topicId: '' };
    window.agsDeactivateChat?.();
    updateChatAvailability();
    return;
  }
  if (!opponent?.userId) {
    matchChatFriendState = 'waiting';
    renderMatchChatGate('waiting', opponent);
    updateChatAvailability();
    return;
  }
  if (matchChatFriendRequestSent) {
    matchChatFriendState = 'requested';
    renderMatchChatGate('requested', opponent);
    updateChatAvailability();
    return;
  }

  matchChatFriendState = 'checking';
  renderMatchChatGate('checking', opponent);
  updateChatAvailability();
  try {
    const isFamily = window.agsIsFamilyMember?.(opponent.userId) === true;
    const isFriend = isFamily || await window.agsIsFriendWith?.(opponent.userId);
    if (token !== matchChatFriendCheckToken || opponent.userId !== currentOpponent?.userId) return;
    if (!isFriend) {
      matchChatFriendState = 'stranger';
      renderMatchChatGate('stranger', opponent);
      chatTransportState = { state: 'unavailable', detail: 'Chat is only available between friends.', topicId: '' };
      window.agsDeactivateChat?.();
      updateChatAvailability();
      return;
    }
    matchChatFriendState = 'allowed';
    hideMatchChatGate();
    updateChatAvailability();
    activateChatForCurrentMatch();
  } catch {
    if (token !== matchChatFriendCheckToken) return;
    matchChatFriendState = 'stranger';
    renderMatchChatGate('stranger', opponent);
    chatTransportState = { state: 'unavailable', detail: 'Could not confirm friendship. Chat is unavailable for now.', topicId: '' };
    updateChatAvailability();
  }
}

window.agsRefreshMatchChatGate = refreshMatchChatFriendGate;

function updateChatAvailability() {
  const statusEl = document.getElementById('online-chat-status');
  const inputEl = document.getElementById('online-chat-input');
  const sendBtn = document.getElementById('btn-chat-send');
  const composeEl = document.querySelector('#online-chat .online-chat-compose');
  const chatEl = document.getElementById('online-chat');
  const isOnline = gameMode === 'online';
  const state = chatTransportState.state || 'idle';
  const friendGateBlocks = isOnline && matchChatFriendState !== 'allowed';
  const enabled = isOnline && state === 'ready' && !currentOpponentBlocked && !friendGateBlocks;
  const labels = {
    idle: 'Unavailable',
    connecting: 'Connecting…',
    connected: 'Connecting to match…',
    activating: 'Joining match chat…',
    ready: 'Connected',
    reconnecting: 'Reconnecting…',
    muted: 'Muted',
    unavailable: 'Unavailable',
    error: 'Unavailable',
  };

  if (statusEl) {
    statusEl.textContent = currentOpponentBlocked
      ? 'Blocked'
      : isOnline ? (labels[state] || 'Unavailable') : 'Unavailable';
    statusEl.dataset.state = currentOpponentBlocked ? 'unavailable' : isOnline ? state : 'unavailable';
  }
  if (inputEl) inputEl.disabled = !enabled;
  if (sendBtn) sendBtn.disabled = !enabled;
  if (chatEl) chatEl.style.display = isOnline && !friendGateBlocks ? 'flex' : 'none';
  if (composeEl) composeEl.style.display = currentOpponentBlocked || friendGateBlocks ? 'none' : 'flex';
}

function renderChatMessages() {
  const messagesEl = document.getElementById('online-chat-messages');
  if (!messagesEl) return;

  if (chatMessages.length === 0) {
    messagesEl.innerHTML = currentOpponentBlocked
      ? '<div class="chat-empty">Chat is hidden because this player is blocked.</div>'
      : '<div class="chat-empty">Chat is available while playing another person online.</div>';
    return;
  }

  messagesEl.textContent = '';
  for (const message of chatMessages) appendChatMessageToDOM(message);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendChatMessageToDOM(message) {
  const messagesEl = document.getElementById('online-chat-messages');
  if (!messagesEl) return;
  const empty = messagesEl.querySelector('.chat-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'chat-message ' + message.side;
  const meta = document.createElement('div');
  meta.className = 'chat-message-meta-row';
  const name = document.createElement('span');
  name.className = 'chat-message-meta';
  name.textContent = message.name;
  meta.appendChild(name);
  if (message.side === 'opponent' && message.chatId) {
    const report = document.createElement('button');
    report.type = 'button';
    report.className = 'chat-report-button';
    report.textContent = 'Report';
    report.setAttribute('aria-label', `Report message from ${message.name}`);
    report.addEventListener('click', () => openSafetyReport({ kind: 'message-report', message }));
    meta.appendChild(report);
  }
  const body = document.createElement('div');
  body.className = 'chat-message-body';
  body.textContent = message.text;
  div.append(meta, body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendChatMessage(side, name, text, metadata = {}) {
  if (typeof metadata === 'string') metadata = { chatId: metadata };
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const chatId = String(metadata.chatId || '');
  const existing = chatId && chatMessages.find(message => message.chatId === chatId);
  if (existing) {
    if (existing.text !== trimmed || existing.name !== name) {
      existing.text = trimmed;
      existing.name = name || existing.name;
      existing.topicId = metadata.topicId || existing.topicId;
      existing.createdAt = metadata.createdAt || existing.createdAt;
      existing.from = metadata.from || existing.from;
      renderChatMessages();
    }
    return;
  }
  const message = {
    chatId,
    side,
    name: name || (side === 'self' ? 'You' : 'Opponent'),
    text: trimmed,
    topicId: String(metadata.topicId || ''),
    createdAt: metadata.createdAt || Date.now(),
    from: String(metadata.from || ''),
  };
  chatMessages.push(message);
  if (chatMessages.length > 100) chatMessages = chatMessages.slice(-100);
  appendChatMessageToDOM(message);
}

function getChatErrorMessage(error) {
  if (error?.kind === 'muted') return 'You are temporarily muted in match chat.';
  if (error?.kind === 'banned') return 'Chat is unavailable for this account.';
  if (error?.kind === 'filtered') return 'That message was rejected by the chat filter.';
  if (error?.kind === 'rate-limit') return 'Slow down before sending another message.';
  if (error?.kind === 'authentication') return 'Sign in to use match chat.';
  return error?.message || 'Message could not be sent. Try again.';
}

async function sendChatMessage() {
  if (gameMode !== 'online' || chatTransportState.state !== 'ready' || currentOpponentBlocked) return;
  const inputEl = document.getElementById('online-chat-input');
  if (!inputEl) return;

  const text = inputEl.value.trim();
  if (!text) return;
  const moderation = window.chessContentModeration;
  const moderated = moderation?.moderateOutgoingChat
    ? moderation.moderateOutgoingChat(text)
    : { ok: true, value: text };
  if (!moderated.ok) {
    showChatModerationMessage(moderated.error);
    inputEl.focus();
    return;
  }

  showChatModerationMessage();
  const sendBtn = document.getElementById('btn-chat-send');
  if (sendBtn) sendBtn.disabled = true;
  try {
    if (typeof window.agsSendChatMessage !== 'function') {
      throw new Error('AGS Chat is unavailable.');
    }
    await window.agsSendChatMessage(moderated.value);
    inputEl.value = '';
  } catch (error) {
    showChatModerationMessage(getChatErrorMessage(error));
  } finally {
    if (sendBtn) sendBtn.disabled = chatTransportState.state !== 'ready';
    inputEl.focus();
  }
}

function handleChatInputKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  sendChatMessage();
}

window.sendChatMessage = sendChatMessage;
window.handleChatInputKeydown = handleChatInputKeydown;

window.handleAGSChatState = function(state) {
  chatTransportState = state || { state: 'unavailable', detail: 'Match chat is unavailable.' };
  updateChatAvailability();
  if (state?.detail && ['muted', 'unavailable', 'error'].includes(state.state)) {
    showChatModerationMessage(state.detail);
  }
};

window.handleAGSChatMessage = function(message) {
  if (gameMode !== 'online' || !message) return;
  const isSelf = message.from === window.agsCurrentUserId;
  if (!isSelf && currentOpponentBlocked) return;
  const name = isSelf
    ? moderateIncomingDisplayName(getCurrentPlayerDisplayName(), 'You')
    : moderateIncomingDisplayName(currentOpponent?.name, 'Opponent');
  const text = moderateIncomingChat(message.message);
  if (text) {
    appendChatMessage(isSelf ? 'self' : 'opponent', name, text, {
      chatId: message.chatId,
      topicId: message.topicId,
      createdAt: message.createdAt,
      from: message.from,
    });
  }
};

function setSafetyMessage(id, text, tone = '') {
  const element = document.getElementById(id);
  if (!element) return;
  element.className = `auth-message${tone ? ` ${tone}` : ''}`;
  element.textContent = text || '';
}

function openMatchSafety() {
  if (gameMode !== 'online' || !currentOpponent?.userId || !window.agsCurrentUserId) {
    showChatModerationMessage('Sign in and join an online match to use player safety tools.');
    return;
  }
  const modal = document.getElementById('match-safety-modal');
  const context = document.getElementById('match-safety-opponent');
  const blockButton = document.getElementById('btn-block-current-opponent');
  if (context) context.textContent = `Report or block ${currentOpponent.name || 'this opponent'}. Blocking will not end the current game.`;
  if (blockButton) {
    blockButton.disabled = currentOpponentBlocked;
    blockButton.textContent = currentOpponentBlocked ? 'Player Blocked' : 'Block Player';
  }
  setSafetyMessage('match-safety-message', '');
  if (modal) modal.style.display = 'flex';
}

async function openSafetyReport(target) {
  if (!currentOpponent?.userId || !window.agsCurrentUserId) return;
  activeSafetyReport = target;
  const modal = document.getElementById('report-player-modal');
  const title = document.getElementById('report-player-title');
  const context = document.getElementById('report-player-context');
  const reasonSelect = document.getElementById('report-player-reason');
  const comment = document.getElementById('report-player-comment');
  const block = document.getElementById('report-player-block');
  const submit = document.getElementById('btn-submit-player-report');
  if (title) title.textContent = target.kind === 'message-report' ? 'Report Message' : 'Report Player';
  if (context) {
    context.textContent = target.kind === 'message-report'
      ? `Report this message from ${currentOpponent.name || 'your opponent'}.`
      : `Report ${currentOpponent.name || 'this opponent'}.`;
  }
  if (reasonSelect) {
    reasonSelect.disabled = true;
    reasonSelect.innerHTML = '<option value="">Loading reasons…</option>';
  }
  if (comment) comment.value = '';
  if (block) {
    block.checked = false;
    block.disabled = currentOpponentBlocked;
  }
  if (submit) submit.disabled = true;
  setSafetyMessage('report-player-message', '');
  closeModal('match-safety-modal');
  if (modal) modal.style.display = 'flex';

  const result = await window.agsGetSafetyReasons?.();
  if (!activeSafetyReport || !reasonSelect || !submit) return;
  if (!result?.ok) {
    reasonSelect.innerHTML = '<option value="">Reasons unavailable</option>';
    setSafetyMessage('report-player-message', result?.error || 'Could not load report reasons.', 'error');
    return;
  }
  reasonSelect.textContent = '';
  for (const reason of result.reasons || []) {
    const option = document.createElement('option');
    option.value = reason.title;
    option.textContent = reason.title;
    if (reason.description) option.title = reason.description;
    reasonSelect.appendChild(option);
  }
  if (!reasonSelect.options.length) {
    reasonSelect.innerHTML = '<option value="">No report reasons configured</option>';
    setSafetyMessage('report-player-message', 'Player Safety report reasons are not configured.', 'error');
    return;
  }
  reasonSelect.disabled = false;
  submit.disabled = false;
}

function reportCurrentOpponent() {
  openSafetyReport({ kind: 'player-report' });
}

async function submitSafetyReport() {
  if (!activeSafetyReport || !currentOpponent?.userId) return;
  const reason = document.getElementById('report-player-reason')?.value || '';
  const comment = document.getElementById('report-player-comment')?.value || '';
  const shouldBlock = document.getElementById('report-player-block')?.checked === true;
  const submit = document.getElementById('btn-submit-player-report');
  if (!reason) return;
  if (submit) submit.disabled = true;
  setSafetyMessage('report-player-message', 'Submitting report…');

  const input = {
    userId: currentOpponent.userId,
    reason,
    comment,
  };
  const result = activeSafetyReport.kind === 'message-report'
    ? await window.agsReportChatMessage?.({ ...input, message: activeSafetyReport.message })
    : await window.agsReportPlayer?.(input);

  if (!result?.ok) {
    if (submit) submit.disabled = false;
    setSafetyMessage('report-player-message', result?.error || 'The report could not be submitted.', 'error');
    return;
  }

  // Remove reported content from this player's feed as soon as the report is
  // accepted. The server-side moderation workflow remains responsible for
  // review and enforcement; the reporter should not keep seeing the content.
  if (activeSafetyReport.kind === 'message-report') {
    const reportedChatId = String(activeSafetyReport.message?.chatId || '')
    chatMessages = chatMessages.filter(message => message.chatId !== reportedChatId)
  } else {
    chatMessages = chatMessages.filter(message => message.side !== 'opponent')
  }
  renderChatMessages()

  if (shouldBlock && !currentOpponentBlocked) {
    const blockResult = await window.agsBlockPlayer?.(currentOpponent.userId);
    if (!blockResult?.ok) {
      setSafetyMessage('report-player-message', `Report submitted, but blocking failed: ${blockResult?.error || 'try again.'}`, 'error');
      return;
    }
  }
  const ticketId = String(result.ticketId || '').trim();
  const ticketReference = ticketId ? ` AGS report reference: ${ticketId}.` : '';
  setSafetyMessage(
    'report-player-message',
    `Report submitted. We review valid reports within 24 hours.${ticketReference}`,
    'success'
  );
  window.setTimeout(closeSafetyReport, 700);
}

function closeSafetyReport() {
  activeSafetyReport = null;
  closeModal('report-player-modal');
}

async function blockCurrentOpponent() {
  if (!currentOpponent?.userId || currentOpponentBlocked) return;
  const button = document.getElementById('btn-block-current-opponent');
  if (button) button.disabled = true;
  setSafetyMessage('match-safety-message', 'Blocking player…');
  const result = await window.agsBlockPlayer?.(currentOpponent.userId);
  if (!result?.ok) {
    if (button) button.disabled = false;
    setSafetyMessage('match-safety-message', result?.error || 'Could not block this player.', 'error');
    return;
  }
  if (button) button.textContent = 'Player Blocked';
  setSafetyMessage('match-safety-message', 'Player blocked. The current game will continue.', 'success');
}

window.handleAGSPlayerBlocked = function(userId) {
  if (!currentOpponent?.userId || currentOpponent.userId !== userId) return;
  currentOpponentBlocked = true;
  chatMessages = [];
  chatTransportState = {
    state: 'unavailable',
    detail: 'Chat is hidden because this player is blocked.',
    topicId: '',
  };
  window.agsDeactivateChat?.();
  resetChatState();
  updateChatAvailability();
  const rematchButton = document.getElementById('btn-rematch');
  const friendButton = document.getElementById('btn-add-match-friend');
  if (rematchButton) rematchButton.style.display = 'none';
  if (friendButton) friendButton.style.display = 'none';
  document.getElementById('rematch-notification').style.display = 'none';
};

window.openMatchSafety = openMatchSafety;
window.reportCurrentOpponent = reportCurrentOpponent;
window.submitSafetyReport = submitSafetyReport;
window.closeSafetyReport = closeSafetyReport;
window.blockCurrentOpponent = blockCurrentOpponent;

async function activateChatForCurrentMatch() {
  if (gameMode !== 'online' || currentOpponentBlocked) return;
  let key = '';
  let activation = null;
  if (pendingChatContext?.type === 'session' && pendingChatContext.sessionId) {
    key = `session:${pendingChatContext.sessionId}`;
    // Opponent id rides along so protected child accounts can verify the
    // peer is family before chat opens (main.js childChatGuardError).
    activation = () => window.agsActivateSessionChat?.(pendingChatContext.sessionId, currentOpponent?.userId);
  } else if (pendingChatContext?.type === 'personal' &&
             window.agsCurrentUserId &&
             pendingChatContext.otherUserId) {
    const otherUserId = pendingChatContext.otherUserId;
    key = `personal:${[window.agsCurrentUserId, otherUserId].sort().join(':')}`;
    activation = () => window.agsActivatePersonalChat?.(otherUserId);
  } else if (window.agsCurrentUserId && currentOpponent?.userId) {
    key = `personal:${[window.agsCurrentUserId, currentOpponent.userId].sort().join(':')}`;
    activation = () => window.agsActivatePersonalChat?.(currentOpponent.userId);
  }

  if (!activation) {
    chatTransportState = {
      state: 'unavailable',
      detail: 'Chat requires both players to be signed in.',
      topicId: '',
    };
    updateChatAvailability();
    showChatModerationMessage(chatTransportState.detail);
    return;
  }
  if (chatActivationKey === key) return;
  chatActivationKey = key;
  try {
    await activation();
  } catch (error) {
    if (chatActivationKey !== key) return;
    chatTransportState = {
      state: 'unavailable',
      detail: getChatErrorMessage(error),
      topicId: '',
    };
    updateChatAvailability();
    showChatModerationMessage(chatTransportState.detail);
  }
}

function flushMoveQueue(conn) {
  while (moveQueue.length > 0 && conn?.open) {
    try {
      conn.send(moveQueue[0]);
      moveQueue.shift();
    } catch {
      break;
    }
  }
}

function handleConnectionLost() {
  if (connectionLost) return;  // already handling
  connectionLost = true;
  stopHeartbeat();
  if (peerConn) { try { peerConn.close(); } catch {} peerConn = null; }
  updateChatAvailability();
  markMatchDisconnected(); // starts the 10-minute resume window — the match isn't lost
  showConnBanner('Connection lost. You can resume this game later.', 'error');
  setTimeout(() => {
    closeModal('game-over-modal');
    destroyPeer();
    showScreen('home');
    // The side that *didn't* reload (still logged in, tab still open) never
    // re-triggers hydrateAuthenticatedUser — without this, only a fresh login
    // would ever see the resume prompt, leaving this side with no way back in.
    void window.agsCheckResumableMatch?.();
  }, 2500);
}

function setupCallHandler() {
  peer.on('call', call => {
    const rejectCall = () => { try { call.close(); } catch {} };
    // A media call must come from the same PeerJS identity as the active game
    // data connection. Friendship alone is not sufficient identity binding.
    if (!remotePeerId || call.peer !== remotePeerId) {
      rejectCall();
      return;
    }

    if (mediaCall) {
      // Deterministic glare handling when both players press Video Chat at the
      // same time: the lexicographically smaller peer remains the caller.
      if (videoCallDirection === 'outgoing' && localStream) {
        const localPeerId = String(peer?.id || '');
        if (localPeerId && localPeerId > String(call.peer || '')) {
          const outgoingCall = mediaCall;
          clearVideoCallTimers();
          stopVideoCallMonitor();
          mediaCall = call;
          call.answer(localStream);
          bindMediaCall(call, 'incoming');
          setVideoCallState('connecting');
          try { outgoingCall.close(); } catch {}
          if (typeof window.agsSendEvent === 'function') {
            window.agsSendEvent('video_call_glare_resolved', { role: 'answerer' });
          }
          return;
        }
      }
      rejectCall();
      return;
    }
    if (pendingCall || !['idle', 'ringing'].includes(videoCallState)) {
      rejectCall();
      return;
    }
    const ring = () => {
      pendingCall = call;
      setVideoCallState('ringing');
      document.getElementById('video-call-notification').style.display = 'flex';
      call.on('close', () => {
        if (pendingCall === call && !videoCallEnding) endVideoChat('remote-ended', true);
      });
      call.on('error', error => {
        if (pendingCall !== call || videoCallEnding) return;
        console.warn('[video-call] incoming call failed before answer:', error?.message || error);
        endVideoChat('media-error', true);
      });
      if (pendingCallTimeout) clearTimeout(pendingCallTimeout);
      pendingCallTimeout = setTimeout(() => {
        if (pendingCall === call) declineVideoCall();
      }, VIDEO_CALL_CONNECT_TIMEOUT_MS);
    };
    // Friends-only, enforced on the receiving side too: the caller's client
    // hides its button, but a tampered client (or a stale friendship) can
    // still dial — never surface a ring until AGS confirms the friendship.
    if (videoChatAllowed) { ring(); return; }
    const opponentId = currentOpponent?.userId;
    if (!opponentId || currentOpponentBlocked || typeof window.agsIsFriendWith !== 'function') {
      try { call.close(); } catch {}
      return;
    }
    window.agsIsFriendWith(opponentId).then(isFriend => {
      // Re-check state after the await: another ring may have landed, or the
      // opponent may have changed while the status call was in flight.
      if (!isFriend || pendingCall || mediaCall || videoCallState !== 'idle' ||
          opponentId !== currentOpponent?.userId || call.peer !== remotePeerId) {
        try { call.close(); } catch {}
        return;
      }
      videoChatAllowed = true;
      ring();
    }).catch(() => { try { call.close(); } catch {} });
  });
}

async function createOnlineRoom(options = {}) {
  destroyPeer();
  const generation = peerLifecycleGeneration;
  const friendInviteId = options.friendInvite
    ? 'invite-' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2))
    : '';
  showWaitingScreen('host');

  let createdPeer;
  try {
    createdPeer = await createGamePeer();
  } catch (error) {
    console.warn('Could not create PeerJS room:', error);
    showPeerSetupFailure('Could not create the match room. Check your connection and try again.', generation);
    return false;
  }
  if (generation !== peerLifecycleGeneration) {
    try { createdPeer.destroy(); } catch {}
    return false;
  }
  peer = createdPeer;
  setupCallHandler();
  attachPeerLifecycle(createdPeer, generation, 'Could not reconnect the match room. Check your connection and try again.');
  armPeerOpenTimeout(createdPeer, generation, 'The match room took too long to connect. Check your connection and try again.');

  createdPeer.on('open', id => {
    if (generation !== peerLifecycleGeneration || peer !== createdPeer) return;
    clearPeerOpenTimeout();

    const showLink = (base, { preserveStatus = false } = {}) => {
      if (generation !== peerLifecycleGeneration || peer !== createdPeer) return;
      const inviteUrl = new URL(base, window.location.href);
      inviteUrl.search = '';
      inviteUrl.hash = '';
      inviteUrl.searchParams.set('peer', id);
      // So the invitee's client can auto-friend the host once they sign in or
      // register (same invitedBy pipeline the async referral link uses) —
      // without this, a brand-new player joining via link never becomes
      // friends with the person who invited them.
      if (window.agsCurrentUserId) inviteUrl.searchParams.set('invitedBy', window.agsCurrentUserId);
      currentInviteLink = inviteUrl.toString();
      document.getElementById('invite-link-text').textContent = currentInviteLink;
      document.getElementById('invite-link-section').style.display = 'block';
      if (!preserveStatus) {
        document.getElementById('waiting-sub').textContent = options.friendInvite
          ? `Sending invite to ${options.friendInvite.displayName || 'your friend'}…`
          : 'Waiting for your friend to join…';
      }
      document.getElementById('waiting-spinner').style.display = 'block';
      const shareRowEl = document.getElementById('waiting-share-row');
      if (shareRowEl) {
        shareRowEl.innerHTML = '';
        if (typeof window.agsShareRow === 'function') {
          window.agsShareRow(shareRowEl, currentInviteLink);
        }
      }
    };

    const native = !!window.Capacitor?.isNativePlatform?.();
    const base = native
      ? (window.agsPublicAppURL || 'https://junaili.github.io/chess/')
      : window.location.href.split('?')[0];
    const isLocal = !native && ['localhost', '127.0.0.1'].includes(window.location.hostname);
    showLink(base);
    if (options.friendInvite) {
      void sendFriendMatchInvite(options.friendInvite, id, generation, friendInviteId);
    }

    if (isLocal) {
      const ac = new AbortController();
      const ipTimeout = setTimeout(() => ac.abort(), 3000);
      fetch('https://api4.ipify.org', { signal: ac.signal })
        .then(r => r.text())
        .then(ip => {
          clearTimeout(ipTimeout);
          const portSuffix = window.location.port ? `:${window.location.port}` : '';
          showLink(`${window.location.protocol}//${ip.trim()}${portSuffix}${window.location.pathname}`, { preserveStatus: true });
        })
        .catch(() => { clearTimeout(ipTimeout); });
    }
  });

  createdPeer.on('connection', conn => {
    if (generation !== peerLifecycleGeneration || peer !== createdPeer) {
      try { conn.close(); } catch {}
      return;
    }
    if (typeof conn.send !== 'function') return;
    if (peerConn) {
      // Already have a connection (pending or open) — explicitly close the
      // duplicate so it cannot linger and emit stale events later.
      try { conn.close(); } catch {}
      return;
    }
    peerConn = conn;
    setupPeerConnection(conn, 'host');
  });

  createdPeer.on('error', err => {
    if (generation !== peerLifecycleGeneration || peer !== createdPeer) return;
    if (isRetryablePeerSignalError(err)) {
      console.warn('Match-room signaling interrupted; PeerJS is reconnecting:', err?.message || err);
      const sub = document.getElementById('waiting-sub');
      const spinner = document.getElementById('waiting-spinner');
      if (sub) sub.textContent = 'Match service connection interrupted — reconnecting…';
      if (spinner) spinner.style.display = 'block';
      return;
    }
    clearPeerOpenTimeout();
    if (game && gameMode === 'online') {
      console.warn('Peer error during game:', err.type, err.message);
      handleConnectionLost();
    } else {
      console.warn('Connection error:', err.type, err.message);
      const sub = document.getElementById('waiting-sub');
      if (sub) sub.textContent = 'Connection error — ' + (err.message || 'Could not connect.');
      setTimeout(() => {
        if (generation !== peerLifecycleGeneration) return;
        destroyPeer();
        showScreen('home');
      }, 2000);
    }
  });
  return true;
}

function startFriendMatchInvite(friend) {
  if (!friend?.userId) return;
  if (!window.agsCurrentUserId || typeof window.agsSendMatchInvite !== 'function') {
    alert('Sign in before inviting a friend.');
    return;
  }

  gameMode = 'online';
  playerColor = 'white';
  setCurrentOpponent(friend.displayName || 'Friend', friend.userId);
  void createOnlineRoom({ friendInvite: friend });
  pendingChatContext = { type: 'personal', otherUserId: friend.userId };
}

async function sendFriendMatchInvite(friend, peerId, generation = peerLifecycleGeneration, existingInviteId = '') {
  const inviteId = existingInviteId || ('invite-' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)));
  if (generation === peerLifecycleGeneration) activeFriendInviteId = inviteId;
  let result;
  try {
    result = await window.agsSendMatchInvite(friend.userId, {
      inviteId,
      peerId,
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[invite] match delivery failed:', error);
    result = {
      ok: false,
      retryable: true,
      error: 'Could not send the match invite. Check your connection and retry.',
    };
  }

  if (generation !== peerLifecycleGeneration || peer?.id !== peerId) return result;

  const sub = document.getElementById('waiting-sub');
  if (!result?.ok) {
    if (sub) sub.textContent = `${result?.error || 'Could not send the match invite.'} You can still share the link below.`;
    if (result?.retryable) {
      const row = document.querySelector('#waiting-share-row .share-row');
      let retry = row?.querySelector('[data-retry-friend-invite]');
      if (row && !retry) {
        retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'share-chip share-chip-copy';
        retry.dataset.retryFriendInvite = 'true';
        retry.textContent = '↻ Retry invite';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          retry.textContent = 'Retrying…';
          const retried = await sendFriendMatchInvite(friend, peerId, generation, inviteId);
          if (!retried?.ok && retried?.retryable && generation === peerLifecycleGeneration) {
            retry.disabled = false;
            retry.textContent = '↻ Retry invite';
          } else if (!retried?.ok) {
            retry.remove();
          }
        });
        row.appendChild(retry);
      }
    }
    return result;
  }
  document.querySelector('#waiting-share-row [data-retry-friend-invite]')?.remove();
  if (sub) {
    const retryNote = result.attempts > 1 ? ' after reconnecting' : '';
    sub.textContent = `Invite sent${retryNote} to ${friend.displayName || 'your friend'}. Waiting for them to accept…`;
  }
  return result;
}

function showFriendMatchInvite(invite) {
  clearTimeout(pendingFriendMatchInviteTimer);
  pendingFriendMatchInvite = invite;
  const fromName = invite.fromName || 'A friend';
  const nameEl = document.getElementById('friend-match-invite-name');
  const detailEl = document.getElementById('friend-match-invite-detail');
  if (nameEl) nameEl.textContent = `${fromName} invited you to play`;
  if (detailEl) detailEl.textContent = 'Accept to join the match now.';
  document.getElementById('friend-match-invite-notification').style.display = 'flex';
  const sentAt = Date.parse(invite?.sentAt || '');
  const remaining = Number.isFinite(sentAt)
    ? Math.max(0, (10 * 60 * 1000) - (Date.now() - sentAt))
    : 10 * 60 * 1000;
  pendingFriendMatchInviteTimer = setTimeout(() => {
    if (pendingFriendMatchInvite !== invite) return;
    clearFriendMatchInvite();
  }, remaining);
}

function clearFriendMatchInvite() {
  clearTimeout(pendingFriendMatchInviteTimer);
  pendingFriendMatchInviteTimer = null;
  pendingFriendMatchInvite = null;
  const notification = document.getElementById('friend-match-invite-notification');
  if (notification) notification.style.display = 'none';
}

function acceptFriendMatchInvite() {
  const invite = pendingFriendMatchInvite;
  clearFriendMatchInvite();
  if (!invite?.peerId) return;
  const sentAt = Date.parse(invite.sentAt || '');
  if (Number.isFinite(sentAt) && Date.now() - sentAt > 10 * 60 * 1000) {
    alert('That match invite has expired. Ask your friend to send a new one.');
    return;
  }
  gameMode = 'online';
  setCurrentOpponent(invite.fromName || 'Friend', invite.fromUserId || '');
  void joinOnlineRoom(invite.peerId);
  if (invite.fromUserId) {
    pendingChatContext = { type: 'personal', otherUserId: invite.fromUserId };
  }
}

function declineFriendMatchInvite() {
  const invite = pendingFriendMatchInvite;
  clearFriendMatchInvite();
  if (invite?.fromUserId && typeof window.agsSendMatchDecline === 'function') {
    void window.agsSendMatchDecline(invite.fromUserId, invite.inviteId)
      .then(result => {
        if (!result?.ok) console.warn('[invite] decline was not delivered:', result?.error || 'unknown error');
      })
      .catch(error => {
        console.warn('[invite] decline delivery failed:', error);
      });
  }
}

function handleMatchDeclined(invite) {
  if (!activeFriendInviteId || invite?.inviteId !== activeFriendInviteId) return;
  const generation = peerLifecycleGeneration;
  activeFriendInviteId = '';
  const name = invite?.fromName || 'Your friend';
  const sub = document.getElementById('waiting-sub');
  if (sub) sub.textContent = `${name} declined your match invite.`;
  const spinner = document.getElementById('waiting-spinner');
  if (spinner) spinner.style.display = 'none';
  setTimeout(() => {
    if (generation !== peerLifecycleGeneration) return;
    destroyPeer();
    showScreen('home');
  }, 2500);
}

window.startFriendMatchInvite = startFriendMatchInvite;
window.showFriendMatchInvite = showFriendMatchInvite;
window.acceptFriendMatchInvite = acceptFriendMatchInvite;
window.declineFriendMatchInvite = declineFriendMatchInvite;
window.handleMatchDeclined = handleMatchDeclined;
window.clearFriendMatchInvite = clearFriendMatchInvite;

// Bridge for src/main.js: join a live-match invite link (?peer=) once the
// sign-in gate on the invite screen has been resolved.
window.agsJoinPeer = hostPeerId => {
  if (!hostPeerId) return;
  gameMode = 'online';
  void joinOnlineRoom(hostPeerId);
};

async function joinOnlineRoom(hostPeerId) {
  destroyPeer();
  const generation = peerLifecycleGeneration;
  showWaitingScreen('joiner');
  hostPeerId = normalizePeerTarget(hostPeerId);
  if (!hostPeerId) {
    showPeerSetupFailure('This match invite is invalid. Ask your friend to send a new one.', generation);
    return false;
  }

  let createdPeer;
  try {
    createdPeer = await createGamePeer();
  } catch (error) {
    console.warn('Could not create PeerJS joiner:', error);
    showPeerSetupFailure('Could not start the match connection. Check your connection and try again.', generation);
    return false;
  }
  if (generation !== peerLifecycleGeneration) {
    try { createdPeer.destroy(); } catch {}
    return false;
  }
  peer = createdPeer;
  setupCallHandler();
  attachPeerLifecycle(createdPeer, generation, 'Could not reconnect to the match service. Ask your friend for a new invite.');
  armPeerOpenTimeout(createdPeer, generation, 'The match connection took too long to start. The invite may have expired.');

  createdPeer.on('open', () => {
    if (generation !== peerLifecycleGeneration || peer !== createdPeer) return;
    clearPeerOpenTimeout();
    if (peerConn) return;
    try {
      const conn = createdPeer.connect(hostPeerId, { reliable: true });
      peerConn = conn;
      setupPeerConnection(conn, 'joiner');
    } catch (error) {
      console.warn('Join connect failed:', error);
      showPeerSetupFailure('Could not connect to your friend. The invite may have expired.', generation);
    }
  });

  createdPeer.on('error', err => {
    if (generation !== peerLifecycleGeneration || peer !== createdPeer) return;
    if (isRetryablePeerSignalError(err)) {
      console.warn('Join signaling interrupted; PeerJS is reconnecting:', err?.message || err);
      const sub = document.getElementById('waiting-sub');
      const spinner = document.getElementById('waiting-spinner');
      if (sub) sub.textContent = 'Match service connection interrupted — reconnecting…';
      if (spinner) spinner.style.display = 'block';
      return;
    }
    clearPeerOpenTimeout();
    if (game && gameMode === 'online') {
      console.warn('Peer error during game:', err.type, err.message);
      handleConnectionLost();
    } else {
      console.warn('Join error:', err.type, err.message);
      const sub = document.getElementById('waiting-sub');
      if (sub) sub.textContent = 'Could not connect — ' + (err.message || 'The link may have expired.');
      setTimeout(() => {
        if (generation !== peerLifecycleGeneration) return;
        destroyPeer();
        showScreen('home');
      }, 2000);
    }
  });
  return true;
}

const PEER_MESSAGE_MAX_BYTES = 128 * 1024;
const PEER_NAME_MAX_CHARS = 64;
const PEER_USER_ID_MAX_CHARS = 128;
const PEER_MOVE_MAX_COUNT = 500;
const PROMOTION_TYPES = new Set(['queen', 'rook', 'bishop', 'knight']);

function sanitizePeerText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizePeerMove(value) {
  if (!value || typeof value !== 'object') return null;
  const coords = [value.fr, value.fc, value.toR, value.toC];
  if (!coords.every(Number.isInteger) || !coords.every(n => n >= 0 && n < 8)) return null;
  const promType = PROMOTION_TYPES.has(value.promType) ? value.promType : 'queen';
  return { fr: value.fr, fc: value.fc, toR: value.toR, toC: value.toC, promType };
}

function isPeerMessageWithinLimit(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= PEER_MESSAGE_MAX_BYTES;
  } catch {
    return false;
  }
}

function setupPeerConnection(conn, role) {
  const generation = peerLifecycleGeneration;
  let connectionOpened = !!conn.open;
  let connectionOpenHandled = false;
  let preGameFailureHandled = false;
  remotePeerId = conn.peer;
  connRole = role;

  const handlePreGameFailure = message => {
    if (preGameFailureHandled || game || generation !== peerLifecycleGeneration || peerConn !== conn) return;
    preGameFailureHandled = true;
    stopHeartbeat();
    peerConn = null;
    remotePeerId = null;
    if (role === 'host') {
      const sub = document.getElementById('waiting-sub');
      if (sub) sub.textContent = 'A connection attempt did not finish. Still waiting for your friend…';
      return;
    }
    showPeerSetupFailure(message || 'Could not connect to the match. The invite may have expired.', generation);
  };

  const connectionOpenTimer = connectionOpened ? null : setTimeout(() => {
    if (connectionOpened || generation !== peerLifecycleGeneration || peerConn !== conn) return;
    handlePreGameFailure('The match connection timed out. The invite may have expired.');
    try { conn.close(); } catch {}
  }, PEER_OPEN_TIMEOUT_MS);

  const handleConnectionOpen = () => {
    if (connectionOpenHandled || generation !== peerLifecycleGeneration || peerConn !== conn) return;
    connectionOpenHandled = true;
    connectionOpened = true;
    if (connectionOpenTimer) clearTimeout(connectionOpenTimer);
    startHeartbeat(conn);

    if (role === 'host') {
      if (game) {
        // Reconnect — joiner will send reconnect_req, then we send resync
        connectionLost = false;
        updateChatAvailability();
        hideConnBanner();
      } else {
        activeFriendInviteId = '';
        const joinerColor = playerColor === 'white' ? 'black' : 'white';
        const myName = document.getElementById('ags-signedin-name')?.textContent || playerName || 'Opponent';
        const myId   = window.agsCurrentUserId || '';
        const myRating = window.agsGetRating?.() ?? null;
        try {
          conn.send({ type: 'game_start', yourColor: joinerColor, opponentName: myName, opponentId: myId, rating: myRating });
        } catch (error) {
          console.warn('Could not send the initial game state:', error);
          handlePreGameFailure('Could not start the match connection. Still waiting for your friend…');
          try { conn.close(); } catch {}
          return;
        }
        startGame();
      }
    } else {
      connectionLost = false;   // unlock the board as soon as the connection re-opens
      updateChatAvailability();
      if (game) {
        // Reconnect — signal host to send resync
        try { conn.send({ type: 'reconnect_req' }); } catch {}
      }
      // First connection: wait for game_start from host
    }

    flushMoveQueue(conn);
    updateChatAvailability();
  };
  conn.on('open', handleConnectionOpen);
  if (conn.open) queueMicrotask(handleConnectionOpen);

  conn.on('data', data => {
    if (!isPeerMessageWithinLimit(data) || typeof data.type !== 'string') {
      try { conn.close(); } catch {}
      return;
    }
    if (data.type === 'ping') {
      try { conn.send({ type: 'pong' }); } catch {}
      return;
    }
    if (data.type === 'pong') {
      lastPongTime = Date.now();
      return;
    }

    if (data.type === 'game_start') {
      if (!['white', 'black'].includes(data.yourColor)) return;
      const opponentName = moderateIncomingDisplayName(
        sanitizePeerText(data.opponentName, PEER_NAME_MAX_CHARS),
        'Opponent'
      );
      const opponentId = sanitizePeerText(data.opponentId, PEER_USER_ID_MAX_CHARS);
      playerColor = data.yourColor;
      setCurrentOpponent(opponentName, opponentId);
      if (opponentId && opponentName) {
        if (typeof window.cacheDisplayName === 'function') window.cacheDisplayName(opponentId, opponentName);
      }
      window.agsSetOpponentRating?.(data.rating);
      startGame();
      // Show host's identity as our opponent
      const oppColor = data.yourColor === 'white' ? 'black' : 'white';
      setPlayerInfo(oppColor, opponentName, opponentId);
      // Send back our own identity
      const myName = document.getElementById('ags-signedin-name')?.textContent || playerName || 'Opponent';
      const myId   = window.agsCurrentUserId || '';
      const myRating = window.agsGetRating?.() ?? null;
      try { conn.send({ type: 'player_info', name: myName, userId: myId, rating: myRating }); } catch {}
    } else if (data.type === 'player_info') {
      const opponentName = moderateIncomingDisplayName(
        sanitizePeerText(data.name, PEER_NAME_MAX_CHARS),
        'Opponent'
      );
      const opponentId = sanitizePeerText(data.userId, PEER_USER_ID_MAX_CHARS);
      setCurrentOpponent(opponentName, opponentId);
      if (opponentId && opponentName) {
        if (typeof window.cacheDisplayName === 'function') window.cacheDisplayName(opponentId, opponentName);
      }
      window.agsSetOpponentRating?.(data.rating);
      const oppColor = playerColor === 'white' ? 'black' : 'white';
      setPlayerInfo(oppColor, opponentName, opponentId);
      refreshMatchChatFriendGate();
      saveActiveMatch(); // host: opponent identity only becomes known here, after startGame() already ran
    } else if (data.type === 'move') {
      const move = normalizePeerMove(data);
      if (move) applyOpponentMove(move.fr, move.fc, move.toR, move.toC, move.promType);
    } else if (data.type === 'reconnect_req') {
      // Joiner reconnected — send full game state so they can resync
      try { conn.send({ type: 'resync', moves: moveLog }); } catch {}
      connectionLost = false;
      reconnectCount = 0;
      updateChatAvailability();
      hideConnBanner();
      showConnBanner('Opponent reconnected!', 'success');
    } else if (data.type === 'resync') {
      if (connRole !== 'joiner' || !Array.isArray(data.moves) || data.moves.length > PEER_MOVE_MAX_COUNT) return;
      const moves = data.moves.map(normalizePeerMove);
      if (moves.some(move => !move)) return;
      const rebuiltGame = new ChessGame();
      for (const move of moves) {
        if (!rebuiltGame.makeMove(move.fr, move.fc, move.toR, move.toC, move.promType)) return;
      }
      // Replay all moves on a fresh board
      moveQueue = [];
      reconnectCount = 0;
      connectionLost = false;
      game = new ChessGame();
      document.getElementById('move-list').innerHTML = '';
      document.getElementById('captured-by-white').innerHTML = '';
      document.getElementById('captured-by-black').innerHTML = '';
      for (const m of moves) {
        const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
        game.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
        addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
      }
      updateCapturedPieces();
      updateStatus();
      renderBoard();
      updateChatAvailability();
      showConnBanner('Reconnected!', 'success');
    } else if (data.type === 'resign') {
      showConnBanner('Opponent resigned — returning to menu…', 'success');
      connectionLost = true;
      stopHeartbeat();
      updateChatAvailability();
      setTimeout(() => {
        closeModal('game-over-modal');
        destroyPeer();
        showScreen('home');
      }, 2500);
    } else if (data.type === 'rematch_request') {
      if (currentOpponentBlocked) return;
      if (rematchPending && connRole === 'host') {
        // Both clicked Rematch simultaneously — host takes initiative
        sendRematchStart();
      } else if (rematchPending && connRole === 'joiner') {
        // Joiner already requested a rematch; acknowledge host's matching request
        try { conn.send({ type: 'rematch_accept' }); } catch {}
        setRematchMessage('Both players requested a rematch. Starting...', 'success');
        closeModal('game-over-modal');
        document.getElementById('rematch-notification').style.display = 'none';
      } else if (!rematchPending) {
        stopGameOverCountdown();
        setRematchMessage('Your opponent requested a rematch. Choose Rematch to accept.', 'pending');
        document.getElementById('rematch-notification').style.display = 'flex';
      }
      // If rematchPending && joiner, just wait — host will send rematch_start
    } else if (data.type === 'rematch_accept') {
      if (currentOpponentBlocked) return;
      // Only the host receives this (joiner accepted host's request)
      sendRematchStart();
    } else if (data.type === 'rematch_decline') {
      rematchPending = false;
      const btn = document.getElementById('btn-rematch');
      if (btn) { btn.textContent = 'Opponent declined'; btn.disabled = true; }
      setRematchMessage('Your opponent declined the rematch request.', 'muted');
      if (document.getElementById('game-over-modal').style.display === 'flex') startGameOverCountdown();
    } else if (data.type === 'rematch_start') {
      if (currentOpponentBlocked) return;
      playerColor = data.yourColor;
      startRematch();
    } else if (data.type === 'highfive') {
      // Live-only notification — the coins/kudos were already awarded
      // server-side before this message was even sent (see sendHighFive()).
      // If this arrives after the receiving player left, that's fine: their
      // next /club/status refresh shows the correct balance regardless.
      if (currentOpponentBlocked) return;
      const fromName = sanitizePeerText(data.fromName, PEER_NAME_MAX_CHARS) || 'Your opponent';
      showConnBanner(`🙌 ${fromName} sent you a High Five! +5 🪙`, 'success');
    }
  });

  conn.on('close', () => {
    if (connectionOpenTimer) clearTimeout(connectionOpenTimer);
    if (peerConn !== conn) return;   // stale event from a replaced/manually-closed connection
    if (!game) {
      handlePreGameFailure('The match connection closed before the game started. Ask your friend for a new invite.');
      return;
    }
    if (isGameActiveStatus(game.status)) {
      handleConnectionLost();
    }
  });

  conn.on('error', err => {
    if (connectionOpenTimer) clearTimeout(connectionOpenTimer);
    console.error('Peer connection error:', err);
    if (peerConn !== conn) return;
    if (!game) {
      handlePreGameFailure('Could not establish the match connection. Check your connection and try again.');
      return;
    }
    if (isGameActiveStatus(game.status)) {
      handleConnectionLost();
    }
  });
}

function stopMatchmakingWaitTimer() {
  if (matchmakingWaitInterval !== null) {
    clearInterval(matchmakingWaitInterval);
    matchmakingWaitInterval = null;
  }
  const wait = document.getElementById('matchmaking-wait');
  if (wait) wait.style.display = 'none';
}

function formatMatchmakingWaitTime(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteText = String(minutes).padStart(2, '0');
  const secondText = String(seconds).padStart(2, '0');
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${minuteText}:${secondText}`
    : `${minuteText}:${secondText}`;
}

function startMatchmakingWaitTimer(startedAt) {
  stopMatchmakingWaitTimer();
  const wait = document.getElementById('matchmaking-wait');
  const time = document.getElementById('matchmaking-wait-time');
  if (!wait || !time) return;

  const update = () => {
    time.textContent = formatMatchmakingWaitTime(Date.now() - startedAt);
  };
  update();
  wait.style.display = 'flex';
  matchmakingWaitInterval = setInterval(update, 1000);
}

function showWaitingScreen(role) {
  stopMatchmakingWaitTimer();
  showScreen('waiting');
  const messages = {
    'host':               ['🎮', 'Invite your friend',      'Share the link below. The game starts when they open it.'],
    'joiner':             ['⏳', 'Joining game…',           'Connecting to your friend. Please wait.'],
    'matchmaking':        ['🔍', 'Finding opponent…',       'Searching for a random opponent. This may take a moment.'],
    'gus-matchmaking':    ['♞', 'Summoning Gambit Gus…',    'Gus is grabbing his board — the game usually starts within 2 minutes.'],
    'matchmaking-host':   ['⚡', 'Match found!',            'Setting up the board.'],
    'matchmaking-joiner': ['⚡', 'Match found!',            'Setting up the board.'],
  };
  const [icon, title, sub] = messages[role] || messages['joiner'];
  document.getElementById('waiting-icon').textContent = icon;
  document.getElementById('waiting-title').textContent = title;
  document.getElementById('waiting-sub').textContent = sub;
  document.getElementById('invite-link-section').style.display = 'none';
  document.getElementById('waiting-spinner').style.display = 'block';
  // Only the random "Find a Chess Buddy" queue can actually pair you with
  // Gus as a fallback — the direct Gus challenge already knows who you're
  // playing, and friend invites/joins aren't matchmaking at all.
  const learnGusBtn = document.getElementById('btn-learn-about-gus');
  if (learnGusBtn) learnGusBtn.style.display = role === 'matchmaking' ? '' : 'none';
}

function pickWhiteUserId(memberUserIds = [], sessionId = '') {
  const sorted = memberUserIds.slice().sort()
  if (sorted.length < 2) return sorted[0] || ''
  const seed = `${sessionId || ''}|${sorted.join('|')}`
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 2 === 0 ? sorted[0] : sorted[1]
}

function cancelOnlineGame() {
  if (gameMode === 'online' && game && isGameActiveStatus(game.status)) {
    void forfeitOnlineMatchAndGoHome();
    return;
  }
  destroyPeer();
  showScreen('home');
}

function cancelWaiting() {
  if (matchmakingActive) {
    matchmakingActive = false;
    stopMatchmakingWaitTimer();
    if (typeof window.agsCancelMatchmaking === 'function') {
      void window.agsCancelMatchmaking();
    }
    destroyPeer();
    showScreen('home');
  } else {
    cancelOnlineGame();
  }
}

function startRandomMatchmaking() {
  startQueueMatchmaking('random');
}

// "Play with Gus": the same real-matchmaking + P2P flow as Play vs Random —
// src/gus.js additionally asks the backend to summon the bot immediately
// instead of leaving the player to wait out the humans-first gate.
function startGusMatchmaking() {
  startQueueMatchmaking('gus');
}

function startQueueMatchmaking(opponentKind) {
  const startFn = opponentKind === 'gus' ? window.agsStartGusMatchmaking : window.agsStartMatchmaking;
  if (typeof startFn !== 'function') {
    alert(opponentKind === 'gus'
      ? 'Sign in to challenge Gambit Gus.'
      : 'Sign in to play against random players.');
    return;
  }
  matchmakingActive = true;
  gameMode = 'online';
  const queueStartedAt = Date.now();
  showWaitingScreen(opponentKind === 'gus' ? 'gus-matchmaking' : 'matchmaking');
  startMatchmakingWaitTimer(queueStartedAt);
  if (typeof window.agsPrepareSessionChat === 'function') window.agsPrepareSessionChat();
  if (typeof window.agsSendEvent === 'function') window.agsSendEvent('matchmaking_started', { opponent: opponentKind });
  startFn(
    async function onFound(match) {
      if (!matchmakingActive) return;
      const memberUserIds = Array.isArray(match) ? match : match?.memberUserIds;
      const sessionId = match?.sessionId || '';
      if (!Array.isArray(memberUserIds) || memberUserIds.length < 2) {
        matchmakingActive = false;
        stopMatchmakingWaitTimer();
        destroyPeer();
        showScreen('home');
        alert('Match found but player information was incomplete. Please try again.');
        return;
      }
      if (typeof window.agsSendEvent === 'function') {
        window.agsSendEvent('matchmaking_matched', { wait_time_ms: Date.now() - queueStartedAt, opponent: opponentKind });
      }
      const sorted = memberUserIds.slice().sort();
      const myId   = window.agsCurrentUserId;
      const isHost = myId === sorted[0];
      const hostId = sorted[0];
      const peerId = hostId.replace(/-/g, '');
      const whiteUserId = pickWhiteUserId(memberUserIds, sessionId);

      playerColor = myId === whiteUserId ? 'white' : 'black';
      matchmakingActive = false;
      showWaitingScreen(isHost ? 'matchmaking-host' : 'matchmaking-joiner');
      document.getElementById('waiting-sub').textContent = `Setting up the board — you are ${playerColor === 'white' ? 'White' : 'Black'}.`;

      destroyPeer();
      const peerGeneration = peerLifecycleGeneration;
      pendingChatContext = sessionId
        ? { type: 'session', sessionId }
        : null;
      let createdPeer;
      try {
        createdPeer = await createGamePeer(isHost ? peerId : undefined);
      } catch (error) {
        if (peerGeneration !== peerLifecycleGeneration) return;
        console.warn('Could not create matchmaking PeerJS connection:', error);
        showPeerSetupFailure('Could not start the match connection. Check your connection and try again.', peerGeneration);
        return;
      }
      if (peerGeneration !== peerLifecycleGeneration) {
        try { createdPeer.destroy(); } catch {}
        return;
      }
      peer = createdPeer;
      setupCallHandler();
      attachPeerLifecycle(createdPeer, peerGeneration, 'Could not reconnect to the matched opponent. Please try again.');
      armPeerOpenTimeout(createdPeer, peerGeneration, 'The match connection took too long to start. Check your connection and try again.');

      if (isHost) {
        // Signaling reconnects can emit `open` more than once. Keep the
        // connection listener outside it so one opponent creates one game.
        createdPeer.on('connection', conn => {
          if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) {
            try { conn.close(); } catch {}
            return;
          }
          if (peerConn) {
            try { conn.close(); } catch {}
            return;
          }
          peerConn = conn;
          setupPeerConnection(conn, 'host');
        });
        createdPeer.on('open', () => {
          if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) return;
          clearPeerOpenTimeout();
        });
      } else {
        createdPeer.on('open', () => {
          if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) return;
          clearPeerOpenTimeout();
          if (peerConn) return;
          setTimeout(() => {
            if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) return;
            if (peerConn) return;
            try {
              const conn = createdPeer.connect(peerId, { reliable: true });
              peerConn = conn;
              setupPeerConnection(conn, 'joiner');
            } catch (error) {
              console.warn('Could not connect to the matched opponent:', error);
              showPeerSetupFailure('Could not connect to the matched opponent. Please try again.', peerGeneration);
            }
          }, 1500);
        });
      }

      createdPeer.on('error', err => {
        if (peerGeneration !== peerLifecycleGeneration || peer !== createdPeer) return;
        if (isRetryablePeerSignalError(err)) {
          console.warn('Matchmaking signaling interrupted; PeerJS is reconnecting:', err?.message || err);
          const sub = document.getElementById('waiting-sub');
          const spinner = document.getElementById('waiting-spinner');
          if (sub) sub.textContent = 'Match service connection interrupted — reconnecting…';
          if (spinner) spinner.style.display = 'block';
          return;
        }
        clearPeerOpenTimeout();
        if (game && gameMode === 'online') {
          handleConnectionLost();
        } else {
          alert('P2P connection failed: ' + err.message + '\nPlease try again.');
          destroyPeer();
          showScreen('home');
        }
      });
    },
    function onTimeout() {
      if (!matchmakingActive) return;
      matchmakingActive = false;
      stopMatchmakingWaitTimer();
      if (typeof window.agsSendEvent === 'function') {
        window.agsSendEvent('matchmaking_timeout', { wait_time_ms: Date.now() - queueStartedAt, opponent: opponentKind });
      }
      destroyPeer();
      showScreen('home');
      alert(opponentKind === 'gus'
        ? "Gus couldn't make it to the board this time. Please try again in up to 2 minutes."
        : 'No opponent found. Try again in a moment.');
    },
    function onError(msg) {
      if (!matchmakingActive) return;
      matchmakingActive = false;
      stopMatchmakingWaitTimer();
      destroyPeer();
      showScreen('home');
      alert(msg);
    }
  );
}

// ─── Invite link actions ──────────────────────────────────────────────────────

function copyInviteLink() {
  if (!currentInviteLink) return;
  navigator.clipboard.writeText(currentInviteLink).then(() => {
    const btn = document.getElementById('btn-copy');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  }).catch(() => {
    // Fallback for browsers without clipboard API
    prompt('Copy this link:', currentInviteLink);
  });
}

function shareInviteLink() {
  if (!currentInviteLink) return;
  if (navigator.share) {
    navigator.share({
      title: "Ethan's Chess — Join my game!",
      text: "Let's play chess! Tap the link to join my game.",
      url: currentInviteLink
    }).catch(() => {});
  }
  // Desktop fallback: the share-row buttons below already cover Copy/WhatsApp/Email/More
}

function showContactsForInvite() {
  renderContacts(true); // pass flag to show "send link" mode
  showScreen('contacts');
}

function backFromContacts() {
  if (currentInviteLink) {
    showScreen('waiting');
  } else {
    showScreen('home');
  }
}

// ─── Video / Voice Chat ───────────────────────────────────────────────────────

const VIDEO_CALL_CONNECT_TIMEOUT_MS = 30_000;
const VIDEO_CALL_RECONNECT_GRACE_MS = 6_000;
const VIDEO_CALL_RECOVERY_TIMEOUT_MS = 8_000;
const VIDEO_CALL_MAX_ICE_RESTARTS = 2;
const VIDEO_CALL_TELEMETRY_INTERVAL_MS = 15_000;

function loadVideoCallDevicePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIDEO_CALL_DEVICE_PREFS_KEY) || '{}');
    selectedCallAudioDeviceId = typeof saved.audioDeviceId === 'string' ? saved.audioDeviceId : '';
    selectedCallVideoDeviceId = typeof saved.videoDeviceId === 'string' ? saved.videoDeviceId : '';
    callFacingMode = saved.facingMode === 'environment' ? 'environment' : 'user';
  } catch {
    selectedCallAudioDeviceId = '';
    selectedCallVideoDeviceId = '';
    callFacingMode = 'user';
  }
}

function saveVideoCallDevicePreferences() {
  try {
    localStorage.setItem(VIDEO_CALL_DEVICE_PREFS_KEY, JSON.stringify({
      audioDeviceId: selectedCallAudioDeviceId,
      videoDeviceId: selectedCallVideoDeviceId,
      facingMode: callFacingMode,
    }));
  } catch {}
}

function getVideoCallRuntime() {
  return window.chessVideoCall || null;
}

function setVideoCallState(state, message = '') {
  videoCallState = state;
  const panel = document.getElementById('video-chat-panel');
  if (panel) panel.dataset.callState = state;
  const status = document.getElementById('video-status');
  if (status) {
    const defaults = {
      acquiring: 'Starting camera and microphone…',
      calling: 'Calling…',
      ringing: 'Incoming call…',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      failed: 'Call connection failed',
    };
    status.textContent = message || defaults[state] || '';
    status.style.display = state === 'connected' || state === 'idle' ? 'none' : 'flex';
  }
  const quality = document.getElementById('video-quality-indicator');
  if (quality && state !== 'connected') {
    quality.textContent = state === 'reconnecting' ? 'Reconnecting' : 'Connecting';
    quality.className = 'video-quality-indicator connecting';
  }
}

function showVideoCallPanel() {
  const panel = document.getElementById('video-chat-panel');
  if (panel) panel.style.display = 'flex';
  const btn = document.getElementById('btn-video-chat');
  if (btn) btn.textContent = '📵 End Call';
}

function clearVideoCallTimers() {
  if (videoCallTimeout) clearTimeout(videoCallTimeout);
  if (videoReconnectTimer) clearTimeout(videoReconnectTimer);
  if (pendingCallTimeout) clearTimeout(pendingCallTimeout);
  videoCallTimeout = null;
  videoReconnectTimer = null;
  pendingCallTimeout = null;
}

async function playCallVideo(video, offerRecovery = false) {
  if (!video) return false;
  try {
    await video.play();
    if (offerRecovery) {
      const recovery = document.getElementById('btn-resume-remote-video');
      if (recovery) recovery.hidden = true;
    }
    return true;
  } catch (error) {
    if (offerRecovery) {
      const recovery = document.getElementById('btn-resume-remote-video');
      if (recovery) recovery.hidden = false;
      const detail = document.getElementById('video-network-detail');
      if (detail) detail.textContent = 'Tap to start audio';
    }
    console.warn('[video-call] media playback was blocked:', error?.message || error);
    return false;
  }
}

async function resumeRemoteVideo() {
  const remoteVideo = document.getElementById('remote-video');
  const played = await playCallVideo(remoteVideo, true);
  if (played && remoteMediaStream) setVideoCallState('connected');
}

function updateVideoCallQuality(sample) {
  const quality = sample?.quality || 'connecting';
  const indicator = document.getElementById('video-quality-indicator');
  if (indicator) {
    const labels = { good: 'Good', fair: 'Fair', poor: 'Poor', connecting: 'Connecting' };
    indicator.textContent = labels[quality] || 'Connecting';
    indicator.className = `video-quality-indicator ${quality}`;
  }

  const inboundVideo = sample?.inbound?.video || {};
  const outboundVideo = sample?.outbound?.video || {};
  const width = inboundVideo.width || outboundVideo.width;
  const height = inboundVideo.height || outboundVideo.height;
  const fps = inboundVideo.framesPerSecond || outboundVideo.framesPerSecond;
  const rtt = sample?.network?.rttMs;
  const details = [];
  if (width && height) details.push(`${width}×${height}`);
  if (fps) details.push(`${Math.round(fps)} fps`);
  if (Number.isFinite(rtt)) details.push(`${Math.round(rtt)} ms`);
  if (sample?.network?.relayed) details.push('Relay');
  const detail = document.getElementById('video-network-detail');
  if (detail) detail.textContent = details.join(' · ') || 'Measuring connection…';
}

function stopVideoCallMonitor() {
  videoCallMonitor?.stop?.();
  videoCallMonitor = null;
}

function startVideoCallMonitor(call) {
  stopVideoCallMonitor();
  const runtime = getVideoCallRuntime();
  if (!runtime?.monitorCall) return;
  videoCallMonitor = runtime.monitorCall(call, {
    initialProfile: 'high',
    onProfileChange(profile) {
      if (call !== mediaCall) return;
      const detail = document.getElementById('video-profile-detail');
      if (detail) detail.textContent = `${profile[0].toUpperCase()}${profile.slice(1)} quality`;
    },
    onSample(sample) {
      if (call !== mediaCall) return;
      updateVideoCallQuality(sample);
      const now = Date.now();
      if (now - videoCallLastTelemetryAt < VIDEO_CALL_TELEMETRY_INTERVAL_MS) return;
      videoCallLastTelemetryAt = now;
      if (typeof window.agsSendEvent === 'function') {
        window.agsSendEvent('video_call_quality', runtime.qualityTelemetryPayload(sample, sample.profile));
      }
    },
  });
}

function describeVideoCallError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Camera or microphone permission was denied. Allow access in your browser or device settings and try again.';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'No working camera or microphone was found.';
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return 'The camera or microphone is already in use by another app.';
  }
  return error?.message || 'Could not start the camera and microphone.';
}

async function acquireLocalCallMedia(generation) {
  const runtime = getVideoCallRuntime();
  await runtime?.startNativeAudio?.();
  const preferences = {
    profile: 'high',
    audioDeviceId: selectedCallAudioDeviceId,
    videoDeviceId: selectedCallVideoDeviceId,
    facingMode: callFacingMode,
  };
  let stream;
  try {
    stream = runtime?.acquireMedia
      ? await runtime.acquireMedia(preferences)
      : await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (error) {
    const staleDevicePreference = (selectedCallAudioDeviceId || selectedCallVideoDeviceId) &&
      ['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError'].includes(error?.name);
    if (!staleDevicePreference || !runtime?.acquireMedia) throw error;
    selectedCallAudioDeviceId = '';
    selectedCallVideoDeviceId = '';
    saveVideoCallDevicePreferences();
    stream = await runtime.acquireMedia({ profile: 'high', facingMode: callFacingMode });
  }

  if (generation !== videoCallGeneration) {
    stream.getTracks().forEach(track => track.stop());
    return null;
  }
  audioEnabled = true;
  camEnabled = true;
  localStream = stream;
  const localVideo = document.getElementById('local-video');
  if (localVideo) {
    localVideo.srcObject = stream;
    await playCallVideo(localVideo);
  }
  await runtime?.startNativeAudio?.();
  await refreshVideoCallDevices();
  return stream;
}

function attachRemoteCallStream(call, stream) {
  if (call !== mediaCall) return;
  remoteMediaStream = stream;
  const remoteVideo = document.getElementById('remote-video');
  if (remoteVideo) {
    remoteVideo.srcObject = stream;
    playCallVideo(remoteVideo, true).catch(() => {});
  }
  for (const track of stream.getTracks()) {
    track.addEventListener?.('ended', () => {
      if (call === mediaCall && stream.getTracks().every(candidate => candidate.readyState === 'ended')) {
        endVideoChat('remote-media-ended', true);
      }
    });
    track.addEventListener?.('mute', () => {
      if (call !== mediaCall) return;
      const detail = document.getElementById('video-network-detail');
      if (detail && videoCallState === 'connected') detail.textContent = 'Remote media paused…';
    });
  }
  if (videoCallTimeout) clearTimeout(videoCallTimeout);
  videoCallTimeout = null;
  const firstConnection = !videoCallStartedAt;
  if (firstConnection) videoCallStartedAt = Date.now();
  setVideoCallState('connected');
  if (firstConnection && typeof window.agsSendEvent === 'function') {
    window.agsSendEvent('video_call_connected', {
      setup_time_ms: Math.max(0, Date.now() - videoCallAttemptStartedAt),
      direction: videoCallDirection,
    });
  }
}

function armVideoCallConnectTimeout(call) {
  if (videoCallTimeout) clearTimeout(videoCallTimeout);
  videoCallTimeout = setTimeout(() => {
    if (call === mediaCall && !remoteMediaStream) endVideoChat('connect-timeout', true);
  }, VIDEO_CALL_CONNECT_TIMEOUT_MS);
}

function scheduleVideoIceRecovery(call, delay = VIDEO_CALL_RECONNECT_GRACE_MS) {
  if (call !== mediaCall || videoReconnectTimer) return;
  setVideoCallState('reconnecting');
  videoReconnectTimer = setTimeout(() => {
    videoReconnectTimer = null;
    attemptVideoIceRecovery(call);
  }, delay);
}

function attemptVideoIceRecovery(call) {
  if (call !== mediaCall) return;
  const pc = call.peerConnection;
  const connected = pc?.connectionState === 'connected' || ['connected', 'completed'].includes(pc?.iceConnectionState);
  if (connected) {
    videoReconnectAttempts = 0;
    if (remoteMediaStream) setVideoCallState('connected');
    return;
  }
  if (!pc?.restartIce || videoReconnectAttempts >= VIDEO_CALL_MAX_ICE_RESTARTS) {
    endVideoChat('connection-failed', true);
    return;
  }
  videoReconnectAttempts += 1;
  setVideoCallState('reconnecting', `Reconnecting… (${videoReconnectAttempts}/${VIDEO_CALL_MAX_ICE_RESTARTS})`);
  try {
    pc.restartIce();
  } catch (error) {
    console.warn('[video-call] ICE restart failed:', error?.message || error);
  }
  videoReconnectTimer = setTimeout(() => {
    videoReconnectTimer = null;
    attemptVideoIceRecovery(call);
  }, VIDEO_CALL_RECOVERY_TIMEOUT_MS);
}

function handleVideoPeerConnectionState(call) {
  if (call !== mediaCall) return;
  const pc = call.peerConnection;
  const state = pc?.connectionState || pc?.iceConnectionState || '';
  const iceState = pc?.iceConnectionState || '';
  if (state === 'connected' || ['connected', 'completed'].includes(iceState)) {
    if (videoReconnectTimer) clearTimeout(videoReconnectTimer);
    videoReconnectTimer = null;
    videoReconnectAttempts = 0;
    if (remoteMediaStream) setVideoCallState('connected');
  } else if (state === 'disconnected' || iceState === 'disconnected') {
    scheduleVideoIceRecovery(call);
  } else if (state === 'failed' || iceState === 'failed') {
    if (videoReconnectTimer) clearTimeout(videoReconnectTimer);
    videoReconnectTimer = null;
    scheduleVideoIceRecovery(call, 0);
  } else if (state === 'closed' && !videoCallEnding) {
    endVideoChat('remote-ended', true);
  }
}

function bindMediaCall(call, direction) {
  videoCallDirection = direction;
  videoReconnectAttempts = 0;
  remoteMediaStream = null;
  call.on('stream', stream => attachRemoteCallStream(call, stream));
  call.on('close', () => {
    if (call === mediaCall && !videoCallEnding) endVideoChat('remote-ended', true);
  });
  call.on('error', error => {
    if (call !== mediaCall || videoCallEnding) return;
    console.error('[video-call] media connection error:', error);
    if (typeof window.agsSendEvent === 'function') {
      window.agsSendEvent('video_call_error', {
        error_type: String(error?.type || error?.name || 'media-error').slice(0, 40),
      });
    }
    endVideoChat('media-error', true);
  });
  const pc = call.peerConnection;
  pc?.addEventListener?.('connectionstatechange', () => handleVideoPeerConnectionState(call));
  pc?.addEventListener?.('iceconnectionstatechange', () => handleVideoPeerConnectionState(call));
  armVideoCallConnectTimeout(call);
  startVideoCallMonitor(call);
}

async function startVideoChat() {
  if (mediaCall || videoCallState !== 'idle') { endVideoChat(); return; }
  // Friends-only: the button is hidden for non-friends, but guard the entry
  // point too (console/data-click invocation must not reach a stranger).
  if (!videoChatAllowed) {
    alert('Video chat is only available between friends. Add your opponent as a friend after the game!');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !peer || !remotePeerId) {
    alert(!navigator.mediaDevices?.getUserMedia
      ? 'Video chat requires camera and microphone access over a secure connection.'
      : 'The game connection is not ready for a video call yet.');
    return;
  }
  const generation = ++videoCallGeneration;
  videoCallAttemptStartedAt = Date.now();
  videoCallStartedAt = 0;
  videoCallDirection = 'outgoing';
  videoCallLastTelemetryAt = 0;
  showVideoCallPanel();
  setVideoCallState('acquiring');
  try {
    const stream = await acquireLocalCallMedia(generation);
    if (!stream || generation !== videoCallGeneration) return;
    setVideoCallState('calling');
    const infrastructure = getVideoCallRuntime()?.getInfrastructureStatus?.() || {};
    if (typeof window.agsSendEvent === 'function') {
      window.agsSendEvent('video_call_started', {
        direction: 'outgoing',
        managed_turn: !!infrastructure.managedTurnLoaded,
      });
    }
    const call = peer.call(remotePeerId, stream);
    if (!call) throw new Error('The peer connection could not create a media call.');
    mediaCall = call;
    bindMediaCall(call, 'outgoing');
  } catch (error) {
    if (generation !== videoCallGeneration) return;
    const message = describeVideoCallError(error);
    endVideoChat('media-access-error');
    alert(message);
  }
}

async function acceptVideoCall() {
  const call = pendingCall;
  if (!call || mediaCall) return;
  document.getElementById('video-call-notification').style.display = 'none';
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Video chat requires camera and microphone access over a secure connection.');
    declineVideoCall();
    return;
  }
  if (pendingCallTimeout) clearTimeout(pendingCallTimeout);
  pendingCallTimeout = null;
  const generation = ++videoCallGeneration;
  videoCallAttemptStartedAt = Date.now();
  videoCallStartedAt = 0;
  videoCallDirection = 'incoming';
  videoCallLastTelemetryAt = 0;
  showVideoCallPanel();
  setVideoCallState('acquiring');
  try {
    const stream = await acquireLocalCallMedia(generation);
    if (!stream || generation !== videoCallGeneration) return;
    if (pendingCall !== call) {
      endVideoChat('remote-ended', true);
      return;
    }
    pendingCall = null;
    mediaCall = call;
    call.answer(stream);
    setVideoCallState('connecting');
    if (typeof window.agsSendEvent === 'function') {
      window.agsSendEvent('video_call_accepted', { direction: 'incoming' });
    }
    bindMediaCall(call, 'incoming');
  } catch (error) {
    if (generation !== videoCallGeneration) return;
    const message = describeVideoCallError(error);
    endVideoChat('media-access-error');
    alert(message);
  }
}

function declineVideoCall() {
  document.getElementById('video-call-notification').style.display = 'none';
  if (pendingCallTimeout) clearTimeout(pendingCallTimeout);
  pendingCallTimeout = null;
  const call = pendingCall;
  pendingCall = null;
  if (call) { try { call.close(); } catch {} }
  if (!mediaCall) setVideoCallState('idle');
}

function endVideoChat(reason = 'local-ended', notify = false) {
  if (videoCallEnding) return;
  videoCallEnding = true;
  videoCallGeneration += 1;
  const activeCall = mediaCall;
  const activePendingCall = pendingCall;
  mediaCall = null;
  pendingCall = null;
  clearVideoCallTimers();
  stopVideoCallMonitor();
  if (activeCall) { try { activeCall.close(); } catch {} }
  if (activePendingCall) { try { activePendingCall.close(); } catch {} }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (remoteMediaStream) { remoteMediaStream.getTracks().forEach(t => t.stop()); remoteMediaStream = null; }
  getVideoCallRuntime()?.stopNativeAudio?.();
  if (videoCallAttemptStartedAt && typeof window.agsSendEvent === 'function') {
    window.agsSendEvent('video_call_ended', {
      reason: String(reason || 'ended').slice(0, 40),
      direction: videoCallDirection,
      connected: !!videoCallStartedAt,
      duration_ms: videoCallStartedAt ? Math.max(0, Date.now() - videoCallStartedAt) : 0,
    });
  }
  audioEnabled = true;
  camEnabled   = true;
  videoReconnectAttempts = 0;
  videoCallAttemptStartedAt = 0;
  videoCallStartedAt = 0;
  videoCallLastTelemetryAt = 0;
  videoCallDirection = '';
  setVideoCallState('idle');
  const panel = document.getElementById('video-chat-panel');
  if (panel) {
    panel.style.display = 'none';
    panel.classList.remove('expanded');
  }
  const notif = document.getElementById('video-call-notification');
  if (notif) notif.style.display = 'none';
  const rv = document.getElementById('remote-video');
  if (rv) rv.srcObject = null;
  const lv = document.getElementById('local-video');
  if (lv) lv.srcObject = null;
  const btn = document.getElementById('btn-toggle-audio');
  if (btn) { btn.textContent = '🎤'; btn.classList.remove('muted'); }
  const btnCam = document.getElementById('btn-toggle-cam');
  if (btnCam) { btnCam.textContent = '📹'; btnCam.classList.remove('muted'); }
  const btnVC = document.getElementById('btn-video-chat');
  if (btnVC) btnVC.textContent = '📹 Video Chat';
  const recovery = document.getElementById('btn-resume-remote-video');
  if (recovery) recovery.hidden = true;
  const settings = document.getElementById('video-device-settings');
  if (settings) settings.hidden = true;
  const expand = document.getElementById('btn-expand-video');
  if (expand) expand.setAttribute('aria-pressed', 'false');
  const quality = document.getElementById('video-quality-indicator');
  if (quality) {
    quality.textContent = 'Connecting';
    quality.className = 'video-quality-indicator connecting';
  }
  const networkDetail = document.getElementById('video-network-detail');
  if (networkDetail) networkDetail.textContent = '';
  const profileDetail = document.getElementById('video-profile-detail');
  if (profileDetail) profileDetail.textContent = 'High quality';
  if (notify && typeof showConnBanner === 'function') {
    const messages = {
      'connect-timeout': 'Video call timed out before connecting.',
      'connection-failed': 'Video call ended because the connection could not recover.',
      'media-error': 'Video call ended because of a media connection error.',
      'remote-ended': 'The other player ended the video call.',
      'remote-media-ended': 'The other player stopped sharing call media.',
    };
    showConnBanner(messages[reason] || 'Video call ended.', reason === 'remote-ended' ? 'warning' : 'error');
  }
  videoCallEnding = false;
}

function toggleAudio() {
  if (!localStream) return;
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = audioEnabled; });
  const btn = document.getElementById('btn-toggle-audio');
  btn.textContent = audioEnabled ? '🎤' : '🔇';
  btn.classList.toggle('muted', !audioEnabled);
}

function toggleVideoFeed() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  const btn = document.getElementById('btn-toggle-cam');
  btn.textContent = camEnabled ? '📹' : '🚫';
  btn.classList.toggle('muted', !camEnabled);
}

function fillCallDeviceSelect(select, devices, selectedId, fallbackLabel) {
  if (!select) return;
  const current = selectedId || select.value;
  select.innerHTML = '';
  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `${fallbackLabel} ${index + 1}`;
    select.appendChild(option);
  });
  if (!devices.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = `Default ${fallbackLabel.toLowerCase()}`;
    select.appendChild(option);
  }
  if (current && devices.some(device => device.deviceId === current)) select.value = current;
}

async function refreshVideoCallDevices() {
  const runtime = getVideoCallRuntime();
  if (!runtime?.enumerateInputDevices) return;
  try {
    const { audioInputs, videoInputs } = await runtime.enumerateInputDevices();
    fillCallDeviceSelect(
      document.getElementById('video-audio-input'),
      audioInputs,
      selectedCallAudioDeviceId || localStream?.getAudioTracks()[0]?.getSettings?.().deviceId,
      'Microphone'
    );
    fillCallDeviceSelect(
      document.getElementById('video-camera-input'),
      videoInputs,
      selectedCallVideoDeviceId || localStream?.getVideoTracks()[0]?.getSettings?.().deviceId,
      'Camera'
    );
  } catch (error) {
    console.warn('[video-call] could not enumerate devices:', error?.message || error);
  }
}

async function replaceVideoCallDevice(kind, deviceId) {
  const runtime = getVideoCallRuntime();
  if (!runtime?.replaceInputTrack || !mediaCall || !localStream) return;
  const select = document.getElementById(kind === 'audio' ? 'video-audio-input' : 'video-camera-input');
  if (select) select.disabled = true;
  try {
    const result = await runtime.replaceInputTrack({
      call: mediaCall,
      stream: localStream,
      kind,
      deviceId,
      facingMode: callFacingMode,
    });
    if (kind === 'audio') selectedCallAudioDeviceId = deviceId || result.settings?.deviceId || '';
    else selectedCallVideoDeviceId = deviceId || result.settings?.deviceId || '';
    saveVideoCallDevicePreferences();
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      localVideo.srcObject = null;
      localVideo.srcObject = localStream;
      playCallVideo(localVideo).catch(() => {});
    }
    await refreshVideoCallDevices();
  } catch (error) {
    console.warn('[video-call] could not switch device:', error);
    showConnBanner?.(describeVideoCallError(error), 'error');
  } finally {
    if (select) select.disabled = false;
  }
}

async function switchVideoCallCamera() {
  callFacingMode = callFacingMode === 'user' ? 'environment' : 'user';
  let nextDeviceId = '';
  try {
    const devices = await getVideoCallRuntime()?.enumerateInputDevices?.();
    const cameras = devices?.videoInputs || [];
    const currentDeviceId = localStream?.getVideoTracks()[0]?.getSettings?.().deviceId || selectedCallVideoDeviceId;
    if (cameras.length > 1) {
      const currentIndex = cameras.findIndex(device => device.deviceId === currentDeviceId);
      nextDeviceId = cameras[(currentIndex + 1 + cameras.length) % cameras.length]?.deviceId || '';
    }
  } catch {}
  selectedCallVideoDeviceId = nextDeviceId;
  saveVideoCallDevicePreferences();
  await replaceVideoCallDevice('video', nextDeviceId);
}

function toggleVideoCallSettings() {
  const settings = document.getElementById('video-device-settings');
  if (!settings) return;
  settings.hidden = !settings.hidden;
  if (!settings.hidden) refreshVideoCallDevices();
}

function toggleVideoPanelSize() {
  const panel = document.getElementById('video-chat-panel');
  const button = document.getElementById('btn-expand-video');
  if (!panel) return;
  const expanded = panel.classList.toggle('expanded');
  button?.setAttribute('aria-pressed', String(expanded));
  if (button) button.title = expanded ? 'Restore call window' : 'Enlarge call window';
}

function bindVideoCallControls() {
  loadVideoCallDevicePreferences();
  const bindings = [
    ['btn-resume-remote-video', 'click', resumeRemoteVideo],
    ['btn-video-settings', 'click', toggleVideoCallSettings],
    ['btn-switch-camera', 'click', switchVideoCallCamera],
    ['btn-expand-video', 'click', toggleVideoPanelSize],
  ];
  for (const [id, eventName, handler] of bindings) {
    const element = document.getElementById(id);
    if (element && !element.dataset.videoCallBound) {
      element.dataset.videoCallBound = 'true';
      element.addEventListener(eventName, handler);
    }
  }
  const audioSelect = document.getElementById('video-audio-input');
  if (audioSelect && !audioSelect.dataset.videoCallBound) {
    audioSelect.dataset.videoCallBound = 'true';
    audioSelect.addEventListener('change', () => replaceVideoCallDevice('audio', audioSelect.value));
  }
  const cameraSelect = document.getElementById('video-camera-input');
  if (cameraSelect && !cameraSelect.dataset.videoCallBound) {
    cameraSelect.dataset.videoCallBound = 'true';
    cameraSelect.addEventListener('change', () => replaceVideoCallDevice('video', cameraSelect.value));
  }
  const remoteVideo = document.getElementById('remote-video');
  if (remoteVideo && !remoteVideo.dataset.videoCallBound) {
    remoteVideo.dataset.videoCallBound = 'true';
    remoteVideo.addEventListener('playing', () => {
      if (remoteMediaStream) {
        document.getElementById('btn-resume-remote-video')?.setAttribute('hidden', '');
        setVideoCallState('connected');
      }
    });
    const showBuffering = () => {
      if (videoCallState !== 'connected') return;
      const detail = document.getElementById('video-network-detail');
      if (detail) detail.textContent = 'Buffering…';
    };
    remoteVideo.addEventListener('waiting', showBuffering);
    remoteVideo.addEventListener('stalled', showBuffering);
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (localStream) refreshVideoCallDevices();
  });
  getVideoCallRuntime()?.addNativeAudioListener?.(event => {
    if (!mediaCall) return;
    const detail = document.getElementById('video-network-detail');
    if (event?.status === 'interrupted' && detail) detail.textContent = 'Audio interrupted…';
    if (event?.status === 'resumed') getVideoCallRuntime()?.startNativeAudio?.();
    if (event?.status === 'route-changed') refreshVideoCallDevices();
  });
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

function showContacts() {
  renderContacts(false);
  showScreen('contacts');
}

function renderContacts(inviteMode = false) {
  const list = document.getElementById('contacts-list');
  const h2 = document.querySelector('#screen-contacts h2');
  h2.textContent = inviteMode ? 'Send Invite To…' : 'Contacts';

  list.innerHTML = '';
  if (contacts.length === 0) {
    list.innerHTML = `<div class="empty-state compact">
      <strong>No contacts saved yet</strong>
      <span>Add an email or phone number, then send invitations without retyping it.</span>
    </div>`;
    return;
  }
  for (const contact of contacts) {
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.setAttribute('role', 'listitem');
    const initials = contact.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-invite';
    btn.textContent = inviteMode ? 'Send' : 'Invite';
    btn.setAttribute('aria-label', `${btn.textContent} ${contact.name}`);
    btn.addEventListener('click', () => {
      if (inviteMode && currentInviteLink) {
        sendInviteToContact(contact.name, contact.address, currentInviteLink);
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-remove';
    removeBtn.textContent = '✕';
    removeBtn.setAttribute('aria-label', `Remove ${contact.name}`);
    removeBtn.addEventListener('click', () => removeContact(contact.address));

    item.innerHTML = `
      <div class="contact-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(contact.name)}</div>
        <div class="contact-addr">${escapeHtml(contact.address)}</div>
      </div>
    `;
    item.appendChild(btn);
    item.appendChild(removeBtn);
    list.appendChild(item);
  }
}

function showAddContact() {
  document.getElementById('add-contact-form').style.display = 'flex';
  document.getElementById('contact-input').focus();
}

function hideAddContact() {
  document.getElementById('add-contact-form').style.display = 'none';
  document.getElementById('contact-input').value = '';
}

function addContact() {
  const val = document.getElementById('contact-input').value.trim();
  if (!val) return;
  const name = val.includes('@') ? val.split('@')[0] : val;
  contacts.push({ name, address: val });
  localStorage.setItem('chess_contacts', JSON.stringify(contacts));
  hideAddContact();
  renderContacts(!!currentInviteLink);
}

function removeContact(address) {
  contacts = contacts.filter(c => c.address !== address);
  localStorage.setItem('chess_contacts', JSON.stringify(contacts));
  renderContacts(!!currentInviteLink);
}

async function sendInviteToContact(name, address, link) {
  if (address.includes('@')) {
    const fromName = document.getElementById('ags-signedin-name')?.textContent || playerName || 'A friend';
    try {
      if (typeof window.agsSendInviteEmail !== 'function') {
        throw new Error('Invite email service is not ready.');
      }
      const result = await window.agsSendInviteEmail({ to: address, fromName, inviteLink: link });
      if (!result?.ok) throw new Error(result?.error || 'Could not send the invite email.');
      showConnBanner(`Invite sent to ${name}!`, 'success');
    } catch (err) {
      console.warn('[invite] email send failed:', err);
      showConnBanner(err?.message || 'Could not send email — share the link below manually.', 'error');
    }
  } else {
    const msg = `Hey ${name}! Let's play chess. Open this link to join my game: ${link}`;
    window.open(`sms:${address}?&body=${encodeURIComponent(msg)}`);
  }
  showScreen('waiting');
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function confirmGoHome() {
  if (gameMode === 'online' && game && isGameActiveStatus(game.status) && game.moveHistory.length > 0) {
    if (!confirm('Leave this online game? It will count as a loss.')) return;
    void forfeitOnlineMatchAndGoHome();
    return;
  }
  if (isGameActiveStatus(game?.status) && game.moveHistory.length > 0) {
    if (!confirm('Leave this game? The current game will be lost.')) return;
  }
  destroyPeer();
  showScreen('home');
}

function confirmNewGame() {
  if (game && !isGameOverStatus(game.status) && game.moveHistory.length > 0) {
    if (!confirm('Start a new game? The current game will be lost.')) return;
  }
  startGame();
}

function resignGame() {
  if (!game || isGameOverStatus(game.status)) return;
  if (gameMode !== 'computer') return;
  if (!confirm('Resign this game? It will count as a loss.')) return;
  gameEndedByResignation = true;
  game.status = 'checkmate';
  game.winner = playerColor === 'white' ? 'black' : 'white';
  aiThinking = false;
  selectedSquare = null;
  validMoves = [];
  renderBoard();
  showGameOver();
}

function savePlayerName() {
  const val = document.getElementById('player-name-input')?.value.trim();
  if (val) { playerName = val; localStorage.setItem('chess_player_name', playerName); }
}

function saveLeaderboard() {
  if (leaderboard.length > 0) {
    localStorage.setItem('chess_leaderboard', JSON.stringify(leaderboard));
  } else {
    localStorage.removeItem('chess_leaderboard');
  }
}

function recordWin() {
  savePlayerName();
  if (!playerName) return;
  const entry = leaderboard.find(e => e.name.toLowerCase() === playerName.toLowerCase());
  if (entry) { entry.wins++; } else { leaderboard.push({ name: playerName, wins: 1 }); }
  leaderboard.sort((a, b) => b.wins - a.wins);
  if (leaderboard.length > 100) leaderboard.length = 100;
  saveLeaderboard();
}

function resetLeaderboard() {
  if (!confirm('Reset the leaderboard? This cannot be undone.')) return;
  leaderboard = [];
  saveLeaderboard();
  renderLeaderboard();
}

function renderLeaderboard() {
  const nameInput = document.getElementById('player-name-input');
  if (nameInput && !nameInput.value) nameInput.value = playerName;

  const listEl = document.getElementById('lb-list');
  if (!listEl) return;

  const hasLocalData = leaderboard.length > 0;
  const resetBtn = document.querySelector('.btn-lb-reset');
  if (resetBtn) resetBtn.style.display = hasLocalData ? 'block' : 'none';

  if (leaderboard.length === 0) {
    listEl.innerHTML = '<p class="lb-empty">No wins yet — be the first!</p>';
    return;
  }

  listEl.innerHTML = leaderboard.map((e, i) => {
    const isYou = playerName && e.name.toLowerCase() === playerName.toLowerCase();
    return `<div class="lb-entry${isYou ? ' lb-you' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name">${escapeHtml(e.name)}${isYou ? ' (you)' : ''}</span>
      <span class="lb-wins">${e.wins}</span>
    </div>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal('promotion-modal');
    selectedSquare = null;
    validMoves = [];
    if (game) renderBoard();
  }
  if (e.key === 'Enter' && document.getElementById('add-contact-form').style.display !== 'none')
    addContact();
});

// ─── Visibility handling ──────────────────────────────────────────────────────
// Reset the pong timer when tab comes back to foreground so the heartbeat
// doesn't immediately declare a connection lost just because the tab was idle.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && gameMode === 'online' && peerConn) {
    lastPongTime = Date.now();
    if (!peerConn.open && isGameActiveStatus(game?.status)) {
      handleConnectionLost();
    }
  }
});

// ─── Auto-join from URL ───────────────────────────────────────────────────────

window.getSpectatorMatchData = function() {
  if (!game || gameMode !== 'online') return null
  const myName = document.getElementById('ags-signedin-name')?.textContent || playerName || 'Player'
  const myUserId = window.agsCurrentUserId || ''
  return {
    matchId: currentMatchId,
    active: isGameActiveStatus(game.status),
    moves: game.moveHistory.map(m => ({ fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType: m.promType })),
    whiteName: playerColor === 'white' ? myName : (currentOpponent?.name || 'Opponent'),
    blackName: playerColor === 'black' ? myName : (currentOpponent?.name || 'Opponent'),
    whiteUserId: playerColor === 'white' ? myUserId : (currentOpponent?.userId || ''),
    blackUserId: playerColor === 'black' ? myUserId : (currentOpponent?.userId || ''),
    startedAt: matchStartedAt?.toISOString() || new Date().toISOString(),
    status: game.status,
    winner: game.winner || null,
  }
}

window.addEventListener('beforeunload', () => {
  saveLeaderboard();
  localStorage.setItem('chess_player_name', playerName);
});

function initializeGameplayDOM() {
  window.cancelShellHomeIdlePrompt?.();
  hydrateStaticPieceIcons();
  renderLeaderboard();
  bindVideoCallControls();
  // ?peer= (a live-match invite link) is no longer auto-joined here — it goes
  // through src/main.js's initAuth() first, which gates it behind the
  // sign-in screen (#screen-invite) before calling window.agsJoinPeer.
}

Object.assign(window, {
  acceptFriendMatchInvite,
  acceptRematch,
  acceptVideoCall,
  addContact,
  backFromContacts,
  blockCurrentOpponent,
  cancelWaiting,
  closeModal,
  closeSafetyReport,
  coachPlayOn,
  coachTakeBack,
  confirmGoHome,
  confirmNewGame,
  copyInviteLink,
  createOnlineRoom,
  declineFriendMatchInvite,
  declineRematch,
  declineVideoCall,
  endVideoChat,
  executeMove,
  flipBoard,
  handleChatInputKeydown,
  hideAddContact,
  openJournalFromGameOver,
  playAgainFromGameOver,
  reportCurrentOpponent,
  requestRematch,
  resetLeaderboard,
  resignGame,
  reviewGameFromGameOver,
  selectColor,
  selectPieceColor,
  sendChatMessage,
  sendHighFive,
  shareInviteLink,
  showAddContact,
  showColorSelect,
  showContactsForInvite,
  showGameOver,
  showHint,
  showMatchTab,
  showWaitingScreen,
  startGame,
  startFriendMatchInvite,
  startGusMatchmaking,
  startNewGame,
  startRandomMatchmaking,
  startRetryFromPosition,
  startVideoChat,
  startVsComputer,
  stopGameOverCountdown,
  submitSafetyReport,
  setupPeerConnection,
  toggleAudio,
  toggleCoachMode,
  toggleVideoFeed,
  renderBoard,
  setCurrentMatchIdForTesting,
  setCurrentOpponent,
  setGameModeForTesting,
  setPeerConnForTesting,
  forceGameOverStateForTesting,
  prepareAIRuntime,
});

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initializeGameplayDOM, { once: true });
} else {
  initializeGameplayDOM();
}

'use strict';

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
  element.dataset.pieceType = type;
  element.dataset.pieceColor = color;
  element.setAttribute('aria-label', label || `${color} ${PIECE_LABELS[type] || type}`);
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
let ai = new ChessAI();
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
let currentOpponent = null;
let currentOpponentBlocked = false;
let activeSafetyReport = null;
let pendingFriendMatchInvite = null;
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

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
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
    createOnlineRoom();
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
}

function startGame() {
  if (typeof window.agsSetPresence === 'function') {
    window.agsSetPresence('in-match');
  }
  if (typeof window.agsSendEvent === 'function') {
    window.agsSendEvent('game_started', { mode: gameMode, color: playerColor });
  }
  matchStartedAt = new Date();
  matchHistoryRecorded = false;
  gameEndedByResignation = false;
  boardFlipped = playerColor === 'black';
  resetMatchClocks();
  game = new ChessGame();
  selectedSquare = null;
  validMoves = [];
  dragging = null;
  pendingPromotion = null;
  suggestedMoveBeforePlay = null;
  aiThinking = false;

  document.getElementById('hint-box').style.display = 'none';
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

  // Hide hint button during online games; show video chat button instead
  document.getElementById('btn-hint').style.display = isOnline ? 'none' : '';
  document.getElementById('btn-video-chat').style.display = isOnline ? '' : 'none';
  // New Game + Resign apply to vs-computer play
  const showVsComputerControls = gameMode === 'computer';
  const ngBtn = document.getElementById('btn-new-game');
  const rsBtn = document.getElementById('btn-resign');
  if (ngBtn) ngBtn.style.display = showVsComputerControls ? '' : 'none';
  if (rsBtn) rsBtn.style.display = showVsComputerControls ? '' : 'none';
  document.getElementById('online-chat').style.display = isOnline ? 'flex' : 'none';
  document.getElementById('match-chat-unavailable').style.display = isOnline ? 'none' : '';
  document.getElementById('match-chat-tab').style.display = isOnline ? '' : 'none';
  document.getElementById('btn-match-safety').style.display = isOnline ? '' : 'none';
  showMatchTab('moves');
  arrangePlayerStrips();
  updateChatAvailability();
  if (isOnline) activateChatForCurrentMatch();

  showScreen('game');
  renderBoard();
  updateStatus();
  startMatchClocks();

  if (gameMode === 'computer' && playerColor === 'black') {
    scheduleAIMove();
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
  boardEl.innerHTML = '';
  const flipped = boardFlipped;
  boardEl.dataset.flipped = flipped;

  for (let ri = 0; ri < 8; ri++) {
    for (let ci = 0; ci < 8; ci++) {
      const r = flipped ? 7 - ri : ri;
      const c = flipped ? 7 - ci : ci;

      const sq = document.createElement('div');
      sq.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      sq.dataset.r = r;
      sq.dataset.c = c;
      addCoordinateLabels(sq, r, c, ri, ci);
      sq.addEventListener('click', () => onSquareClick(r, c));
      sq.addEventListener('dragover', e => e.preventDefault());
      sq.addEventListener('drop', e => onDrop(e, r, c));
      boardEl.appendChild(sq);
    }
  }
}

function renderBoard() {
  const boardEl = document.getElementById('chess-board');
  const flipped = playerColor === 'black';

  // Rebuild DOM only when orientation changes or board is not yet initialized
  if (boardEl.children.length !== 64 || boardEl.dataset.flipped !== String(flipped)) {
    initBoard();
  }

  const last = game.moveHistory.length > 0 ? game.moveHistory[game.moveHistory.length - 1] : null;
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
    const isValid     = validMoves.some(m => m.toR === r && m.toC === c);
    const isLastFrom  = !!last && last.fr === r && last.fc === c;
    const isLastTo    = !!last && last.toR === r && last.toC === c;
    const isInCheck   = !!checkKing && checkKing.r === r && checkKing.c === c;

    sq.classList.toggle('selected',       isSelected);
    sq.classList.toggle('valid-move',     isValid);
    sq.classList.toggle('last-move',      isLastFrom || isLastTo);
    sq.classList.toggle('last-move-from', isLastFrom);
    sq.classList.toggle('last-move-to',   isLastTo);
    sq.classList.toggle('in-check',       isInCheck);

    const piece = game.board[r][c];
    let pieceEl = sq.querySelector('.piece');
    if (piece) {
      if (!pieceEl) {
        pieceEl = document.createElement('div');
        pieceEl.draggable = true;
        pieceEl.addEventListener('dragstart', e => onDragStart(e, r, c));
        sq.appendChild(pieceEl);
      }
      pieceEl.className = 'piece ' + piece.color;
      setChessPieceGraphic(
        pieceEl,
        piece.type,
        piece.color,
        `${piece.color} ${PIECE_LABELS[piece.type]} on ${game.toAlgebraic(r, c)}`
      );
    } else if (pieceEl) {
      pieceEl.remove();
    }
  }

  const existingArrow = boardEl.querySelector('.last-move-arrow');
  if (existingArrow) existingArrow.remove();
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
  if (!game?.moveHistory.length) return;

  const last = game.moveHistory[game.moveHistory.length - 1];
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
  if (!suggestedMoveBeforePlay && gameMode !== 'online')
    suggestedMoveBeforePlay = ai.getSuggestedMove(game, game.currentTurn);
  selectedSquare = { r, c };
  validMoves = game.getLegalMoves(r, c);
  renderBoard();
}

function onDragStart(e, r, c) {
  if (!isPlayerTurn() || aiThinking || pendingPromotion || connectionLost) { e.preventDefault(); return; }
  const piece = game.board[r][c];
  if (!piece || piece.color !== game.currentTurn) { e.preventDefault(); return; }
  if (!suggestedMoveBeforePlay && gameMode !== 'online')
    suggestedMoveBeforePlay = ai.getSuggestedMove(game, game.currentTurn);
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

  if (gameMode === 'computer' && game.currentTurn !== playerColor)
    scheduleAIMove();
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

function scheduleAIMove() {
  aiThinking = true;
  document.getElementById('turn-indicator').textContent = 'Computer is thinking…';
  setTimeout(() => {
    const move = ai.getBestMove(game, difficulty);
    aiThinking = false;
    if (move) {
      const piece = game.board[move.fr][move.fc];
      executeMove(move.fr, move.fc, move.toR, move.toC, 'queen');
    }
  }, 400);
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

function showHint() {
  if (!game || !isPlayerTurn() || aiThinking || gameMode === 'online') return;
  const best = ai.getBestMove(game, 'medium');
  if (!best) return;
  const cols = 'abcdefgh', rows = '87654321';
  const piece = game.board[best.fr][best.fc];
  document.getElementById('hint-text').textContent =
    `Try ${PIECE_LABELS[piece.type]} ${cols[best.fc]}${rows[best.fr]} → ${cols[best.toC]}${rows[best.toR]}`;
  document.getElementById('hint-box').style.display = 'flex';
  selectedSquare = { r: best.fr, c: best.fc };
  validMoves = [{ toR: best.toR, toC: best.toC }];
  renderBoard();
  setTimeout(() => { selectedSquare = null; validMoves = []; renderBoard(); }, 2000);
}

// ─── UI updates ───────────────────────────────────────────────────────────────

function showMatchTab(name) {
  document.querySelectorAll('[data-match-tab]').forEach(tab => {
    const selected = tab.dataset.matchTab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('[data-match-panel]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.matchPanel === name);
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
  if (addFriendBtn) addFriendBtn.style.display = isOnline && currentOpponent?.userId && !currentOpponentBlocked ? '' : 'none';
  const matchFriendMessage = document.getElementById('match-friend-message');
  if (matchFriendMessage) matchFriendMessage.textContent = '';
  if (isOnline && currentOpponent?.userId && typeof window.agsUpdateMatchFriendAction === 'function') {
    window.agsUpdateMatchFriendAction(currentOpponent);
  }

  // Contextual invite prompt
  const invitePrompt = document.getElementById('game-over-invite-prompt');
  if (invitePrompt) {
    invitePrompt.innerHTML = '';
    const isWin  = game.status === 'checkmate' && game.winner === playerColor;
    const isLoss = game.status === 'checkmate' && game.winner && game.winner !== playerColor;
    // A guest who played this match via a live-match invite link (chose "Play
    // without an account" on the gate) — re-present account creation here,
    // regardless of the result, since that's what completes the friend
    // connection with whoever invited them (see agsContinueAsGuestFromInvite).
    const cameFromLiveInvite = gameMode === 'online' && !window.agsCurrentUserId &&
      sessionStorage.getItem('chess_invite_guest') === '1';
    if (isWin || isLoss || cameFromLiveInvite) {
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
      } else if (cameFromLiveInvite) {
        nudge.textContent = '🤝 Create an account to become friends and keep playing!';
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
        window.agsGetPendingInviteName?.().then(name => {
          if (name) nudge.textContent = `🤝 Create an account to add ${name} as a friend!`;
        });
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

  window.agsRecordMatchHistory({
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
  });
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
}

function acceptRematch() {
  if (currentOpponentBlocked) return;
  stopGameOverCountdown();
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

// ─── PeerJS — Online Multiplayer ──────────────────────────────────────────────

function destroyPeer() {
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
  if (typeof window.agsDeactivateChat === 'function') window.agsDeactivateChat();
  remotePeerId = null;
  setCurrentOpponent('', '');
  if (peerConn) { try { peerConn.close(); } catch {} peerConn = null; }
  if (peer)     { try { peer.destroy();   } catch {} peer = null; }
  currentInviteLink = '';
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
    await resolveExpiredMatch(record);
  }
};

window.agsResumeActiveMatch = function() {
  if (!pendingResumeRecord) return;
  const record = pendingResumeRecord;
  pendingResumeRecord = null;
  hideResumePrompt();
  attemptResume(record);
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

  gameMode = 'online';
  playerColor = record.myColor;
  matchStartedAt = new Date(record.startedAt);
  currentMatchId = record.matchId;
  matchHistoryRecorded = false;
  gameEndedByResignation = false;
  setCurrentOpponent(record.opponentName, record.opponentUserId);

  showConnBanner(`Reconnecting to ${record.opponentName}…`, 'warning');

  const [myLive, theirLive] = await Promise.all([
    window.agsFetchLiveMatch?.(record.myUserId),
    window.agsFetchLiveMatch?.(record.opponentUserId),
  ]);
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

  peer = new Peer(iAmHost ? peerId : undefined);
  setupCallHandler();

  if (iAmHost) {
    peer.on('open', () => {
      peer.on('connection', conn => {
        if (peerConn) return;
        peerConn = conn;
        setupPeerConnection(conn, 'host');
      });
    });
  } else {
    peer.on('open', () => {
      const conn = peer.connect(peerId, { reliable: true });
      peerConn = conn;
      setupPeerConnection(conn, 'joiner');
    });
  }

  peer.on('error', () => {
    // Opponent isn't back yet (or the connect attempt otherwise failed) —
    // this re-enters the same disconnected state without resetting the
    // original 10-minute deadline (markMatchDisconnected only sets
    // disconnectedAt once), then retries shortly if there's still time left.
    handleConnectionLost();
    const current = readActiveMatch();
    if (current && (window.agsIsResumable?.(current) ?? true)) {
      setTimeout(() => attemptResume(current), 10_000);
    } else if (current) {
      resolveExpiredMatch(current);
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
  const theirLive = await window.agsFetchLiveMatch?.(record.opponentUserId);
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

  if (iAmTheLoser) {
    window.agsIncrementLoss?.();
    window.agsIncrementGamePlayed?.('online');
    window.agsUpdateStreak?.();
    if (typeof record.opponentRatingAtStart === 'number') {
      window.agsSetOpponentRating?.(record.opponentRatingAtStart);
      window.agsRecordEloResult?.(0);
    }
    window.agsRecordMatchHistory?.({ ...historyEntry, result: 'loss' });
    showConnBanner(`You didn't reconnect in time — recorded as a loss vs ${record.opponentName}.`, 'error');
  } else {
    await window.agsResolveMatchForfeit?.(record.myUserId, record.matchId, record.opponentUserId);
    window.agsIncrementWin?.();
    window.agsIncrementGamePlayed?.('online');
    window.agsUpdateStreak?.();
    if (typeof record.opponentRatingAtStart === 'number') {
      window.agsSetOpponentRating?.(record.opponentRatingAtStart);
      window.agsRecordEloResult?.(1);
    }
    window.agsRecordMatchHistory?.({ ...historyEntry, result: 'win' });
    showConnBanner(`${record.opponentName} didn't reconnect in time — recorded as a win.`, 'success');
  }
  clearActiveMatch();
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

function updateChatAvailability() {
  const statusEl = document.getElementById('online-chat-status');
  const inputEl = document.getElementById('online-chat-input');
  const sendBtn = document.getElementById('btn-chat-send');
  const composeEl = document.querySelector('#online-chat .online-chat-compose');
  const isOnline = gameMode === 'online';
  const state = chatTransportState.state || 'idle';
  const enabled = isOnline && state === 'ready' && !currentOpponentBlocked;
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
  if (composeEl) composeEl.style.display = currentOpponentBlocked ? 'none' : 'flex';
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

  if (shouldBlock && !currentOpponentBlocked) {
    const blockResult = await window.agsBlockPlayer?.(currentOpponent.userId);
    if (!blockResult?.ok) {
      setSafetyMessage('report-player-message', `Report submitted, but blocking failed: ${blockResult?.error || 'try again.'}`, 'error');
      return;
    }
  }
  setSafetyMessage('report-player-message', 'Report submitted. Thank you.', 'success');
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
    activation = () => window.agsActivateSessionChat?.(pendingChatContext.sessionId);
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
    try { conn.send(moveQueue.shift()); } catch { break; }
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
    window.agsCheckResumableMatch?.();
  }, 2500);
}

function setupCallHandler() {
  peer.on('call', call => {
    if (pendingCall) { try { call.close(); } catch {} return; }
    pendingCall = call;
    document.getElementById('video-call-notification').style.display = 'flex';
  });
}

function createOnlineRoom(options = {}) {
  destroyPeer();
  showWaitingScreen('host');

  peer = new Peer();
  setupCallHandler();

  peer.on('open', id => {
    if (options.friendInvite) {
      sendFriendMatchInvite(options.friendInvite, id);
    }

    const showLink = base => {
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
      document.getElementById('waiting-sub').textContent = options.friendInvite
        ? `Invite sent to ${options.friendInvite.displayName || 'your friend'}. Waiting for them to accept…`
        : 'Waiting for your friend to join…';
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

    if (isLocal) {
      const ac = new AbortController();
      const ipTimeout = setTimeout(() => ac.abort(), 3000);
      fetch('https://api4.ipify.org', { signal: ac.signal })
        .then(r => r.text())
        .then(ip => {
          clearTimeout(ipTimeout);
          const portSuffix = window.location.port ? `:${window.location.port}` : '';
          showLink(`${window.location.protocol}//${ip.trim()}${portSuffix}${window.location.pathname}`);
        })
        .catch(() => { clearTimeout(ipTimeout); showLink(base); });
    } else {
      showLink(base);
    }
  });

  peer.on('connection', conn => {
    if (typeof conn.send !== 'function') return;
    if (peerConn) return;   // already have a connection (pending or open) — reject duplicates
    peerConn = conn;
    setupPeerConnection(conn, 'host');
  });

  peer.on('error', err => {
    if (game && gameMode === 'online') {
      console.warn('Peer error during game:', err.type, err.message);
      handleConnectionLost();
    } else {
      console.warn('Connection error:', err.type, err.message);
      const sub = document.getElementById('waiting-sub');
      if (sub) sub.textContent = 'Connection error — ' + (err.message || 'Could not connect.');
      setTimeout(() => { destroyPeer(); showScreen('home'); }, 2000);
    }
  });
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
  createOnlineRoom({ friendInvite: friend });
  pendingChatContext = { type: 'personal', otherUserId: friend.userId };
}

async function sendFriendMatchInvite(friend, peerId) {
  const inviteId = 'invite-' + Math.random().toString(36).slice(2);
  const result = await window.agsSendMatchInvite(friend.userId, {
    inviteId,
    peerId,
    sentAt: new Date().toISOString(),
  });

  const sub = document.getElementById('waiting-sub');
  if (!result?.ok) {
    if (sub) sub.textContent = result?.error || 'Could not send the match invite. You can still share the link below.';
    return;
  }
  if (sub) sub.textContent = `Invite sent to ${friend.displayName || 'your friend'}. Waiting for them to accept…`;
}

function showFriendMatchInvite(invite) {
  pendingFriendMatchInvite = invite;
  const fromName = invite.fromName || 'A friend';
  const nameEl = document.getElementById('friend-match-invite-name');
  const detailEl = document.getElementById('friend-match-invite-detail');
  if (nameEl) nameEl.textContent = `${fromName} invited you to play`;
  if (detailEl) detailEl.textContent = 'Accept to join the match now.';
  document.getElementById('friend-match-invite-notification').style.display = 'flex';
}

function acceptFriendMatchInvite() {
  const invite = pendingFriendMatchInvite;
  pendingFriendMatchInvite = null;
  document.getElementById('friend-match-invite-notification').style.display = 'none';
  if (!invite?.peerId) return;
  gameMode = 'online';
  setCurrentOpponent(invite.fromName || 'Friend', invite.fromUserId || '');
  joinOnlineRoom(invite.peerId);
  if (invite.fromUserId) {
    pendingChatContext = { type: 'personal', otherUserId: invite.fromUserId };
  }
}

function declineFriendMatchInvite() {
  const invite = pendingFriendMatchInvite;
  pendingFriendMatchInvite = null;
  document.getElementById('friend-match-invite-notification').style.display = 'none';
  if (invite?.fromUserId && typeof window.agsSendMatchDecline === 'function') {
    window.agsSendMatchDecline(invite.fromUserId, invite.inviteId);
  }
}

function handleMatchDeclined(invite) {
  const name = invite?.fromName || 'Your friend';
  const sub = document.getElementById('waiting-sub');
  if (sub) sub.textContent = `${name} declined your match invite.`;
  const spinner = document.getElementById('waiting-spinner');
  if (spinner) spinner.style.display = 'none';
  setTimeout(() => { destroyPeer(); showScreen('home'); }, 2500);
}

window.startFriendMatchInvite = startFriendMatchInvite;
window.showFriendMatchInvite = showFriendMatchInvite;
window.acceptFriendMatchInvite = acceptFriendMatchInvite;
window.declineFriendMatchInvite = declineFriendMatchInvite;
window.handleMatchDeclined = handleMatchDeclined;

// Bridge for src/main.js: join a live-match invite link (?peer=) once the
// sign-in-or-guest gate on the invite screen has been resolved.
window.agsJoinPeer = hostPeerId => {
  if (!hostPeerId) return;
  gameMode = 'online';
  joinOnlineRoom(hostPeerId);
};

function joinOnlineRoom(hostPeerId) {
  destroyPeer();
  showWaitingScreen('joiner');

  peer = new Peer();
  setupCallHandler();

  peer.on('open', () => {
    const conn = peer.connect(hostPeerId, { reliable: true });
    peerConn = conn;
    setupPeerConnection(conn, 'joiner');
  });

  peer.on('error', err => {
    if (game && gameMode === 'online') {
      console.warn('Peer error during game:', err.type, err.message);
      handleConnectionLost();
    } else {
      console.warn('Join error:', err.type, err.message);
      const sub = document.getElementById('waiting-sub');
      if (sub) sub.textContent = 'Could not connect — ' + (err.message || 'The link may have expired.');
      setTimeout(() => { destroyPeer(); showScreen('home'); }, 2000);
    }
  });
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
  remotePeerId = conn.peer;
  connRole = role;

  conn.on('open', () => {
    startHeartbeat(conn);

    if (role === 'host') {
      if (game) {
        // Reconnect — joiner will send reconnect_req, then we send resync
        connectionLost = false;
        updateChatAvailability();
        hideConnBanner();
      } else {
        const joinerColor = playerColor === 'white' ? 'black' : 'white';
        const myName = document.getElementById('ags-signedin-name')?.textContent || playerName || 'Opponent';
        const myId   = window.agsCurrentUserId || '';
        const myRating = window.agsGetRating?.() ?? null;
        conn.send({ type: 'game_start', yourColor: joinerColor, opponentName: myName, opponentId: myId, rating: myRating });
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
  });

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
      activateChatForCurrentMatch();
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
    }
  });

  conn.on('close', () => {
    if (peerConn !== conn) return;   // stale event from a replaced/manually-closed connection
    if (!game) { peerConn = null; return; }   // pre-game drop — clear so new connections are accepted
    if (isGameActiveStatus(game.status)) {
      handleConnectionLost();
    }
  });

  conn.on('error', err => {
    console.error('Peer connection error:', err);
    if (peerConn !== conn) return;
    if (!game) { peerConn = null; return; }
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
    'gus-matchmaking':    ['♞', 'Summoning Gambit Gus…',    'Gus is grabbing his board — the game usually starts within a minute.'],
    'matchmaking-host':   ['⚡', 'Match found!',            'Setting up the connection — you play as White.'],
    'matchmaking-joiner': ['⚡', 'Match found!',            'Connecting to opponent — you play as Black.'],
  };
  const [icon, title, sub] = messages[role] || messages['joiner'];
  document.getElementById('waiting-icon').textContent = icon;
  document.getElementById('waiting-title').textContent = title;
  document.getElementById('waiting-sub').textContent = sub;
  document.getElementById('invite-link-section').style.display = 'none';
  document.getElementById('waiting-spinner').style.display = 'block';
}

function cancelOnlineGame() {
  destroyPeer();
  showScreen('home');
}

function cancelWaiting() {
  if (matchmakingActive) {
    matchmakingActive = false;
    stopMatchmakingWaitTimer();
    if (typeof window.agsCancelMatchmaking === 'function') {
      window.agsCancelMatchmaking();
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
// instead of leaving the player to wait out the 20s humans-first gate.
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
    function onFound(match) {
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

      playerColor = isHost ? 'white' : 'black';
      matchmakingActive = false;
      showWaitingScreen(isHost ? 'matchmaking-host' : 'matchmaking-joiner');

      destroyPeer();
      pendingChatContext = sessionId
        ? { type: 'session', sessionId }
        : null;
      peer = new Peer(isHost ? peerId : undefined);
      setupCallHandler();

      if (isHost) {
        peer.on('open', () => {
          peer.on('connection', conn => {
            if (peerConn) return;
            peerConn = conn;
            setupPeerConnection(conn, 'host');
          });
        });
      } else {
        peer.on('open', () => {
          setTimeout(() => {
            const conn = peer.connect(peerId, { reliable: true });
            peerConn = conn;
            setupPeerConnection(conn, 'joiner');
          }, 1500);
        });
      }

      peer.on('error', err => {
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
        ? "Gus couldn't make it to the board this time. Try again in a moment."
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
  // Desktop fallback: the share-row buttons below already cover Copy/WhatsApp/X/Email
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

async function startVideoChat() {
  if (mediaCall) { endVideoChat(); return; }
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Video chat requires HTTPS.\n\nRestart the server using start_server.command — it now serves HTTPS automatically.');
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('local-video').srcObject = localStream;
    document.getElementById('video-status').style.display = 'flex';
    document.getElementById('video-chat-panel').style.display = 'flex';
    document.getElementById('btn-video-chat').textContent = '📵 End Call';

    mediaCall = peer.call(remotePeerId, localStream);
    mediaCall.on('stream', remoteStream => {
      document.getElementById('remote-video').srcObject = remoteStream;
      document.getElementById('video-status').style.display = 'none';
    });
    mediaCall.on('close', endVideoChat);
    mediaCall.on('error', endVideoChat);
  } catch (e) {
    alert('Could not access camera/microphone:\n' + e.message);
    endVideoChat();
  }
}

async function acceptVideoCall() {
  document.getElementById('video-call-notification').style.display = 'none';
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Video chat requires HTTPS.\n\nRestart the server using start_server.command — it now serves HTTPS automatically.');
    declineVideoCall();
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('local-video').srcObject = localStream;
    document.getElementById('video-status').style.display = 'none';
    document.getElementById('video-chat-panel').style.display = 'flex';
    document.getElementById('btn-video-chat').textContent = '📵 End Call';

    pendingCall.answer(localStream);
    mediaCall    = pendingCall;
    pendingCall  = null;
    mediaCall.on('stream', remoteStream => {
      document.getElementById('remote-video').srcObject = remoteStream;
    });
    mediaCall.on('close', endVideoChat);
    mediaCall.on('error', endVideoChat);
  } catch (e) {
    alert('Could not access camera/microphone:\n' + e.message);
    declineVideoCall();
  }
}

function declineVideoCall() {
  document.getElementById('video-call-notification').style.display = 'none';
  if (pendingCall) { try { pendingCall.close(); } catch {} pendingCall = null; }
}

function endVideoChat() {
  if (mediaCall)   { try { mediaCall.close();  } catch {} mediaCall  = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  pendingCall  = null;
  audioEnabled = true;
  camEnabled   = true;
  const panel = document.getElementById('video-chat-panel');
  if (panel) panel.style.display = 'none';
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
    list.innerHTML = '<p class="no-contacts">No contacts yet. Add one below!</p>';
    return;
  }
  for (const contact of contacts) {
    const item = document.createElement('div');
    item.className = 'contact-item';
    const initials = contact.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);

    const btn = document.createElement('button');
    btn.className = 'btn btn-invite';
    btn.textContent = inviteMode ? 'Send' : 'Invite';
    btn.addEventListener('click', () => {
      if (inviteMode && currentInviteLink) {
        sendInviteToContact(contact.name, contact.address, currentInviteLink);
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeContact(contact.address));

    item.innerHTML = `
      <div class="contact-avatar">${escapeHtml(initials)}</div>
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
    const token = typeof window.agsGetToken === 'function' ? window.agsGetToken() : null;
    const extendBase = (typeof __EXTEND_EMAIL_URL__ !== 'undefined' && __EXTEND_EMAIL_URL__)
      ? __EXTEND_EMAIL_URL__
      : '/extend';

    try {
      const res = await fetch(`${extendBase}/invite/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify({ to: address, from_name: fromName, invite_link: link }),
      });
      if (!res.ok) throw new Error('status ' + res.status);
      showConnBanner(`Invite sent to ${name}!`, 'success');
    } catch (err) {
      console.warn('[invite] email send failed:', err);
      showConnBanner('Could not send email — share the link below manually.', 'error');
    }
  } else {
    const msg = `Hey ${name}! Let's play chess. Open this link to join my game: ${link}`;
    window.open(`sms:${address}?&body=${encodeURIComponent(msg)}`);
  }
  showScreen('waiting');
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function confirmGoHome() {
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

window.addEventListener('DOMContentLoaded', () => {
  hydrateStaticPieceIcons();
  renderLeaderboard();
  // ?peer= (a live-match invite link) is no longer auto-joined here — it goes
  // through src/main.js's initAuth() first, which gates it behind the
  // sign-in-or-guest screen (#screen-invite) before calling window.agsJoinPeer.
});

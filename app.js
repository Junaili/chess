'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYMBOLS = {
  white: { king:'♔', queen:'♕', rook:'♖', bishop:'♗', knight:'♘', pawn:'♙' },
  // U+265F (♟) is the only chess glyph with Unicode emoji presentation, so it
  // can resolve to the color-emoji font (tofu in the iOS Simulator WebView).
  // Append U+FE0E (text variation selector) to force monochrome text rendering.
  black: { king:'♚', queen:'♛', rook:'♜', bishop:'♝', knight:'♞', pawn:'♟︎' }
};

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
let chatMessages   = [];
let currentOpponent = null;
let pendingFriendMatchInvite = null;
let matchStartedAt = null;
let matchHistoryRecorded = false;
let gameOverCountdownTimer = null;
let gameOverCountdownRemaining = 0;
let homeIdleTimer = null;
let homeIdleShown = false;

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

  const pieceSymbol = playerColor === 'white' ? '♔' : '♚';
  const squareBg   = playerColor === 'white' ? '#b58863' : '#f0d9b5';
  const isCustom   = selectedPieceColor && !colors.some(c => c.hex === selectedPieceColor);

  const container = document.getElementById('piece-color-options');
  container.innerHTML = '';

  colors.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'piece-color-btn' + (selectedPieceColor === c.hex ? ' selected' : '');
    btn.innerHTML =
      '<span class="color-swatch-bg" style="background:' + squareBg + '">' +
        '<span class="color-swatch-piece" style="color:' + c.hex + '">' + pieceSymbol + '</span>' +
      '</span>' +
      '<span class="piece-color-name">' + c.name + '</span>';
    btn.onclick = () => selectPieceColor(c.hex);
    container.appendChild(btn);
  });

  // Custom color button
  const customBtn = document.createElement('button');
  customBtn.className = 'piece-color-btn' + (isCustom ? ' selected' : '');
  if (isCustom) {
    customBtn.innerHTML =
      '<span class="color-swatch-bg" style="background:' + squareBg + '">' +
        '<span class="color-swatch-piece" style="color:' + selectedPieceColor + '">' + pieceSymbol + '</span>' +
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
  document.getElementById('black-score').textContent = '0';
  document.getElementById('white-score').textContent = '0';
  resetChatState();

  const isOnline = gameMode === 'online';
  const myName = document.getElementById('ags-signedin-name')?.textContent || playerName || 'You';
  const myId   = window.agsCurrentUserId || '';

  if (isOnline) {
    setPlayerInfo(playerColor, myName, myId);
    if (currentOpponent) {
      setPlayerInfo(playerColor === 'white' ? 'black' : 'white', currentOpponent.name, currentOpponent.userId);
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
  updateChatAvailability();

  showScreen('game');
  renderBoard();
  updateStatus();

  if (gameMode === 'computer' && playerColor === 'black') {
    scheduleAIMove();
  }
}

function startNewGame() {
  closeModal('game-over-modal');
  destroyPeer();
  showScreen('home');
}

// ─── Board rendering ──────────────────────────────────────────────────────────

function initBoard() {
  const boardEl = document.getElementById('chess-board');
  boardEl.innerHTML = '';
  const flipped = playerColor === 'black';
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
      pieceEl.textContent = SYMBOLS[piece.color][piece.type];
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
  if (game.status === 'checkmate' || game.status === 'stalemate') return;

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

  if (game.status === 'checkmate' || game.status === 'stalemate') {
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

  if (game.status === 'checkmate' || game.status === 'stalemate')
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
    `Try ${SYMBOLS[piece.color][piece.type]} ${cols[best.fc]}${rows[best.fr]} → ${cols[best.toC]}${rows[best.toR]}`;
  document.getElementById('hint-box').style.display = 'flex';
  selectedSquare = { r: best.fr, c: best.fc };
  validMoves = [{ toR: best.toR, toC: best.toC }];
  renderBoard();
  setTimeout(() => { selectedSquare = null; validMoves = []; renderBoard(); }, 2000);
}

// ─── UI updates ───────────────────────────────────────────────────────────────

function getMoveActor(moveColor, isLocalMove) {
  if (gameMode === 'computer') return isLocalMove ? 'You' : 'Computer';
  if (gameMode === 'online') return isLocalMove ? 'You' : 'Opponent';
  return moveColor === 'white' ? 'White' : 'Black';
}

function getTurnStatusText() {
  if (game.status === 'checkmate') {
    return `${game.winner === 'white' ? 'White' : 'Black'} wins by checkmate!`;
  }
  if (game.status === 'stalemate') return 'Stalemate — Draw!';
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
    statusBar.classList.toggle('status-stalemate', game.status === 'stalemate');
  }
}

function updateActivePlayerCards() {
  const whiteCard = document.getElementById('white-player-card');
  const blackCard = document.getElementById('black-player-card');
  if (!whiteCard || !blackCard || !game) return;

  const active = game.status === 'playing' || game.status === 'check';
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
    wHtml += `<span class="cap-piece">${SYMBOLS[p.color][p.type]}</span>`;
    wScore += VALS[p.type];
  }
  for (const p of game.capturedByBlack) {
    bHtml += `<span class="cap-piece">${SYMBOLS[p.color][p.type]}</span>`;
    bScore += VALS[p.type];
  }
  document.getElementById('captured-by-white').innerHTML = wHtml;
  document.getElementById('captured-by-black').innerHTML = bHtml;
  document.getElementById('white-score').textContent = wScore;
  document.getElementById('black-score').textContent = bScore;
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
    btn.className = 'prom-btn';
    btn.textContent = SYMBOLS[color][type];
    btn.title = type[0].toUpperCase() + type.slice(1);
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
  recordMatchHistoryOnce();
  window.agsClearLiveMatch?.()

  if (game.status === 'checkmate' && game.winner === playerColor) {
    recordWin();
    if (typeof window.agsIncrementWin === 'function') window.agsIncrementWin();
  } else if (game.status === 'checkmate' && game.winner && game.winner !== playerColor) {
    if (typeof window.agsIncrementLoss === 'function') window.agsIncrementLoss();
  } else if (game.status === 'stalemate') {
    if (typeof window.agsIncrementDraw === 'function') window.agsIncrementDraw();
  }
  if (typeof window.agsIncrementGamePlayed === 'function') window.agsIncrementGamePlayed(gameMode);
  window.agsUpdateStreak?.();

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
    msg.textContent = 'The game ended in stalemate.';
  }

  const isOnline = gameMode === 'online';
  document.getElementById('btn-play-again').style.display = isOnline ? 'none' : '';
  const rematchBtn = document.getElementById('btn-rematch');
  rematchBtn.style.display = isOnline ? '' : 'none';
  rematchBtn.textContent = 'Rematch';
  rematchBtn.disabled = false;
  setRematchMessage('');

  const addFriendBtn = document.getElementById('btn-add-match-friend');
  if (addFriendBtn) addFriendBtn.style.display = isOnline && currentOpponent?.userId ? '' : 'none';
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
    if (isWin || isLoss) {
      const inviteUrl = window.agsGetInviteUrl?.();
      const nudge = document.createElement('p');
      nudge.className = 'invite-nudge-text';
      if (inviteUrl) {
        nudge.textContent = isWin ? '🎉 Challenge someone new →' : '💪 Challenge a different opponent →';
        invitePrompt.appendChild(nudge);
        if (typeof window.agsShareRow === 'function') window.agsShareRow(invitePrompt, inviteUrl);
      } else {
        nudge.textContent = isWin ? '🎉 Invite a friend to challenge you!' : '💪 Think you can win? Invite a friend!';
        nudge.className += ' invite-nudge-cta';
        nudge.addEventListener('click', () => { window.agsOpenRegister?.(); });
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
  const result = game.status === 'stalemate'
    ? 'draw'
    : game.winner === playerColor
      ? 'win'
      : 'loss';

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
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    moves: game.moveHistory.map(m => ({ fr: m.fr, fc: m.fc, toR: m.toR, toC: m.toC, promType: m.promType || 'queen' })),
    whiteName: document.getElementById('white-player-name')?.textContent || 'White',
    blackName: document.getElementById('black-player-name')?.textContent || 'Black',
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
  startGame();
}

function endOnlineAndGoHome() {
  closeModal('game-over-modal');
  destroyPeer();
  showScreen('home');
}

// ─── PeerJS — Online Multiplayer ──────────────────────────────────────────────

function destroyPeer() {
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

function resetChatState() {
  chatMessages = [];
  const messagesEl = document.getElementById('online-chat-messages');
  const inputEl = document.getElementById('online-chat-input');
  if (messagesEl) {
    messagesEl.innerHTML = '<div class="chat-empty">Chat is available while playing another person online.</div>';
  }
  if (inputEl) inputEl.value = '';
}

function updateChatAvailability() {
  const statusEl = document.getElementById('online-chat-status');
  const inputEl = document.getElementById('online-chat-input');
  const sendBtn = document.getElementById('btn-chat-send');
  const isOnline = gameMode === 'online';
  const connected = !!peerConn?.open && !connectionLost;
  const enabled = isOnline && connected;

  if (statusEl) statusEl.textContent = enabled ? 'Connected' : 'Reconnecting…';
  if (inputEl) inputEl.disabled = !enabled;
  if (sendBtn) sendBtn.disabled = !enabled;
}

function renderChatMessages() {
  const messagesEl = document.getElementById('online-chat-messages');
  if (!messagesEl) return;

  if (chatMessages.length === 0) {
    messagesEl.innerHTML = '<div class="chat-empty">Chat is available while playing another person online.</div>';
    return;
  }

  messagesEl.innerHTML = chatMessages.map(m => `
    <div class="chat-message ${m.side}">
      <span class="chat-message-meta">${escapeHtml(m.name)}</span>
      <div class="chat-message-body">${escapeHtml(m.text)}</div>
    </div>
  `).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendChatMessageToDOM(message) {
  const messagesEl = document.getElementById('online-chat-messages');
  if (!messagesEl) return;
  const empty = messagesEl.querySelector('.chat-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'chat-message ' + message.side;
  div.innerHTML = `<span class="chat-message-meta">${escapeHtml(message.name)}</span><div class="chat-message-body">${escapeHtml(message.text)}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendChatMessage(side, name, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const message = { side, name: name || (side === 'self' ? 'You' : 'Opponent'), text: trimmed };
  chatMessages.push(message);
  if (chatMessages.length > 100) chatMessages = chatMessages.slice(-100);
  appendChatMessageToDOM(message);
}

function sendChatMessage() {
  if (gameMode !== 'online' || !peerConn?.open || connectionLost) return;
  const inputEl = document.getElementById('online-chat-input');
  if (!inputEl) return;

  const text = inputEl.value.trim();
  if (!text) return;

  const name = getCurrentPlayerDisplayName();
  appendChatMessage('self', name, text);
  sendOrQueue({ type: 'chat', name, text });
  inputEl.value = '';
  inputEl.focus();
}

function handleChatInputKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  sendChatMessage();
}

window.sendChatMessage = sendChatMessage;
window.handleChatInputKeydown = handleChatInputKeydown;

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
  showConnBanner('Connection lost — returning to menu…', 'error');
  setTimeout(() => {
    closeModal('game-over-modal');
    destroyPeer();
    showScreen('home');
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
      currentInviteLink = `${base}?peer=${id}`;
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

    const base = window.location.href.split('?')[0];
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

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
        conn.send({ type: 'game_start', yourColor: joinerColor, opponentName: myName, opponentId: myId });
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
    if (data.type === 'ping') {
      try { conn.send({ type: 'pong' }); } catch {}
      return;
    }
    if (data.type === 'pong') {
      lastPongTime = Date.now();
      return;
    }

    if (data.type === 'game_start') {
      playerColor = data.yourColor;
      setCurrentOpponent(data.opponentName || 'Opponent', data.opponentId || '');
      if (data.opponentId && data.opponentName) {
        if (typeof window.cacheDisplayName === 'function') window.cacheDisplayName(data.opponentId, data.opponentName);
      }
      startGame();
      // Show host's identity as our opponent
      const oppColor = data.yourColor === 'white' ? 'black' : 'white';
      setPlayerInfo(oppColor, data.opponentName || 'Opponent', data.opponentId || '');
      // Send back our own identity
      const myName = document.getElementById('ags-signedin-name')?.textContent || playerName || 'Opponent';
      const myId   = window.agsCurrentUserId || '';
      try { conn.send({ type: 'player_info', name: myName, userId: myId }); } catch {}
    } else if (data.type === 'player_info') {
      setCurrentOpponent(data.name || 'Opponent', data.userId || '');
      if (data.userId && data.name) {
        if (typeof window.cacheDisplayName === 'function') window.cacheDisplayName(data.userId, data.name);
      }
      const oppColor = playerColor === 'white' ? 'black' : 'white';
      setPlayerInfo(oppColor, data.name || 'Opponent', data.userId || '');
    } else if (data.type === 'chat') {
      appendChatMessage('opponent', data.name || 'Opponent', data.text || '');
    } else if (data.type === 'move') {
      applyOpponentMove(data.fr, data.fc, data.toR, data.toC, data.promType || 'queen');
    } else if (data.type === 'reconnect_req') {
      // Joiner reconnected — send full game state so they can resync
      try { conn.send({ type: 'resync', moves: moveLog, chatMessages }); } catch {}
      connectionLost = false;
      reconnectCount = 0;
      updateChatAvailability();
      hideConnBanner();
      showConnBanner('Opponent reconnected!', 'success');
    } else if (data.type === 'resync') {
      // Replay all moves on a fresh board
      moveQueue = [];
      reconnectCount = 0;
      connectionLost = false;
      game = new ChessGame();
      document.getElementById('move-list').innerHTML = '';
      document.getElementById('captured-by-white').innerHTML = '';
      document.getElementById('captured-by-black').innerHTML = '';
      chatMessages = Array.isArray(data.chatMessages) ? data.chatMessages.slice(-100) : [];
      for (const m of data.moves) {
        const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
        game.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
        addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
      }
      updateCapturedPieces();
      updateStatus();
      renderBoard();
      renderChatMessages();
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
      // Only the host receives this (joiner accepted host's request)
      sendRematchStart();
    } else if (data.type === 'rematch_decline') {
      rematchPending = false;
      const btn = document.getElementById('btn-rematch');
      if (btn) { btn.textContent = 'Opponent declined'; btn.disabled = true; }
      setRematchMessage('Your opponent declined the rematch request.', 'muted');
      if (document.getElementById('game-over-modal').style.display === 'flex') startGameOverCountdown();
    } else if (data.type === 'rematch_start') {
      playerColor = data.yourColor;
      startRematch();
    }
  });

  conn.on('close', () => {
    if (peerConn !== conn) return;   // stale event from a replaced/manually-closed connection
    if (!game) { peerConn = null; return; }   // pre-game drop — clear so new connections are accepted
    if (game.status === 'playing' || game.status === 'check') {
      handleConnectionLost();
    }
  });

  conn.on('error', err => {
    console.error('Peer connection error:', err);
    if (peerConn !== conn) return;
    if (!game) { peerConn = null; return; }
    if (game.status === 'playing' || game.status === 'check') {
      handleConnectionLost();
    }
  });
}

function showWaitingScreen(role) {
  showScreen('waiting');
  const messages = {
    'host':               ['🎮', 'Invite your friend',      'Share the link below. The game starts when they open it.'],
    'joiner':             ['⏳', 'Joining game…',           'Connecting to your friend. Please wait.'],
    'matchmaking':        ['🔍', 'Finding opponent…',       'Searching for a random opponent. This may take a moment.'],
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
  if (typeof window.agsStartMatchmaking !== 'function') {
    alert('Sign in to play against random players.');
    return;
  }
  matchmakingActive = true;
  gameMode = 'online';
  showWaitingScreen('matchmaking');
  const queueStartedAt = Date.now();
  if (typeof window.agsSendEvent === 'function') window.agsSendEvent('matchmaking_started', {});
  window.agsStartMatchmaking(
    function onFound(memberUserIds) {
      if (!matchmakingActive) return;
      if (typeof window.agsSendEvent === 'function') {
        window.agsSendEvent('matchmaking_matched', { wait_time_ms: Date.now() - queueStartedAt });
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
      if (typeof window.agsSendEvent === 'function') {
        window.agsSendEvent('matchmaking_timeout', { wait_time_ms: Date.now() - queueStartedAt });
      }
      destroyPeer();
      showScreen('home');
      alert('No opponent found. Try again in a moment.');
    },
    function onError(msg) {
      if (!matchmakingActive) return;
      matchmakingActive = false;
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
  if (game?.status === 'playing' && game.moveHistory.length > 0) {
    if (!confirm('Leave this game? The current game will be lost.')) return;
  }
  destroyPeer();
  showScreen('home');
}

function confirmNewGame() {
  if (game && game.status !== 'checkmate' && game.status !== 'stalemate' && game.moveHistory.length > 0) {
    if (!confirm('Start a new game? The current game will be lost.')) return;
  }
  startGame();
}

function resignGame() {
  if (!game || game.status === 'checkmate' || game.status === 'stalemate') return;
  if (gameMode !== 'computer') return;
  if (!confirm('Resign this game? It will count as a loss.')) return;
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
    if (!peerConn.open && game?.status === 'playing') {
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
    active: game.status === 'playing' || game.status === 'check',
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
  renderLeaderboard();
  const params = new URLSearchParams(window.location.search);
  const hostPeerId = params.get('peer');
  if (hostPeerId) {
    // Remove query string from URL bar so reloading doesn't re-join
    history.replaceState({}, '', window.location.pathname);
    gameMode = 'online';
    joinOnlineRoom(hostPeerId);
  }
});

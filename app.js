'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYMBOLS = {
  white: { king:'♔', queen:'♕', rook:'♖', bishop:'♗', knight:'♘', pawn:'♙' },
  black: { king:'♚', queen:'♛', rook:'♜', bishop:'♝', knight:'♞', pawn:'♟' }
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
  if (name === 'home') renderLeaderboard();
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

function startGame() {
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

  const isOnline = gameMode === 'online';
  document.getElementById('white-player-name').textContent =
    isOnline   ? (playerColor === 'white' ? 'You' : 'Opponent') :
    gameMode === 'computer' ? (playerColor === 'white' ? 'You' : 'Computer') : 'White';
  document.getElementById('black-player-name').textContent =
    isOnline   ? (playerColor === 'black' ? 'You' : 'Opponent') :
    gameMode === 'computer' ? (playerColor === 'black' ? 'You' : 'Computer') : 'Black';

  // Hide hint button during online games; show video chat button instead
  document.getElementById('btn-hint').style.display = isOnline ? 'none' : '';
  document.getElementById('btn-video-chat').style.display = isOnline ? '' : 'none';

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

function renderBoard() {
  const boardEl = document.getElementById('chess-board');
  boardEl.innerHTML = '';
  const flipped = playerColor === 'black';

  for (let ri = 0; ri < 8; ri++) {
    for (let ci = 0; ci < 8; ci++) {
      const r = flipped ? 7 - ri : ri;
      const c = flipped ? 7 - ci : ci;

      const sq = document.createElement('div');
      sq.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      sq.dataset.r = r;
      sq.dataset.c = c;

      if (selectedSquare?.r === r && selectedSquare?.c === c)
        sq.classList.add('selected');
      if (validMoves.some(m => m.toR === r && m.toC === c))
        sq.classList.add('valid-move');
      if (game.moveHistory.length > 0) {
        const last = game.moveHistory[game.moveHistory.length - 1];
        if ((last.fr === r && last.fc === c) || (last.toR === r && last.toC === c))
          sq.classList.add('last-move');
      }
      if (game.status === 'check' || game.status === 'checkmate') {
        const king = game.findKing(game.currentTurn);
        if (king?.r === r && king?.c === c) sq.classList.add('in-check');
      }

      const piece = game.board[r][c];
      if (piece) {
        const pieceEl = document.createElement('div');
        pieceEl.className = 'piece ' + piece.color;
        pieceEl.textContent = SYMBOLS[piece.color][piece.type];
        pieceEl.draggable = true;
        pieceEl.addEventListener('dragstart', e => onDragStart(e, r, c));
        sq.appendChild(pieceEl);
      }

      sq.addEventListener('click', () => onSquareClick(r, c));
      sq.addEventListener('dragover', e => e.preventDefault());
      sq.addEventListener('drop', e => onDrop(e, r, c));
      boardEl.appendChild(sq);
    }
  }
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
  if (!game.makeMove(fr, fc, toR, toC, promType)) return;
  if (game.capturedByWhite.length + game.capturedByBlack.length > capturesBefore) playCapture();

  selectedSquare = null;
  validMoves = [];

  // Relay to opponent
  if (gameMode === 'online') {
    const msg = { type: 'move', fr, fc, toR, toC, promType };
    if (connRole === 'host') moveLog.push(msg);
    sendOrQueue(msg);
  }

  addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
  updateCapturedPieces();
  updateStatus();
  renderBoard();
  showMoveHint(fr, fc, toR, toC);
  suggestedMoveBeforePlay = null;

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
  if (game.capturedByWhite.length + game.capturedByBlack.length > capturesBefore) playCapture();

  selectedSquare = null;
  validMoves = [];
  addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
  updateCapturedPieces();
  updateStatus();
  renderBoard();

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

// ─── AI ───────────────────────────────────────────────────────────────────────

function scheduleAIMove() {
  aiThinking = true;
  document.getElementById('turn-indicator').textContent = 'Computer is thinking…';
  setTimeout(() => {
    const move = ai.getBestMove(game, difficulty);
    aiThinking = false;
    if (move) {
      const piece = game.board[move.fr][move.fc];
      const isPromo = piece.type === 'pawn' && (move.toR === 0 || move.toR === 7);
      executeMove(move.fr, move.fc, move.toR, move.toC, isPromo ? 'queen' : 'queen');
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

function updateStatus() {
  const el = document.getElementById('turn-indicator');
  if (game.status === 'checkmate') {
    el.textContent = `${game.winner === 'white' ? 'White' : 'Black'} wins by checkmate!`;
  } else if (game.status === 'stalemate') {
    el.textContent = 'Stalemate — Draw!';
  } else if (game.status === 'check') {
    el.textContent = `${game.currentTurn === 'white' ? 'White' : 'Black'} is in check!`;
  } else if (gameMode === 'computer' && !aiThinking) {
    el.textContent = game.currentTurn === playerColor ? 'Your turn' : "Computer's turn";
  } else if (gameMode === 'online') {
    el.textContent = game.currentTurn === playerColor ? 'Your turn' : "Opponent's turn";
  } else {
    el.textContent = (game.currentTurn === 'white' ? 'White' : 'Black') + "'s turn";
  }
}

function updateCapturedPieces() {
  const VALS = { pawn:1, knight:3, bishop:3, rook:5, queen:9, king:0 };
  let wScore = 0, bScore = 0;
  const wEl = document.getElementById('captured-by-white');
  const bEl = document.getElementById('captured-by-black');
  wEl.innerHTML = '';
  bEl.innerHTML = '';
  for (const p of game.capturedByWhite) {
    wEl.innerHTML += `<span class="cap-piece">${SYMBOLS[p.color][p.type]}</span>`;
    wScore += VALS[p.type];
  }
  for (const p of game.capturedByBlack) {
    bEl.innerHTML += `<span class="cap-piece">${SYMBOLS[p.color][p.type]}</span>`;
    bScore += VALS[p.type];
  }
  document.getElementById('white-score').textContent = wScore;
  document.getElementById('black-score').textContent = bScore;
}

function addMoveToList(notation, color) {
  const listEl = document.getElementById('move-list');
  const moveNum = Math.ceil(game.moveHistory.length / 2);
  if (color === 'white') {
    const row = document.createElement('div');
    row.className = 'move-row';
    row.id = `move-row-${moveNum}`;
    row.innerHTML = `<span class="move-num">${moveNum}.</span>
      <span class="move-white">${notation}</span><span class="move-black"></span>`;
    listEl.appendChild(row);
  } else {
    document.getElementById(`move-row-${moveNum}`)?.querySelector('.move-black')
      ?.textContent !== undefined &&
      (document.getElementById(`move-row-${moveNum}`).querySelector('.move-black').textContent = notation);
  }
  listEl.scrollTop = listEl.scrollHeight;
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
  if (game.status === 'checkmate' && game.winner === playerColor) {
    recordWin();
  }

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

  document.getElementById('game-over-modal').style.display = 'flex';
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// ─── Rematch ──────────────────────────────────────────────────────────────────

function requestRematch() {
  if (!peerConn?.open || rematchPending) return;
  rematchPending = true;
  const btn = document.getElementById('btn-rematch');
  btn.textContent = 'Waiting for opponent…';
  btn.disabled = true;
  peerConn.send({ type: 'rematch_request' });
}

function acceptRematch() {
  document.getElementById('rematch-notification').style.display = 'none';
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
  closeModal('game-over-modal');
  document.getElementById('rematch-notification').style.display = 'none';
  moveLog   = [];
  moveQueue = [];
  startGame();
}

function endOnlineAndGoHome() {
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
  if (peerConn) { try { peerConn.close(); } catch {} peerConn = null; }
  if (peer)     { try { peer.destroy();   } catch {} peer = null; }
  currentInviteLink = '';
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

function flushMoveQueue(conn) {
  while (moveQueue.length > 0 && conn?.open) {
    try { conn.send(moveQueue.shift()); } catch { break; }
  }
}

function handleConnectionLost() {
  if (reconnectCount >= MAX_RECONNECTS) {
    showConnBanner('Connection lost. Please start a new game.', 'error');
    connectionLost = true;
    return;
  }

  if (peerConn) { try { peerConn.close(); } catch {} peerConn = null; }
  stopHeartbeat();
  connectionLost = true;

  if (connRole === 'joiner') {
    showConnBanner('Connection lost — reconnecting…', 'warning');
    reconnectCount++;
    reconnectTimer = setTimeout(attemptReconnect, reconnectCount * 2000);
  } else {
    showConnBanner('Opponent disconnected — waiting for them to reconnect…', 'warning');
  }
}

function attemptReconnect() {
  if (!peer || !remotePeerId) return;
  try {
    const conn = peer.connect(remotePeerId, { reliable: true });
    peerConn = conn;
    setupPeerConnection(conn, 'joiner');
  } catch {
    if (reconnectCount < MAX_RECONNECTS) {
      reconnectCount++;
      reconnectTimer = setTimeout(attemptReconnect, reconnectCount * 2000);
    } else {
      showConnBanner('Could not reconnect. Please start a new game.', 'error');
    }
  }
}

function setupCallHandler() {
  peer.on('call', call => {
    if (pendingCall) { try { call.close(); } catch {} return; }
    pendingCall = call;
    document.getElementById('video-call-notification').style.display = 'flex';
  });
}

function createOnlineRoom() {
  destroyPeer();
  showWaitingScreen('host');

  peer = new Peer();
  setupCallHandler();

  peer.on('open', id => {
    const showLink = base => {
      currentInviteLink = `${base}?peer=${id}`;
      document.getElementById('invite-link-text').textContent = currentInviteLink;
      document.getElementById('invite-link-section').style.display = 'block';
      document.getElementById('waiting-sub').textContent = 'Waiting for your friend to join…';
      document.getElementById('waiting-spinner').style.display = 'block';
    };

    fetch('https://api4.ipify.org')
      .then(r => r.text())
      .then(ip => {
        const port = window.location.port || '8000';
        showLink(`${window.location.protocol}//${ip.trim()}:${port}${window.location.pathname}`);
      })
      .catch(() => showLink(window.location.href.split('?')[0]));
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
      alert('Connection error: ' + err.message + '\n\nMake sure both devices are online.');
      destroyPeer();
      showScreen('home');
    }
  });
}

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
      alert('Could not connect to the game: ' + err.message + '\n\nThe link may have expired.');
      destroyPeer();
      showScreen('home');
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
        hideConnBanner();
      } else {
        const joinerColor = playerColor === 'white' ? 'black' : 'white';
        conn.send({ type: 'game_start', yourColor: joinerColor });
        startGame();
      }
    } else {
      connectionLost = false;   // unlock the board as soon as the connection re-opens
      if (game) {
        // Reconnect — signal host to send resync
        try { conn.send({ type: 'reconnect_req' }); } catch {}
      }
      // First connection: wait for game_start from host
    }
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
      startGame();
    } else if (data.type === 'move') {
      applyOpponentMove(data.fr, data.fc, data.toR, data.toC, data.promType || 'queen');
    } else if (data.type === 'reconnect_req') {
      // Joiner reconnected — send full game state so they can resync
      try { conn.send({ type: 'resync', moves: moveLog }); } catch {}
      connectionLost = false;
      reconnectCount = 0;
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
      for (const m of data.moves) {
        const notation = game.getMoveNotation(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
        game.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen');
        addMoveToList(notation, game.currentTurn === 'white' ? 'black' : 'white');
      }
      updateCapturedPieces();
      updateStatus();
      renderBoard();
      showConnBanner('Reconnected!', 'success');
    } else if (data.type === 'resign') {
      alert('Your opponent resigned. You win!');
      showGameOver();
    } else if (data.type === 'rematch_request') {
      if (rematchPending && connRole === 'host') {
        // Both clicked Rematch simultaneously — host takes initiative
        sendRematchStart();
      } else if (!rematchPending) {
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
  if (role === 'host') {
    document.getElementById('waiting-icon').textContent = '🎮';
    document.getElementById('waiting-title').textContent = 'Invite your friend';
    document.getElementById('waiting-sub').textContent = 'Share the link below. The game starts when they open it.';
    document.getElementById('invite-link-section').style.display = 'none'; // shown after peer opens
    document.getElementById('waiting-spinner').style.display = 'block';
  } else {
    document.getElementById('waiting-icon').textContent = '⏳';
    document.getElementById('waiting-title').textContent = 'Joining game…';
    document.getElementById('waiting-sub').textContent = 'Connecting to your friend. Please wait.';
    document.getElementById('invite-link-section').style.display = 'none';
    document.getElementById('waiting-spinner').style.display = 'block';
  }
}

function cancelOnlineGame() {
  destroyPeer();
  showScreen('home');
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
  } else {
    copyInviteLink();
  }
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

function sendInviteToContact(name, address, link) {
  const msg = `Hey ${name}! Let's play chess. Open this link to join my game: ${link}`;
  if (address.includes('@')) {
    window.open(`mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent("Chess Game — Join me!")}&body=${encodeURIComponent(msg)}`);
  } else {
    window.open(`sms:${address}?&body=${encodeURIComponent(msg)}`);
  }
  showScreen('waiting');
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function confirmGoHome() {
  if (game?.status === 'playing' && game.moveHistory.length > 0) {
    if (!confirm('Go back to the menu? The current game will be lost.')) return;
  }
  destroyPeer();
  showScreen('home');
}

function savePlayerName() {
  const val = document.getElementById('player-name-input')?.value.trim();
  if (val) { playerName = val; localStorage.setItem('chess_player_name', playerName); }
}

function recordWin() {
  savePlayerName();
  if (!playerName) return;
  const entry = leaderboard.find(e => e.name.toLowerCase() === playerName.toLowerCase());
  if (entry) { entry.wins++; } else { leaderboard.push({ name: playerName, wins: 1 }); }
  leaderboard.sort((a, b) => b.wins - a.wins);
  if (leaderboard.length > 100) leaderboard.length = 100;
  localStorage.setItem('chess_leaderboard', JSON.stringify(leaderboard));
}

function renderLeaderboard() {
  const nameInput = document.getElementById('player-name-input');
  if (nameInput && !nameInput.value) nameInput.value = playerName;

  const listEl = document.getElementById('lb-list');
  if (!listEl) return;

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
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
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

// The launch shell intentionally contains only navigation and the two chess
// icons visible before a match. Gameplay, the full piece set, and analysis are
// loaded on demand from app.js.
const SHELL_PIECES = {
  king: `
    <path class="piece-vector-shape" d="M46 7h8v11h11v8H54v11h-8V26H35v-8h11z"/>
    <path class="piece-vector-shape" d="M36 42c0-8 6-13 14-13s14 5 14 13c0 6-3 10-7 14l7 17H36l7-17c-4-4-7-8-7-14z"/>
    <path class="piece-vector-shape" d="M29 73h42l6 12H23z"/>
    <path class="piece-vector-detail" d="M34 73h32M28 85h44"/>
  `,
  pawn: `
    <circle class="piece-vector-shape" cx="50" cy="25" r="14"/>
    <path class="piece-vector-shape" d="M39 39h22c-1 13 3 22 10 31H29c7-9 11-18 10-31z"/>
    <path class="piece-vector-shape" d="M25 69h50l7 16H18z"/>
    <path class="piece-vector-detail" d="M28 70h44"/>
  `,
}

let homeIdleTimer = null
let homeIdleShown = false

export function cancelShellHomeIdlePrompt() {
  clearTimeout(homeIdleTimer)
  homeIdleTimer = null
}

export function renderShellPiece(type, extraClass = '') {
  const artwork = SHELL_PIECES[type] || SHELL_PIECES.pawn
  return `<svg class="chess-piece-svg${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${artwork}</svg>`
}

export function setShellPieceGraphic(element, type, color, label = '') {
  if (!element) return
  const renderKey = `${color}:${type}`
  if (element.dataset.pieceRender !== renderKey) {
    element.innerHTML = renderShellPiece(type)
    element.dataset.pieceRender = renderKey
  }
  element.dataset.pieceType = type
  element.dataset.pieceColor = color
  element.setAttribute('aria-label', label || `${color} ${type}`)
}

export function hydrateShellPieceIcons(root = document) {
  root.querySelectorAll('[data-static-piece]').forEach(element => {
    const type = element.dataset.pieceType || 'pawn'
    const color = element.dataset.pieceColor || 'black'
    element.classList.add(color)
    setShellPieceGraphic(element, type, color, element.getAttribute('aria-label') || '')
  })
}

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'))
  document.getElementById(`screen-${name}`)?.classList.add('active')

  clearTimeout(homeIdleTimer)
  homeIdleTimer = null
  if (name !== 'home') return

  window.agsSetPresence?.('online')
  window.agsRefreshLeaderboard?.()
  if (homeIdleShown) return

  homeIdleTimer = setTimeout(() => {
    homeIdleShown = true
    const prompt = document.getElementById('home-idle-prompt')
    if (!prompt) return
    const inviteUrl = window.agsGetInviteUrl?.()
    if (inviteUrl) {
      const row = document.getElementById('home-idle-share-row')
      if (row && !row.querySelector('.share-row')) window.agsShareRow?.(row, inviteUrl)
    } else {
      const button = document.getElementById('home-idle-signup-btn')
      if (button) button.style.display = ''
    }
    prompt.style.display = 'block'
  }, 30_000)
}

export function setPlayerFromAGS(name) {
  localStorage.setItem('chess_player_name', name)
  const input = document.getElementById('player-name-input')
  if (input) input.value = name
}

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

Object.assign(window, {
  showScreen,
  setPlayerFromAGS,
  renderChessPieceSVG: renderShellPiece,
  setChessPieceGraphic: setShellPieceGraphic,
  escapeHtml,
  cancelShellHomeIdlePrompt,
})

hydrateShellPieceIcons()

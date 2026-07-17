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
let activeScreenName = ''
let screenFocusFrame = 0

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

export function syncScreenState(name, { focus = true } = {}) {
  const target = document.getElementById(`screen-${name}`)
  if (!target) return null

  const changed = activeScreenName !== name
  document.querySelectorAll('.screen').forEach(screen => {
    const selected = screen === target
    screen.classList.toggle('active', selected)
    screen.setAttribute('aria-hidden', String(!selected))
    screen.toggleAttribute('inert', !selected)
  })
  activeScreenName = name
  document.body.dataset.screen = name

  if (changed && focus) {
    const focusBeforeTransition = document.activeElement
    cancelAnimationFrame(screenFocusFrame)
    screenFocusFrame = requestAnimationFrame(() => {
      if (document.activeElement !== focusBeforeTransition && target.contains(document.activeElement)) return
      const heading = target.querySelector('h1, h2')
      const focusTarget = heading || document.getElementById('app-main')
      if (!focusTarget) return
      if (focusTarget === heading && !heading.hasAttribute('tabindex')) {
        heading.tabIndex = -1
        heading.dataset.screenFocusTarget = 'true'
      }
      focusTarget.focus({ preventScroll: true })
    })
  }
  return target
}

export function showScreen(name) {
  syncScreenState(name)

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

function initializeTabKeyboardNavigation() {
  document.addEventListener('keydown', event => {
    const current = event.target.closest?.('[role="tab"]')
    if (!current) return
    const tablist = current.closest('[role="tablist"]')
    if (!tablist) return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return

    const tabs = [...tablist.querySelectorAll('[role="tab"]')]
      .filter(tab => !tab.hidden && !tab.disabled && tab.getAttribute('aria-hidden') !== 'true')
    if (tabs.length < 2) return

    const currentIndex = Math.max(0, tabs.indexOf(current))
    let nextIndex = currentIndex
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
    event.preventDefault()
    tabs[nextIndex].focus()
    tabs[nextIndex].click()
  })
}

function initializeLiveRegions() {
  document.querySelectorAll('.auth-message, .online-chat-notice').forEach(message => {
    if (!message.hasAttribute('aria-live')) message.setAttribute('aria-live', 'polite')
    if (!message.hasAttribute('aria-atomic')) message.setAttribute('aria-atomic', 'true')
  })
}

function initializeModalAccessibility() {
  const modals = [...document.querySelectorAll('.modal, .login-queue-overlay')]
  const triggers = new WeakMap()
  let activeModal = null
  let lastInteractionTarget = null

  const isVisible = element => window.getComputedStyle(element).display !== 'none'
  const focusableElements = modal => [...modal.querySelectorAll(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.hidden && element.getClientRects().length)

  const setBackgroundInert = inert => {
    const main = document.getElementById('app-main')
    const privacyButton = document.getElementById('privacy-center-button')
    if (main) main.inert = inert
    if (privacyButton) privacyButton.inert = inert
  }

  // iOS/WebKit does not consistently focus a button after a pointer tap. Keep
  // the actual interaction target so dialogs can still return focus correctly.
  document.addEventListener('click', event => {
    const target = event.target.closest?.('button, a[href], [role="button"], [data-click]')
    if (target && !target.closest('.modal, .login-queue-overlay')) lastInteractionTarget = target
  }, true)

  const activate = modal => {
    if (activeModal === modal) return
    activeModal = modal
    const focusedElement = document.activeElement
    const trigger = focusedElement &&
      focusedElement !== document.body &&
      !modal.contains(focusedElement)
      ? focusedElement
      : lastInteractionTarget
    if (trigger?.isConnected) triggers.set(modal, trigger)
    modal.setAttribute('aria-hidden', 'false')
    document.body.classList.add('modal-open')
    setBackgroundInert(true)
    requestAnimationFrame(() => {
      if (activeModal !== modal || !isVisible(modal)) return
      const heading = modal.querySelector('h2, h3')
      const focusTarget = modal.querySelector('[autofocus]') || heading || focusableElements(modal)[0]
      if (!focusTarget) return
      if (focusTarget === heading && !heading.hasAttribute('tabindex')) heading.tabIndex = -1
      focusTarget.focus({ preventScroll: true })
    })
  }

  const deactivate = modal => {
    modal.setAttribute('aria-hidden', 'true')
    if (activeModal !== modal) return
    const nextModal = [...modals].reverse().find(candidate => candidate !== modal && isVisible(candidate)) || null
    activeModal = null
    if (nextModal) {
      activate(nextModal)
      return
    }
    document.body.classList.remove('modal-open')
    setBackgroundInert(false)
    const trigger = triggers.get(modal)
    if (!trigger?.isConnected) return

    const restoreFocus = () => trigger.focus({ preventScroll: true })
    restoreFocus()
    requestAnimationFrame(() => {
      if (document.activeElement !== trigger) restoreFocus()
    })
  }

  const sync = modal => {
    if (isVisible(modal)) activate(modal)
    else deactivate(modal)
  }

  modals.forEach(modal => {
    modal.setAttribute('aria-hidden', String(!isVisible(modal)))
    new MutationObserver(() => sync(modal)).observe(modal, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    })
  })

  document.addEventListener('keydown', event => {
    if (!activeModal || !isVisible(activeModal)) return
    if (document.body.classList.contains('legal-reader-open') ||
        document.body.classList.contains('offline-friends-open')) return

    if (event.key === 'Escape') {
      const dismiss = activeModal.querySelector('[data-modal-dismiss]')
      if (!dismiss) return
      event.preventDefault()
      dismiss.click()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = focusableElements(activeModal)
    if (!focusable.length) {
      event.preventDefault()
      activeModal.querySelector('h2, h3')?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || !activeModal.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !activeModal.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  })
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
  agsSyncScreenState: syncScreenState,
  escapeHtml,
  cancelShellHomeIdlePrompt,
})

hydrateShellPieceIcons()
initializeTabKeyboardNavigation()
initializeLiveRegions()
initializeModalAccessibility()
const initialScreen = document.querySelector('.screen.active')?.id.replace(/^screen-/, '') || 'home'
syncScreenState(initialScreen, { focus: false })

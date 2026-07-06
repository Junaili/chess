import { Peer } from 'peerjs'
import { ConfigApi as ChatConfigApi, TopicApi as ChatTopicApi } from '@accelbyte/sdk-chat'
import { loginWithGoogle, loginWithApple, loginWithPassword, requestPasswordReset, resetPassword, registerWithPassword, handleCallback, getProfile, getDisplayName, updateDisplayName, syncBasicProfile, logout, refreshSession, hasStoredSession, clearStoredSession, clearLocalAccountData } from './auth.js'
import { setQueueUIHandler, cancelLoginQueue } from './login-queue.js'
import { sdk } from './ags-client.js'
import { extendFetch } from './extend-client.js'
import { installSessionKeepAlive, scheduleProactiveRefresh, subscribeAccessTokenRefresh } from './session.js'
import { fetchPendingLegalDocuments, fetchAcceptedLegalDocuments, fetchLegalAttachment, acceptLegalDocuments } from './legal.js'
import { parseLegalMarkdown } from './legal-markdown.mjs'
import { initStats, fetchStats, incrementStat, fetchMatchHistory, recordMatchHistory, fetchStreak, updateStreak, migrateStreakFromCloudSave, recordEloResult } from './stats.js'
import { primeUnlockedCache, diffNewlyUnlocked, unlockEventAchievement, clearUnlockedCache, fetchMergedAchievements } from './achievements.js'
import { sendEvent, flushPendingEvents, captureUtm, clearPendingEvents } from './telemetry.js'
import { readPrivacyPreferences, writePrivacyPreferences } from './privacy-preferences.mjs'
import { publishLiveMatch, clearLiveMatch, startWatching, stopWatching } from './spectator.js'
import { fetchTopRankings, fetchUserRank, resolveDisplayNames, enrichDisplayNames, cacheDisplayName, fetchInviterName } from './leaderboard.js'
import { computeMatchStats } from './match-stats.mjs'
import { startMatchmaking, cancelMatchmaking } from './matchmaking.js'
import { fetchFriendState, requestFriend, acceptFriend, rejectFriend, cancelFriendRequest, getFriendshipStatus, addFriendByEmail, storePendingInvite, processIncomingInviteAcceptances } from './friends.js'
import { setPresenceStatus, disconnectPresence, pausePresence, resumePresence, refreshPresenceConnection, signOutPresence, subscribePresenceUpdates, subscribeGameInvites, subscribeLobbyOpen, sendGameInvite, subscribeInviteJoins, sendInviteJoinNotification, subscribeFriendsChanges } from './presence.js'
import { ensureNotificationPermission, notify } from './notifications.js'
import {
  moderateIncomingChat,
  moderateIncomingDisplayName,
  moderateOutgoingChat,
} from './content-moderation.mjs'
import { createAgsChatClient } from './chat.mjs'
import {
  blockPlayer,
  fetchPlayerSafetyReasons,
  getSafetyError,
  listBlockedPlayers,
  reportChatMessage,
  reportPlayer,
  unblockPlayer,
} from './safety.js'
import {
  authorizeAppleDeletionIfRequired,
  fetchDeletionRequirements,
  submitAccountDeletion,
  validateDeletionConfirmation,
} from './account-deletion.js'

window.Peer = Peer
window.chessContentModeration = Object.freeze({
  moderateIncomingChat,
  moderateIncomingDisplayName,
  moderateOutgoingChat,
})
window.agsPublicAppURL = import.meta.env.VITE_PUBLIC_APP_URL || 'https://junaili.github.io/chess/'

const chatClient = createAgsChatClient({
  baseURL: import.meta.env.VITE_ACCELBYTE_BASE_URL ||
    'https://seal-chessags.prod.gamingservices.accelbyte.io',
  namespace: import.meta.env.VITE_ACCELBYTE_NAMESPACE || 'seal-chessags',
  getAccessToken: () => sdk.getToken()?.accessToken || '',
  getUserId: () => currentUserId || '',
  loadHistory: async topicId => {
    const response = await ChatTopicApi(sdk).getChats_ByTopic(topicId, {
      limit: 100,
      order: 'DESC',
    })
    return response.data
  },
})

chatClient.subscribeState(state => window.handleAGSChatState?.(state))
chatClient.subscribeMessages(message => window.handleAGSChatMessage?.(message))
subscribeAccessTokenRefresh(accessToken => {
  chatClient.refreshToken(accessToken).catch(() => {})
})

window.agsPrepareSessionChat = () => chatClient.prepareSessionChat()
window.agsActivateSessionChat = sessionId => chatClient.activateSessionChat(sessionId)
window.agsActivatePersonalChat = otherUserId => chatClient.activatePersonalChat(otherUserId)
window.agsSendChatMessage = message => chatClient.send(message)
window.agsDeactivateChat = () => chatClient.deactivateTopic()
window.agsGetChatState = () => chatClient.snapshot()

async function connectAuthenticatedChat() {
  try {
    const response = await ChatConfigApi(sdk).getConfig_ByNamespace()
    window.agsChatConfig = response.data
  } catch (error) {
    console.warn('[Chat] could not read public configuration:', error?.response?.data || error?.message)
  }
  return chatClient.connect()
}

function getShareableAppURL(params = {}) {
  const native = !!window.Capacitor?.isNativePlatform?.()
  const base = native
    ? window.agsPublicAppURL
    : window.location.origin + window.location.pathname
  const url = new URL(base, window.location.href)
  url.search = ''
  url.hash = ''
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value)
  }
  return url.toString()
}

let currentUserId = null
let currentUserWins = 0
let currentStreak = 0
let currentUserRating = 1200
let pendingOpponentRating = null  // received from the opponent over the peer connection for the in-progress online match
let seenIncomingRequestIds = null  // null until first friends load — avoids notifying for pre-existing requests
let pendingLegalDocuments = []
let pendingLegalProfile = null
let reviewedLegalDocumentIds = new Set()
let acceptedLegalDocuments = []
let activeLegalReaderDocument = null
let legalReaderTrigger = null
let friendsState = { friends: [], incoming: [], outgoing: [] }
let friendsRefreshTimer = null
let unsubscribePresenceUpdates = null
let unsubscribeGameInvites = null
let unsubscribeInviteJoins = null
let unsubscribeLobbyOpen = null
let unsubscribeFriendsChanges = null
// Users we know just used our invite link (via the real-time invite-join
// notification) — their forthcoming friend request auto-accepts the instant
// its requestFriendsNotif arrives, instead of waiting on a poll. TTL-bounded
// so a request that never arrives doesn't leave a stale auto-accept armed.
const expectedInviteFriendIds = new Set()
const EXPECTED_INVITE_TTL_MS = 2 * 60 * 1000
let activeProfileUser = null
let spectatorPrevScreen = null
let profileMatchHistoryRows = []
let blockedPlayers = []
let deletionRequirements = null

async function openExternalURL(url) {
  if (!url) return false
  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      const { Browser } = await import('@capacitor/browser')
      await Browser.open({ url })
      return true
    } catch (error) {
      console.warn('[External link] could not open:', error?.message || error)
      return false
    }
  }
  // A real anchor click, not window.open(): browsers treat anchor-driven
  // navigation as trusted and essentially never block it, whereas
  // window.open() can be silently blocked by popup blockers (and, in some
  // browsers, by merely being reached through a nested async function even
  // with no await before the call) — exactly what surfaced as "the document
  // could not be opened" on the legal-acceptance screen. .click() gives no
  // success/failure signal, so treat firing the navigation as success.
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  return true
}

function policyURL(section) {
  const allowed = new Set(['privacy', 'terms', 'community', 'support'])
  const target = allowed.has(section) ? section : 'privacy'
  return new URL(`legal/#${target}`, window.agsPublicAppURL).href
}

function acceptedDocumentFor(section) {
  const names = {
    privacy: 'privacy policy',
    terms: 'terms of use',
    community: 'community standards',
  }
  return acceptedLegalDocuments.find(document =>
    document.tags?.includes(section) ||
    document.policyName?.toLowerCase() === names[section],
  ) || null
}

function renderAcceptedLegalDocuments(message = '') {
  const list = document.getElementById('ags-accepted-legal-list')
  if (!list) return
  list.textContent = ''

  if (message) {
    const status = document.createElement('p')
    status.className = 'auth-message error'
    status.textContent = message
    list.appendChild(status)
    return
  }
  if (!currentUserId) {
    const status = document.createElement('p')
    status.className = 'auth-message'
    status.textContent = 'Sign in to view your AGS agreement history.'
    list.appendChild(status)
    return
  }
  if (!acceptedLegalDocuments.length) {
    const status = document.createElement('p')
    status.className = 'auth-message'
    status.textContent = 'No accepted AGS legal documents were returned for this account.'
    list.appendChild(status)
    return
  }

  for (const legalDocument of acceptedLegalDocuments) {
    const row = document.createElement('div')
    row.className = 'accepted-legal-row'
    const copy = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = legalDocument.policyName
    const meta = document.createElement('span')
    const acceptedDate = legalDocument.acceptedAt
      ? new Date(legalDocument.acceptedAt).toLocaleDateString()
      : ''
    meta.textContent = [
      legalDocument.policyVersionDisplay ? `Version ${legalDocument.policyVersionDisplay}` : '',
      acceptedDate ? `Accepted ${acceptedDate}` : 'Accepted in AGS',
    ].filter(Boolean).join(' · ')
    copy.append(title, meta)
    row.appendChild(copy)
    if (legalDocument.attachmentLocation) {
      const review = document.createElement('button')
      review.type = 'button'
      review.className = 'btn-mini'
      review.textContent = 'View'
      review.addEventListener('click', () => openExternalURL(legalDocument.attachmentLocation))
      row.appendChild(review)
    }
    list.appendChild(row)
  }
}

async function refreshAcceptedLegalDocuments() {
  if (!currentUserId) {
    acceptedLegalDocuments = []
    renderAcceptedLegalDocuments()
    return
  }
  const accepted = await fetchAcceptedLegalDocuments()
  if (!accepted.ok) {
    acceptedLegalDocuments = []
    renderAcceptedLegalDocuments(accepted.error)
    return
  }
  acceptedLegalDocuments = accepted.documents.filter(document =>
    document.tags?.includes('ethans-chess') ||
    ['privacy policy', 'terms of use', 'community standards']
      .includes(document.policyName?.toLowerCase()),
  )
  renderAcceptedLegalDocuments()
}

async function openPolicyDocument(section) {
  if (section === 'support' || !currentUserId) {
    return openExternalURL(policyURL(section))
  }
  if (!acceptedLegalDocuments.length) await refreshAcceptedLegalDocuments()
  const document = acceptedDocumentFor(section)
  if (!document?.attachmentLocation) {
    renderAcceptedLegalDocuments(
      `Your accepted ${section} document is unavailable from AGS. Try again later.`,
    )
    return false
  }
  return openExternalURL(document.attachmentLocation)
}

function renderPrivacyChoices() {
  const preferences = readPrivacyPreferences()
  const toggle = document.getElementById('privacy-analytics-toggle')
  const status = document.getElementById('privacy-choice-status')
  const banner = document.getElementById('privacy-consent-banner')
  if (toggle) toggle.checked = preferences.analytics
  if (status) {
    status.textContent = preferences.decided
      ? `Optional analytics are ${preferences.analytics ? 'enabled' : 'disabled'}.`
      : 'You have not made a privacy choice yet.'
  }
  if (banner) banner.hidden = preferences.decided
}

async function saveAnalyticsPreference(analytics) {
  writePrivacyPreferences({ analytics })
  if (analytics) {
    captureUtm()
    await flushPendingEvents()
  } else {
    clearPendingEvents()
  }
  renderPrivacyChoices()
}

function initPrivacyCenter() {
  window.agsOpenPolicy = section => openPolicyDocument(section)
  window.agsOpenPrivacyChoices = async () => {
    renderPrivacyChoices()
    renderAcceptedLegalDocuments()
    const modal = document.getElementById('privacy-center-modal')
    if (modal) modal.style.display = 'flex'
    await refreshAcceptedLegalDocuments()
  }
  window.agsClosePrivacyChoices = () => {
    const modal = document.getElementById('privacy-center-modal')
    if (modal) modal.style.display = 'none'
  }
  window.agsSavePrivacyChoices = async () => {
    const enabled = document.getElementById('privacy-analytics-toggle')?.checked === true
    await saveAnalyticsPreference(enabled)
    window.agsClosePrivacyChoices()
  }
  window.agsChooseAnalytics = async enabled => {
    await saveAnalyticsPreference(enabled === true)
  }
  renderPrivacyChoices()
}

function setAuthMessage(kind, text, tone = '') {
  const el = document.getElementById(`ags-${kind}-message`)
  if (!el) return
  el.className = `auth-message${tone ? ' ' + tone : ''}`
  el.textContent = text || ''
}

function clearAuthMessages() {
  setAuthMessage('login', '')
  setAuthMessage('forgot', '')
  setAuthMessage('register', '')
}

function setupPasswordVisibilityToggles() {
  document.querySelectorAll('[data-password-toggle]').forEach(button => {
    if (button.dataset.passwordToggleReady === 'true') return
    const input = document.getElementById(button.getAttribute('aria-controls'))
    if (!input) return

    button.dataset.passwordToggleReady = 'true'
    button.addEventListener('click', () => {
      const showPassword = input.type === 'password'
      input.type = showPassword ? 'text' : 'password'
      button.textContent = showPassword ? 'Hide' : 'Show'
      button.setAttribute('aria-pressed', String(showPassword))
      button.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password')
      input.focus({ preventScroll: true })
      const cursor = input.value.length
      input.setSelectionRange?.(cursor, cursor)
    })
  })
}

// Tell the Extend service who referred this newly-registered user, so the
// inviter's chess-recruiter achievement unlocks server-side. Best-effort.
async function reportReferral() {
  const inviter = sessionStorage.getItem('chess_invite_by')
  if (!inviter || inviter === currentUserId || !sdk.getToken()?.accessToken) return
  try {
    await extendFetch('/referral', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviterUserId: inviter }),
    })
    sendEvent('referral_reported', { inviter_user_id: inviter })
  } catch {}
  sessionStorage.removeItem('chess_invite_by')
}

// Send the new player a welcome email via the Extend service. Best-effort:
// runs after a successful email/password registration and never blocks signup.
async function sendWelcomeEmail(emailAddress, displayName) {
  if (!emailAddress || !sdk.getToken()?.accessToken) return
  try {
    await extendFetch('/welcome/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: emailAddress, display_name: displayName || '' }),
    })
    sendEvent('welcome_email_sent', { method: 'email' })
  } catch {}
}

function addUtm(url, medium, campaign = 'player-invite') {
  try {
    const u = new URL(url)
    u.searchParams.set('utm_source', 'invite')
    u.searchParams.set('utm_medium', medium)
    u.searchParams.set('utm_campaign', campaign)
    return u.toString()
  } catch {
    return url
  }
}

// Only the invite email itself should carry the recipient's address (it's
// already been disclosed to that inbox) — the register screen reads it back
// via ?email= to prefill the field. Links shared through other channels
// (WhatsApp, X, copy, native share) must stay generic so a forwarded link
// doesn't leak the original invitee's email to whoever it's shared with.
function withEmailParam(url, email) {
  if (!email) return url
  try {
    const u = new URL(url)
    u.searchParams.set('email', email)
    return u.toString()
  } catch {
    return url
  }
}

function mountShareRow(containerEl, url, opts = {}) {
  const {
    emailTo = null,
    fromName = null,
    campaign = 'player-invite',
    shareEvent = 'invite_sent',
    sharePayload = {},
    emailSubject = 'Chess challenge!',
  } = opts
  const enc = s => encodeURIComponent(s)
  const linkUrl      = addUtm(url, 'link', campaign)
  const whatsappUrl  = addUtm(url, 'whatsapp', campaign)
  const twitterUrl   = addUtm(url, 'twitter', campaign)
  const emailUrl     = addUtm(withEmailParam(url, emailTo), 'email', campaign)
  const fire = medium => sendEvent(shareEvent, { ...sharePayload, medium })
  // opts.gameText(url) and opts.xText override the default invite wording so
  // achievement shares can say "I just unlocked …" instead.
  const gameTextFor = u => opts.gameText
    ? opts.gameText(u)
    : (fromName ? `${fromName} challenged you to chess! Join here: ${u}` : `Let's play chess! Join my game: ${u}`)
  const xText = opts.xText
    || (fromName ? `${fromName} challenged me to chess 🎯 — think you can beat them?` : 'Think you can beat me? 🎯 Play chess now')

  const row = document.createElement('div')
  row.className = 'share-row'

  const copyBtn = document.createElement('button')
  copyBtn.className = 'share-chip share-chip-copy'
  copyBtn.textContent = '📋 Copy'
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(linkUrl).then(() => {
      copyBtn.textContent = '✅ Copied!'
      fire('link')
      setTimeout(() => { copyBtn.textContent = '📋 Copy' }, 1800)
    }).catch(() => { copyBtn.textContent = '📋 Copy' })
  })
  row.appendChild(copyBtn)

  const wa = document.createElement('a')
  wa.className = 'share-chip share-chip-whatsapp'
  wa.href = `https://api.whatsapp.com/send?text=${enc(gameTextFor(whatsappUrl))}`
  wa.target = '_blank'
  wa.rel = 'noopener'
  wa.textContent = '🟢 WhatsApp'
  wa.addEventListener('click', () => fire('whatsapp'))
  row.appendChild(wa)

  const tw = document.createElement('a')
  tw.className = 'share-chip share-chip-x'
  tw.href = `https://x.com/intent/tweet?text=${enc(xText)}&url=${enc(twitterUrl)}`
  tw.target = '_blank'
  tw.rel = 'noopener'
  tw.textContent = '𝕏 Post'
  tw.addEventListener('click', () => fire('twitter'))
  row.appendChild(tw)

  if (emailTo) {
    const emailBtn = document.createElement('button')
    emailBtn.className = 'share-chip share-chip-email'
    emailBtn.textContent = '✉️ Email'
    emailBtn.addEventListener('click', async () => {
      emailBtn.disabled = true
      emailBtn.textContent = 'Sending…'
      try {
        const res = await extendFetch('/invite/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: emailTo, from_name: fromName || 'A friend', invite_link: emailUrl }),
        })
        if (!res.ok) throw new Error('status ' + res.status)
        fire('email')
        emailBtn.textContent = '✅ Sent!'
        setTimeout(() => { emailBtn.textContent = '✉️ Email'; emailBtn.disabled = false }, 3000)
      } catch {
        emailBtn.textContent = '✉️ Email'
        emailBtn.disabled = false
      }
    })
    row.appendChild(emailBtn)
  } else {
    const emailLink = document.createElement('a')
    emailLink.className = 'share-chip share-chip-email'
    emailLink.href = `mailto:?subject=${enc(emailSubject)}&body=${enc(gameTextFor(emailUrl))}`
    emailLink.textContent = '✉️ Email'
    emailLink.addEventListener('click', () => fire('email'))
    row.appendChild(emailLink)
  }

  if (navigator.share) {
    const nativeBtn = document.createElement('button')
    nativeBtn.className = 'share-chip share-chip-native'
    nativeBtn.textContent = '📤 More…'
    nativeBtn.addEventListener('click', () => {
      const nativeUrl = addUtm(url, 'native', campaign)
      navigator.share({ title: "Ethan's Chess", text: gameTextFor(nativeUrl), url: nativeUrl }).catch(() => {})
      fire('native_share')
    })
    row.appendChild(nativeBtn)
  }

  containerEl.appendChild(row)
  return row
}

function showInviteScreen(inviterName) {
  const titleEl = document.getElementById('invite-landing-title')
  if (titleEl) {
    titleEl.textContent = inviterName
      ? `${inviterName} challenged you to chess!`
      : 'A friend challenged you to chess!'
  }
  if (typeof window.showScreen === 'function') window.showScreen('invite')
}

async function hydrateAuthenticatedUser(profile) {
  currentUserId = profile.userId
  window.agsCurrentUserId = currentUserId
  void refreshAcceptedLegalDocuments()
  connectAuthenticatedChat().catch(error => {
    console.warn('[Chat] connection unavailable:', error?.message || error)
  })
  // Flush any events queued before authentication (invite_link_clicked, etc.)
  // and expose the send function to non-module scripts (app.js).
  await flushPendingEvents()
  window.agsSendEvent = (name, payload) => sendEvent(name, payload)
  const name = getDisplayName(profile)
  cacheDisplayName(currentUserId, name)
  syncBasicProfile(name)
  if (typeof window.setPlayerFromAGS === 'function') {
    window.setPlayerFromAGS(name)
  }
  updateAuthUI(true, name, currentUserId)
  setPresenceStatus('online')
  startPresenceUpdates()
  startGameInviteUpdates()
  startInviteJoinUpdates()
  startFriendsChangeUpdates()
  startFriendsRefresh()
  await refreshFriendsUI()
  try {
    blockedPlayers = await listBlockedPlayers()
  } catch (error) {
    blockedPlayers = []
    console.warn('[AGS safety] blocked-player list unavailable:', getSafetyError(error))
  }

  const urlParams = new URLSearchParams(window.location.search)
  // The invitedBy param is stripped from the URL by the Google OAuth redirect
  // during account creation; it survives only in sessionStorage (captured at
  // landing for the referral achievement). Fall back to it, or the invite→friend
  // link never fires for players who sign up via Google.
  const invitedBy = urlParams.get('invitedBy') || sessionStorage.getItem('chess_invite_by')
  if (invitedBy && invitedBy !== currentUserId) {
    window.history.replaceState({}, '', window.location.pathname + window.location.hash)
    // Once per session per inviter.
    const notifKey = `chess_join_notif_${invitedBy}`
    if (!sessionStorage.getItem(notifKey)) {
      sessionStorage.setItem(notifKey, '1')
      // Fire-and-forget so hydration isn't blocked on the friend network calls.
      void (async () => {
        // Real-time nudge so the inviter's client auto-accepts (link invites).
        sendInviteJoinNotification({ to: invitedBy, fromUserId: currentUserId, fromName: name }).catch(() => {})
        // Auto-connect as friends — accepting the invite is the consent. Accept
        // an existing request from the inviter, otherwise send one (the inviter
        // side auto-accepts via processIncomingInviteAcceptances / the join toast).
        try {
          const state = await fetchFriendState()
          const alreadyFriends = state.ok && state.friends?.some(f => f.userId === invitedBy)
          const incomingFromInviter = state.ok && state.incoming?.some(r => r.userId === invitedBy)
          if (!alreadyFriends) {
            const result = incomingFromInviter ? await acceptFriend(invitedBy) : await requestFriend(invitedBy)
            if (result.ok) {
              setFriendsMessage(
                incomingFromInviter
                  ? 'You are now friends with your inviter!'
                  : 'Friend request sent to your inviter — you\'ll be connected automatically.',
                'success',
              )
            }
            await refreshFriendsUI(false)
          }
        } catch (error) {
          console.warn('[invite] auto-friend failed:', error?.message || error)
        }
      })()
    }
  }

  await initStats(currentUserId)
  await migrateStreakFromCloudSave(currentUserId)  // one-time CloudSave→Statistics backfill (no-op after first run)
  const [stats, streakData] = await Promise.all([fetchStats(currentUserId), fetchStreak(currentUserId)])
  currentUserWins = stats?.wins ?? 0
  currentStreak = streakData?.streak ?? 0
  currentUserRating = stats?.rating ?? 1200
  updateStatsUI(stats, currentStreak)
  primeUnlockedCache(currentUserId)  // silent: seed unlocked-achievement cache so later diffs only surface new ones
  await refreshLeaderboard()
  sendEvent('leaderboard_viewed', { trigger: 'session_start' })
  const randomBtn = document.getElementById('btn-play-random')
  if (randomBtn) randomBtn.style.display = ''
}

function renderLegalDocuments(documents) {
  const listEl = document.getElementById('ags-legal-list')
  if (!listEl) return

  listEl.textContent = ''
  if (!documents.length) {
    listEl.innerHTML = `
      <article class="legal-doc-card">
        <div class="legal-doc-content">
          <div class="legal-doc-heading"><h3>Legal documents unavailable</h3></div>
          <p>We could not load the required agreements for this account. Sign out and try again.</p>
          <span class="legal-doc-status">Unavailable</span>
        </div>
      </article>`
    return
  }

  for (const doc of documents) {
    const meta = [
      doc.policyType || 'Legal document',
      doc.policyVersionDisplay ? `Version ${doc.policyVersionDisplay}` : '',
      doc.localeCode ? doc.localeCode.toUpperCase() : '',
    ].filter(Boolean).join(' · ')

    const card = document.createElement('article')
    card.className = 'legal-doc-card'
    card.dataset.legalDocumentId = doc.localizedPolicyVersionId || ''

    const content = document.createElement('div')
    content.className = 'legal-doc-content'

    const metaEl = document.createElement('div')
    metaEl.className = 'legal-doc-meta'
    metaEl.textContent = meta
    content.appendChild(metaEl)

    const heading = document.createElement('div')
    heading.className = 'legal-doc-heading'
    const title = document.createElement('h3')
    title.textContent = doc.policyName || 'Legal document'
    heading.appendChild(title)
    content.appendChild(heading)

    const description = document.createElement('p')
    description.textContent = doc.description || 'Review and accept this document to continue.'
    content.appendChild(description)

    const status = document.createElement('span')
    status.className = 'legal-doc-status'
    status.textContent = doc.attachmentLocation ? 'Ready to review' : 'Unavailable'
    content.appendChild(status)
    card.appendChild(content)

    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'btn btn-secondary legal-review-button'
    action.textContent = doc.attachmentLocation ? 'Read in app' : 'Document unavailable'
    action.disabled = !doc.attachmentLocation
    if (doc.attachmentLocation) {
      action.addEventListener('click', () => openLegalReader(doc, action))
    }
    card.appendChild(action)

    if (doc.loadError) {
      const error = document.createElement('p')
      error.className = 'legal-doc-error'
      error.textContent = doc.loadError
      card.appendChild(error)
    }

    listEl.appendChild(card)
  }
}

function renderLegalMarkdown(container, source) {
  container.replaceChildren()
  for (const block of parseLegalMarkdown(source)) {
    let element
    if (block.type === 'heading') {
      element = document.createElement(block.level <= 2 ? 'h3' : 'h4')
      element.textContent = block.text
    } else if (block.type === 'ordered-list' || block.type === 'unordered-list') {
      element = document.createElement(block.type === 'ordered-list' ? 'ol' : 'ul')
      for (const item of block.items) {
        const listItem = document.createElement('li')
        listItem.textContent = item
        element.appendChild(listItem)
      }
    } else {
      element = document.createElement('p')
      element.textContent = block.text
    }
    container.appendChild(element)
  }
}

function updateLegalReaderProgress() {
  const scroller = document.getElementById('legal-reader-scroll')
  const progress = document.getElementById('legal-reader-progress-bar')
  const finish = document.getElementById('legal-reader-finish')
  const guidance = document.getElementById('legal-reader-guidance')
  if (!scroller || !progress || !finish || !guidance) return

  const scrollable = Math.max(scroller.scrollHeight - scroller.clientHeight, 0)
  const ratio = scrollable === 0 ? 1 : Math.min(scroller.scrollTop / scrollable, 1)
  const reachedEnd = ratio >= 0.98
  progress.style.width = `${Math.round(ratio * 100)}%`
  finish.disabled = !reachedEnd
  guidance.textContent = reachedEnd
    ? 'You reached the end of this document.'
    : 'Read to the end to finish reviewing.'
}

async function loadLegalReaderDocument() {
  const loading = document.getElementById('legal-reader-loading')
  const content = document.getElementById('legal-reader-content')
  const error = document.getElementById('legal-reader-error')
  const errorMessage = document.getElementById('legal-reader-error-message')
  const finish = document.getElementById('legal-reader-finish')
  const scroller = document.getElementById('legal-reader-scroll')
  if (!activeLegalReaderDocument || !loading || !content || !error || !errorMessage || !finish || !scroller) return

  loading.hidden = false
  content.hidden = true
  error.hidden = true
  finish.disabled = true
  scroller.scrollTop = 0

  const result = await fetchLegalAttachment(activeLegalReaderDocument)
  loading.hidden = true
  if (!result.ok) {
    errorMessage.textContent = result.error
    error.hidden = false
    return
  }

  renderLegalMarkdown(content, result.text)
  content.hidden = false
  requestAnimationFrame(updateLegalReaderProgress)
}

function openLegalReader(documentToReview, trigger = null) {
  const overlay = document.getElementById('legal-reader-overlay')
  const title = document.getElementById('legal-reader-title')
  const meta = document.getElementById('legal-reader-meta')
  const close = document.getElementById('legal-reader-close')
  if (!overlay || !title || !meta || !close) return

  activeLegalReaderDocument = documentToReview
  legalReaderTrigger = trigger || document.activeElement
  title.textContent = documentToReview.policyName || 'Legal document'
  meta.textContent = [
    documentToReview.policyVersionDisplay ? `Version ${documentToReview.policyVersionDisplay}` : '',
    documentToReview.localeCode?.toUpperCase() || '',
  ].filter(Boolean).join(' · ')
  overlay.hidden = false
  document.body.classList.add('legal-reader-open')
  close.focus()
  loadLegalReaderDocument()
}

function closeLegalReader() {
  const overlay = document.getElementById('legal-reader-overlay')
  if (!overlay || overlay.hidden) return
  overlay.hidden = true
  document.body.classList.remove('legal-reader-open')
  activeLegalReaderDocument = null
  const trigger = legalReaderTrigger
  legalReaderTrigger = null
  trigger?.focus?.()
}

function finishLegalReview() {
  const documentId = activeLegalReaderDocument?.localizedPolicyVersionId
  if (!documentId) return
  reviewedLegalDocumentIds.add(documentId)
  const card = document.querySelector(`[data-legal-document-id="${CSS.escape(documentId)}"]`)
  const action = card?.querySelector('.legal-review-button')
  const status = card?.querySelector('.legal-doc-status')
  if (action) {
    action.textContent = 'Reviewed'
    action.classList.add('reviewed')
  }
  card?.classList.add('reviewed')
  if (status) status.textContent = 'Reviewed'
  setLegalMessage('')
  updateLegalAcceptanceState()
  closeLegalReader()
}

function initializeLegalReader() {
  const overlay = document.getElementById('legal-reader-overlay')
  const scroller = document.getElementById('legal-reader-scroll')
  document.getElementById('legal-reader-close')?.addEventListener('click', closeLegalReader)
  document.getElementById('legal-reader-finish')?.addEventListener('click', finishLegalReview)
  document.getElementById('legal-reader-retry')?.addEventListener('click', loadLegalReaderDocument)
  scroller?.addEventListener('scroll', updateLegalReaderProgress, { passive: true })
  overlay?.addEventListener('click', event => {
    if (event.target === overlay) closeLegalReader()
  })
  document.addEventListener('keydown', event => {
    if (overlay?.hidden !== false) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeLegalReader()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...overlay.querySelectorAll('button:not(:disabled), [tabindex="0"]')]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })
}

window.agsOpenLegalDocument = openLegalReader

function updateLegalAcceptanceState() {
  const checkbox = document.getElementById('ags-legal-confirm')
  const acceptBtn = document.getElementById('ags-legal-accept')
  const progressCount = document.getElementById('ags-legal-progress-count')
  const progressBar = document.getElementById('ags-legal-progress-bar')
  const progressTrack = document.getElementById('ags-legal-progress-track')
  const progressLabel = document.getElementById('ags-legal-progress-label')
  const legalSteps = document.querySelectorAll('.legal-steps span')
  const total = pendingLegalDocuments.length
  const reviewed = pendingLegalDocuments.filter(doc =>
    reviewedLegalDocumentIds.has(doc.localizedPolicyVersionId),
  ).length
  const documentsAvailable = pendingLegalDocuments.length > 0 &&
    pendingLegalDocuments.every(doc => !!doc.attachmentLocation)
  const allReviewed = documentsAvailable &&
    pendingLegalDocuments.every(doc => reviewedLegalDocumentIds.has(doc.localizedPolicyVersionId))
  const confirmed = allReviewed && checkbox?.checked === true

  if (progressCount) progressCount.textContent = `${reviewed} of ${total} reviewed`
  if (progressBar) progressBar.style.width = `${total ? (reviewed / total) * 100 : 0}%`
  if (progressTrack) {
    progressTrack.setAttribute('aria-valuemax', String(total))
    progressTrack.setAttribute('aria-valuenow', String(reviewed))
  }
  if (progressLabel) {
    progressLabel.textContent = allReviewed ? 'Documents reviewed' : 'Review your documents'
  }
  legalSteps.forEach((step, index) => {
    step.classList.toggle('active', index === 0 || (index === 1 && allReviewed) || (index === 2 && confirmed))
  })
  if (checkbox) {
    checkbox.disabled = !allReviewed
    if (!allReviewed) checkbox.checked = false
  }
  if (acceptBtn) {
    acceptBtn.disabled = !confirmed
    acceptBtn.textContent = total === 0
      ? 'Documents unavailable'
      : (!allReviewed
      ? `Review ${Math.max(total - reviewed, 0)} document${total - reviewed === 1 ? '' : 's'} to continue`
      : (confirmed ? `Accept ${total} document${total === 1 ? '' : 's'} and continue` : 'Confirm acceptance to continue'))
  }
}

function showLegalGate(documents, profile = null, message = '') {
  pendingLegalDocuments = documents
  pendingLegalProfile = profile
  reviewedLegalDocumentIds = new Set()
  renderLegalDocuments(documents)
  const checkbox = document.getElementById('ags-legal-confirm')
  if (checkbox) {
    checkbox.checked = false
    checkbox.onchange = updateLegalAcceptanceState
  }
  const unavailable = documents.some(doc => !doc.attachmentLocation)
  setLegalMessage(message || (unavailable
    ? 'A required document is unavailable. Try again later or contact support.'
    : 'Open every document before accepting.'))
  updateLegalAcceptanceState()
  if (typeof window.showScreen === 'function') window.showScreen('legal')
}

function setLegalMessage(text, tone = '') {
  const el = document.getElementById('ags-legal-message')
  if (!el) return
  el.className = `auth-message${tone ? ' ' + tone : ''}`
  el.textContent = text || ''
}

async function maybeRequireLegalAcceptance(profile = null, tokenData = null) {
  const pending = await fetchPendingLegalDocuments()
  if (!pending.ok) {
    showLegalGate([], profile, pending.error || 'Could not load the required legal documents.')
    return false
  }

  if (pending.documents.length === 0) return true

  showLegalGate(pending.documents, profile)
  return false
}

async function completeAuthenticatedSession({ profile = null, tokenData = null } = {}) {
  const resolvedProfile = profile || await getProfile()
  const canProceed = await maybeRequireLegalAcceptance(resolvedProfile, tokenData)
  if (!canProceed) return false
  if (!resolvedProfile) return false
  await hydrateAuthenticatedUser(resolvedProfile)
  scheduleProactiveRefresh()  // keep the token fresh for this session
  if (typeof window.showScreen === 'function') window.showScreen('home')
  return true
}

// Renders AGS login-queue state. Shown when IAM is at capacity and a login is
// held in line; the queue module drives this and finishes the sign-in itself
// once we're admitted.
function renderLoginQueue(state) {
  const overlay = document.getElementById('login-queue-overlay')
  if (!overlay) return
  if (!state || state.status !== 'queued') {
    overlay.style.display = 'none'
    return
  }
  overlay.style.display = 'flex'
  const posEl = document.getElementById('login-queue-position')
  const etaEl = document.getElementById('login-queue-eta')
  if (posEl) {
    const pos = Number(state.position)
    posEl.textContent = Number.isFinite(pos) && pos > 0 ? pos.toLocaleString() : "You're next"
  }
  if (etaEl) {
    const secs = Number(state.estimatedWaitingTimeInSeconds)
    if (!Number.isFinite(secs) || secs <= 0) {
      etaEl.textContent = 'Almost there'
    } else if (secs < 60) {
      etaEl.textContent = `~${Math.ceil(secs)} sec`
    } else {
      etaEl.textContent = `~${Math.ceil(secs / 60)} min`
    }
  }
}

async function initAuth() {
  // Install the reactive 401->refresh->retry interceptor + resume hooks before
  // any AGS SDK call, so an expired token is renewed transparently.
  installSessionKeepAlive()
  window.agsRefreshLeaderboard = refreshLeaderboard
  window.cacheDisplayName = cacheDisplayName
  setQueueUIHandler(renderLoginQueue)
  window.agsCancelLoginQueue = cancelLoginQueue
  initPrivacyCenter()
  setupPasswordVisibilityToggles()

  const params = new URLSearchParams(window.location.search)
  // Google direct login (web) returns the id_token in the URL fragment.
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const hasCallback = params.has('code') || params.has('error') ||
    hashParams.has('id_token') ||
    (hashParams.has('error') && (hashParams.get('state') || '').startsWith('ethanschess'))

  const prefilledEmail = params.get('email') || ''

  // Capture UTM/referrer before the Google redirect wipes the URL, then
  // queue an invite_link_clicked event if this is an invite landing.
  captureUtm()
  const inviteByParam = params.get('invitedBy')
  if (inviteByParam) {
    sessionStorage.setItem('chess_invite_by', inviteByParam)
    sessionStorage.setItem('chess_invite_medium', params.get('utm_medium') || 'link')
    sendEvent('invite_link_clicked', {
      inviter_user_id: inviteByParam,
      medium: params.get('utm_medium') || 'link',
    })
  }

  let profile = null
  let tokenData = null
  if (hasCallback) {
    const result = await handleCallback()
    if (result?.response) {
      tokenData = result.response.data || null
      profile = await getProfile()
      if (profile) sendEvent('user_logged_in', { method: 'google' })
    }
  } else if (hasStoredSession()) {
    const refreshed = await refreshSession()
    if (refreshed.ok) {
      profile = await getProfile()
    }
    if (!profile) clearStoredSession()
  }

  if (profile || tokenData) {
    const completed = await completeAuthenticatedSession({ profile, tokenData })
    if (!completed && !document.getElementById('screen-legal')?.classList.contains('active')) {
      stopFriendsRefresh()
      stopPresenceUpdates()
      stopGameInviteUpdates()
      stopInviteJoinUpdates()
    stopFriendsChangeUpdates()
      currentUserId = null
      window.agsCurrentUserId = null
      chatClient.disconnect()
      updateAuthUI(false, null, null)
      updateStatsUI(null)
      refreshLeaderboard()
    }
  } else {
    stopFriendsRefresh()
    stopPresenceUpdates()
    stopGameInviteUpdates()
    stopInviteJoinUpdates()
    stopFriendsChangeUpdates()
    currentUserId = null
    window.agsCurrentUserId = null
    chatClient.disconnect()
    updateAuthUI(false, null, null)
    updateStatsUI(null)
    refreshLeaderboard()
    if (inviteByParam) {
      showInviteScreen(null)
      fetchInviterName(inviteByParam).then(name => {
        if (name) {
          const titleEl = document.getElementById('invite-landing-title')
          if (titleEl) titleEl.textContent = `${name} challenged you to chess!`
        }
      })
    }
  }

  window.agsLogin = loginWithGoogle

  // Sign in with Apple (iOS only — shown by updateAuthUI on native).
  window.agsLoginApple = async () => {
    const appleBtn = document.getElementById('ags-signin-apple')
    if (appleBtn) appleBtn.disabled = true
    const result = await loginWithApple()
    if (appleBtn) appleBtn.disabled = false
    if (!result?.ok) {
      if (result?.error) alert(result.error)
      return
    }
    sendEvent('user_logged_in', { method: 'apple' })
    await completeAuthenticatedSession({ tokenData: result.data || null })
  }

  // Native (iOS) Google login returns via the app's custom URL scheme. Listen
  // for the deep link, close the system browser, and finish the same token
  // exchange + session setup the web callback path uses.
  if (window.Capacitor?.isNativePlatform?.()) {
    const { App } = await import('@capacitor/app')
    const { Browser } = await import('@capacitor/browser')
    App.addListener('appUrlOpen', async ({ url }) => {
      let callback
      try {
        callback = new URL(url)
      } catch {
        return
      }
      if (callback.protocol !== 'io.github.junaili.chess:' || callback.pathname !== '/oauth2redirect') return
      try { await Browser.close() } catch (e) { /* browser may already be closed */ }
      const result = await handleCallback(callback.toString())
      if (result?.response) {
        const td = result.response.data || null
        const prof = await getProfile()
        if (prof) sendEvent('user_logged_in', { method: 'google' })
        await completeAuthenticatedSession({ profile: prof, tokenData: td })
      }
    })
  }

  window.agsLogout = async () => {
    stopFriendsRefresh()
    stopPresenceUpdates()
    stopGameInviteUpdates()
    stopInviteJoinUpdates()
    stopFriendsChangeUpdates()
    seenIncomingRequestIds = null
    currentStreak = 0
    clearUnlockedCache()
    chatClient.disconnect()
    await signOutPresence()
    await logout()
  }
  window.agsOpenLogin = () => {
    clearAuthMessages()
    if (typeof window.showScreen === 'function') window.showScreen('login')
  }
  window.agsOpenForgotPassword = () => {
    clearAuthMessages()
    const loginIdentifier = document.getElementById('ags-login-identifier')?.value.trim() || ''
    const emailField = document.getElementById('ags-forgot-email')
    const resetFields = document.getElementById('ags-reset-fields')
    if (emailField && loginIdentifier.includes('@')) emailField.value = loginIdentifier
    if (resetFields) resetFields.hidden = true
    if (typeof window.showScreen === 'function') window.showScreen('forgot-password')
    window.requestAnimationFrame(() => emailField?.focus())
  }
  window.agsOpenRegister = () => {
    clearAuthMessages()
    if (typeof window.showScreen === 'function') window.showScreen('register')
    if (prefilledEmail) {
      const emailField = document.getElementById('ags-register-email')
      if (emailField && !emailField.value) emailField.value = prefilledEmail
    }
  }
  window.agsOpenGuestPlay = () => {
    const trigger = document.getElementById('ags-open-guest')
    const options = document.getElementById('ags-guest-options')
    const nameInput = document.getElementById('player-name-input')
    if (!options) return

    options.hidden = false
    if (trigger) {
      trigger.style.display = 'none'
      trigger.setAttribute('aria-expanded', 'true')
    }
    window.requestAnimationFrame(() => nameInput?.focus())
  }
  window.agsPasswordLogin = async () => {
    const identifier = document.getElementById('ags-login-identifier')?.value.trim() || ''
    const passwordInput = document.getElementById('ags-login-password')
    const password = passwordInput?.value || ''
    const button = document.getElementById('ags-login-submit')
    if (!identifier || !password) {
      setAuthMessage('login', 'Enter your username or email and password.', 'error')
      return
    }
    if (button) button.disabled = true
    setAuthMessage('login', 'Signing in…')
    if (passwordInput) passwordInput.value = ''
    const result = await loginWithPassword(identifier, password)
    if (button) button.disabled = false
    if (!result.ok) {
      setAuthMessage('login', result.error, 'error')
      return
    }
    clearAuthMessages()
    sendEvent('user_logged_in', { method: 'email' })
    const completed = await completeAuthenticatedSession({ tokenData: result.data || null })
    if (!completed) {
      if (document.getElementById('screen-legal')?.classList.contains('active')) return
      setAuthMessage('login', 'Signed in, but failed to load profile.', 'error')
      return
    }
  }
  window.agsRequestPasswordReset = async () => {
    const emailInput = document.getElementById('ags-forgot-email')
    const emailAddress = emailInput?.value.trim() || ''
    const button = document.getElementById('ags-forgot-submit')
    if (!emailAddress || emailInput?.validity.valid === false) {
      setAuthMessage('forgot', 'Enter the email address for your account.', 'error')
      emailInput?.focus()
      return
    }
    if (button) button.disabled = true
    setAuthMessage('forgot', 'Sending reset code…')
    const result = await requestPasswordReset(emailAddress)
    if (button) button.disabled = false
    if (!result.ok) {
      setAuthMessage('forgot', result.error, 'error')
      return
    }
    const resetFields = document.getElementById('ags-reset-fields')
    if (resetFields) resetFields.hidden = false
    setAuthMessage('forgot', 'Reset code sent. Check your email.', 'success')
    document.getElementById('ags-reset-code')?.focus()
  }
  window.agsCompletePasswordReset = async () => {
    const emailAddress = document.getElementById('ags-forgot-email')?.value.trim() || ''
    const codeInput = document.getElementById('ags-reset-code')
    const passwordInput = document.getElementById('ags-reset-password')
    const code = codeInput?.value.trim() || ''
    const newPassword = passwordInput?.value || ''
    const button = document.getElementById('ags-reset-submit')
    if (!emailAddress || !code || newPassword.length < 8) {
      setAuthMessage('forgot', 'Enter the verification code and a new password of at least 8 characters.', 'error')
      return
    }
    if (button) button.disabled = true
    setAuthMessage('forgot', 'Updating password…')
    const result = await resetPassword({ emailAddress, code, newPassword })
    if (button) button.disabled = false
    if (!result.ok) {
      setAuthMessage('forgot', result.error, 'error')
      return
    }
    if (passwordInput) passwordInput.value = ''
    const loginIdentifier = document.getElementById('ags-login-identifier')
    if (loginIdentifier) loginIdentifier.value = emailAddress
    setAuthMessage('forgot', 'Password updated. You can now sign in.', 'success')
    window.setTimeout(() => {
      if (typeof window.showScreen === 'function') window.showScreen('login')
      setAuthMessage('login', 'Password updated. Sign in with your new password.', 'success')
      document.getElementById('ags-login-password')?.focus()
    }, 900)
  }
  window.agsRegister = async () => {
    const emailAddress = document.getElementById('ags-register-email')?.value.trim() || ''
    const displayName = document.getElementById('ags-register-display-name')?.value.trim() || ''
    const passwordInput = document.getElementById('ags-register-password')
    const password = passwordInput?.value || ''
    const reachMinimumAge = document.getElementById('ags-register-minimum-age')?.checked === true
    const button = document.getElementById('ags-register-submit')
    if (!emailAddress || !displayName || !password || !reachMinimumAge) {
      setAuthMessage('register', 'Enter your details and confirm the minimum age requirement.', 'error')
      return
    }
    if (button) button.disabled = true
    setAuthMessage('register', 'Creating account…')
    if (passwordInput) passwordInput.value = ''
    const created = await registerWithPassword({ emailAddress, displayName, password, reachMinimumAge })
    if (!created.ok) {
      if (button) button.disabled = false
      setAuthMessage('register', created.error, 'error')
      return
    }
    const loggedIn = await loginWithPassword(emailAddress, password)
    if (button) button.disabled = false
    if (!loggedIn.ok) {
      setAuthMessage('register', 'Account created. Sign in with your new credentials.', 'success')
      if (typeof window.showScreen === 'function') window.showScreen('login')
      return
    }
    sendEvent('user_registered', {
      method: 'email',
      invited_by: sessionStorage.getItem('chess_invite_by') || undefined,
      invite_medium: sessionStorage.getItem('chess_invite_medium') || undefined,
    })
    void sendWelcomeEmail(emailAddress, displayName)  // best-effort, non-blocking
    clearAuthMessages()
    const completed = await completeAuthenticatedSession({ tokenData: loggedIn.data || null })
    if (!completed) {
      if (document.getElementById('screen-legal')?.classList.contains('active')) return
      setAuthMessage('register', 'Account created, but failed to load profile.', 'error')
      return
    }
    reportReferral()  // unlock the inviter's recruiter achievement (best-effort)
  }
  window.agsAcceptLegal = async () => {
    const checkbox = document.getElementById('ags-legal-confirm')
    const acceptBtn = document.getElementById('ags-legal-accept')
    const allReviewed = pendingLegalDocuments.length > 0 &&
      pendingLegalDocuments.every(doc =>
        !!doc.attachmentLocation && reviewedLegalDocumentIds.has(doc.localizedPolicyVersionId),
      )
    if (!allReviewed) {
      setLegalMessage('Open and review every required document before continuing.', 'error')
      updateLegalAcceptanceState()
      return
    }
    if (!checkbox?.checked) {
      setLegalMessage('Confirm that you accept the required documents before continuing.', 'error')
      return
    }

    if (acceptBtn) {
      acceptBtn.disabled = true
      acceptBtn.setAttribute('aria-busy', 'true')
      acceptBtn.textContent = 'Accepting securely…'
    }
    setLegalMessage('Accepting documents…')

    const accepted = await acceptLegalDocuments(pendingLegalDocuments)
    if (!accepted.ok) {
      if (acceptBtn) acceptBtn.removeAttribute('aria-busy')
      updateLegalAcceptanceState()
      setLegalMessage(accepted.error, 'error')
      return
    }

    if (!accepted.comply) {
      if (acceptBtn) acceptBtn.removeAttribute('aria-busy')
      updateLegalAcceptanceState()
      setLegalMessage('Your account is still missing required agreements. Please try again.', 'error')
      return
    }

    const verification = await fetchPendingLegalDocuments()
    if (!verification.ok) {
      if (acceptBtn) acceptBtn.removeAttribute('aria-busy')
      updateLegalAcceptanceState()
      setLegalMessage(
        `${verification.error || 'Could not verify acceptance.'} Your account remains at the legal gate.`,
        'error',
      )
      return
    }
    if (verification.documents.length > 0) {
      showLegalGate(
        verification.documents,
        pendingLegalProfile,
        'AGS still shows required agreements. Review the current versions and try again.',
      )
      return
    }

    const refreshed = await refreshSession()
    if (!refreshed.ok) {
      console.warn('[AGS] refreshSession after legal accept:', refreshed.error)
    }

    const profile = pendingLegalProfile || await getProfile()
    if (!profile) {
      if (acceptBtn) acceptBtn.removeAttribute('aria-busy')
      updateLegalAcceptanceState()
      setLegalMessage('Accepted, but failed to restore your session. Please sign in again.', 'error')
      return
    }

    pendingLegalDocuments = []
    pendingLegalProfile = null
    await refreshAcceptedLegalDocuments()
    setLegalMessage('')
    await hydrateAuthenticatedUser(profile)
    if (typeof window.showScreen === 'function') window.showScreen('home')
  }
  window.agsDeclineLegal = async () => {
    stopFriendsRefresh()
    stopPresenceUpdates()
    stopGameInviteUpdates()
    stopInviteJoinUpdates()
    stopFriendsChangeUpdates()
    chatClient.disconnect()
    await signOutPresence()
    await logout()
  }
  window.agsStartMatchmaking = startMatchmaking
  window.agsCancelMatchmaking = cancelMatchmaking
  window.agsRefreshFriends = refreshFriendsUI
  window.agsInviteFriend = friendId => {
    ensureNotificationPermission()  // user gesture — ask now so they can be notified of the reply
    const friend = friendsState.friends.find(item => item.userId === friendId)
    if (!friend) {
      setFriendsMessage('Friend is not available.', 'error')
      return
    }
    if (typeof window.startFriendMatchInvite !== 'function') {
      setFriendsMessage('Match invites are not ready yet.', 'error')
      return
    }
    window.startFriendMatchInvite(friend)
  }
  window.agsSendMatchInvite = async (friendId, invite) => {
    if (!currentUserId) return { ok: false, error: 'Sign in before sending a match invite.' }
    const fromName = document.getElementById('ags-signedin-name')?.textContent || 'Friend'
    return sendGameInvite({
      from: currentUserId,
      to: friendId,
      payload: {
        ...invite,
        type: 'chess-match-invite',
        fromUserId: currentUserId,
        fromName,
      },
    })
  }
  window.agsSendMatchDecline = async (toUserId, inviteId) => {
    if (!currentUserId || !toUserId) return
    return sendGameInvite({
      from: currentUserId,
      to: toUserId,
      payload: {
        type: 'chess-match-declined',
        inviteId,
        fromUserId: currentUserId,
      },
    })
  }
  window.agsSetPresence = status => {
    setPresenceStatus(status)
    if (status === 'online') refreshFriendsUI(false)
  }
  window.agsAcceptFriend = async friendId => {
    await runFriendAction(() => acceptFriend(friendId), 'Friend request accepted.')
    sendEvent('friend_request_accepted', {})
    unlockEventAchievement(currentUserId, 'chess-first-friend')  // first accepted friend (repeats are 409 no-ops)
  }
  window.agsRejectFriend = async friendId => {
    await runFriendAction(() => rejectFriend(friendId), 'Friend request rejected.')
  }
  window.agsCancelFriendRequest = async friendId => {
    await runFriendAction(() => cancelFriendRequest(friendId), 'Friend request canceled.')
  }
  window.agsRequestFriend = async friendId => {
    ensureNotificationPermission()  // user gesture — ask now so they can be notified when accepted
    await runFriendAction(() => requestFriend(friendId), 'Friend request sent.')
    sendEvent('friend_request_sent', { source: 'manual' })
  }
  window.agsOpenProfile = openPublicProfile
  window.agsProfileAddFriend = async () => {
    if (!activeProfileUser?.userId) return
    await requestProfileFriend(activeProfileUser)
  }
  window.agsAddFriendByEmail = async () => {
    const emailInput = document.getElementById('ags-add-friend-email')
    const email = emailInput?.value.trim() || ''
    if (!emailInput?.reportValidity()) return
    setAddFriendBusy(true)
    renderAddFriendFeedback('loading', 'Searching for player', 'Checking for an account with this email...')

    const result = await addFriendByEmail(email, currentUserId, friendsState)
    setAddFriendBusy(false)

    if (!result.ok) {
      renderAddFriendFeedback('error', addFriendErrorTitle(result.reason), result.error)
      return
    }

    if (result.found) {
      const name = result.displayName || 'This player'
      if (result.relationship === 'friends') {
        renderAddFriendFeedback('success', 'Already friends', `${name} is already in your Friends list.`)
        return
      }
      if (result.relationship === 'incoming') {
        renderAddFriendFeedback(
          'warning',
          'They already invited you',
          `${name} sent you a friend request. Accept it to become friends.`,
          { label: `Accept ${name}`, onClick: () => acceptAddFriendResult(result.userId, name) }
        )
        return
      }
      if (result.relationship === 'outgoing' && result.existingRelationship) {
        renderAddFriendFeedback(
          'warning',
          'Request already pending',
          `${name} has not accepted your friend request yet.`
        )
        return
      }
      if (emailInput) emailInput.value = ''
      renderAddFriendFeedback(
        'success',
        'Friend request sent',
        `${name} will appear in your Friends list after they accept.`
      )
      sendEvent('friend_request_sent', { source: 'email_lookup' })
      await refreshFriendsUI(false)
      return
    }

    // User not found — store pending invite and show share options
    storePendingInvite(email, currentUserId)
    const inviteUrl = addUtm(getShareableAppURL({ invitedBy: currentUserId }), 'email')
    const content = renderAddFriendFeedback(
      'warning',
      'No player found',
      `There is no account for ${email}. Invite them to create one instead.`
    )
    if (content) {
      const linkBox = document.createElement('div')
      linkBox.className = 'invite-link-box'
      const linkText = document.createElement('span')
      linkText.className = 'invite-link-text'
      linkText.textContent = inviteUrl
      linkBox.append(linkText)
      content.append(linkBox)
      const fromName = document.getElementById('ags-signedin-name')?.textContent || 'A friend'
      mountShareRow(content, inviteUrl, { emailTo: email, fromName })
    }
  }
  window.agsToggleAddFriend = () => {
    const form = document.getElementById('ags-add-friend-form')
    const btn = document.getElementById('btn-add-friend-expand')
    if (!form) return
    const opening = form.style.display === 'none'
    form.style.display = opening ? '' : 'none'
    if (btn) btn.textContent = opening ? '✕ Cancel' : '+ Add Friend'
    if (opening) {
      const input = document.getElementById('ags-add-friend-email')
      const result = document.getElementById('ags-add-friend-result')
      if (input) { input.value = ''; input.focus() }
      if (result) result.replaceChildren()
      setAddFriendBusy(false)
    }
  }
  window.agsShareRow = mountShareRow
  window.agsGetInviteUrl = () =>
    currentUserId
      ? getShareableAppURL({ invitedBy: currentUserId })
      : null
  window.agsCopyInviteLink = () => {
    const link = getShareableAppURL(currentUserId ? { invitedBy: currentUserId } : {})
    const container = document.getElementById('ags-invite-share-row')
    if (navigator.share) {
      const fromName = document.getElementById('ags-signedin-name')?.textContent || undefined
      const nativeLink = addUtm(link, 'native')
      navigator.share({
        title: "Ethan's Chess",
        text: fromName ? `${fromName} challenged you to chess! Join here: ${nativeLink}` : `Let's play chess! Join my game: ${nativeLink}`,
        url: nativeLink,
      }).catch(() => {})
      sendEvent('invite_sent', { medium: 'native_share' })
      return
    }
    if (!container) return
    if (container.querySelector('.share-row')) {
      container.innerHTML = ''
      return
    }
    mountShareRow(container, link)
  }
  window.agsRequestLastOpponent = async () => {
    const opponent = window.agsLastOpponent
    if (!opponent?.userId) return
    if (blockedPlayers.some(item => item.userId === opponent.userId)) return
    await runFriendAction(() => requestFriend(opponent.userId), 'Friend request sent.')
    await updatePostMatchFriendAction(opponent)
  }
  window.agsGetSafetyReasons = async () => {
    try {
      return { ok: true, reasons: await fetchPlayerSafetyReasons() }
    } catch (error) {
      return { ok: false, error: getSafetyError(error, 'Could not load report reasons.') }
    }
  }
  window.agsReportChatMessage = async input => {
    try {
      return { ok: true, data: await reportChatMessage(input) }
    } catch (error) {
      return { ok: false, error: getSafetyError(error, 'Could not report this message.') }
    }
  }
  window.agsReportPlayer = async input => {
    try {
      return { ok: true, data: await reportPlayer(input) }
    } catch (error) {
      return { ok: false, error: getSafetyError(error, 'Could not report this player.') }
    }
  }
  window.agsBlockPlayer = async userId => {
    try {
      await blockPlayer(userId)
      if (!blockedPlayers.some(item => item.userId === userId)) {
        blockedPlayers.push({ userId, blockedAt: new Date().toISOString() })
      }
      window.handleAGSPlayerBlocked?.(userId)
      await refreshFriendsUI(false)
      renderBlockedPlayers()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: getSafetyError(error, 'Could not block this player.') }
    }
  }
  window.agsUnblockPlayer = async userId => {
    try {
      await unblockPlayer(userId)
      blockedPlayers = blockedPlayers.filter(item => item.userId !== userId)
      renderBlockedPlayers()
      const lobbyRefreshed = await refreshPresenceConnection()
      return { ok: true, lobbyRefreshed }
    } catch (error) {
      return { ok: false, error: getSafetyError(error, 'Could not unblock this player.') }
    }
  }
  window.agsIsBlockedPlayer = userId => blockedPlayers.some(item => item.userId === userId)
  window.agsOpenDeleteAccount = openDeleteAccountModal
  window.agsUpdateDeleteConfirmation = updateDeleteAccountConfirmation
  window.agsConfirmDeleteAccount = confirmAccountDeletion
  window.agsCloseDeleteAccount = () => {
    const modal = document.getElementById('delete-account-modal')
    if (modal) modal.style.display = 'none'
    deletionRequirements = null
    setAccountDeletionMessage('')
  }
  window.agsGetStats = (userId) => fetchStats(userId)
  window.agsGetToken = () => sdk.getToken()?.accessToken ?? null
  // Elo-style rating exchange: app.js reads this to embed in the game_start /
  // player_info peer messages, and calls agsSetOpponentRating with whatever
  // the other side sent back — that's the only way each client learns the
  // other's current rating (a plain player-to-player client can't read
  // another user's stats directly).
  window.agsGetRating = () => currentUserRating
  window.agsSetOpponentRating = (rating) => {
    pendingOpponentRating = typeof rating === 'number' && Number.isFinite(rating) ? rating : null
  }
  window.agsRecordEloResult = async (score) => {
    if (!currentUserId || pendingOpponentRating == null) return
    const newRating = await recordEloResult(currentUserId, currentUserRating, pendingOpponentRating, score)
    if (newRating != null) {
      currentUserRating = newRating
      updateStatsUI(await fetchStats(currentUserId), currentStreak)
    }
    pendingOpponentRating = null
  }
  window.agsIncrementWin = async () => {
    if (!currentUserId) return
    const displayName = document.getElementById('ags-signedin-name')?.textContent || ''
    await incrementStat(currentUserId, 'chess-wins', displayName || null)
    currentUserWins++
    updateStatsUI(await fetchStats(currentUserId))
    await refreshLeaderboard()
  }
  window.agsIncrementLoss = async () => {
    if (!currentUserId) return
    await incrementStat(currentUserId, 'chess-losses')
    updateStatsUI(await fetchStats(currentUserId))
  }
  window.agsIncrementDraw = async () => {
    if (!currentUserId) return
    await incrementStat(currentUserId, 'chess-draws')
    updateStatsUI(await fetchStats(currentUserId))
  }
  window.agsIncrementGamePlayed = async (mode) => {
    if (!currentUserId) return
    await incrementStat(currentUserId, 'chess-games-played')
    if (mode === 'online') await incrementStat(currentUserId, 'chess-online-games')
  }
  window.agsUpdateStreak = async () => {
    if (!currentUserId) return
    const result = await updateStreak(currentUserId)
    if (result?.streak) {
      currentStreak = result.streak
      updateStatsUI(await fetchStats(currentUserId), currentStreak)
    }
  }
  // After a game: detect newly-unlocked achievements and celebrate them —
  // toast + OS notification + telemetry. Fire-and-forget from the game-end hook.
  window.agsCheckAchievements = async () => {
    if (!currentUserId) return []
    const fresh = await diffNewlyUnlocked(currentUserId)
    if (!fresh.length) return fresh
    const merged = await fetchMergedAchievements(currentUserId)
    const items = merged.filter(a => fresh.includes(a.code))
    showAchievementToast(items)
    for (const it of items) {
      notify(`🏆 Achievement unlocked: ${it.name}`, { body: it.description, tag: 'achievement-' + it.code })
      sendEvent('achievement_unlocked', { code: it.code })
    }
    const modal = document.getElementById('achievements-modal')
    if (modal && modal.style.display === 'flex') renderAchievementPanel(merged)
    return fresh
  }
  window.agsOpenAchievements = async () => {
    const modal = document.getElementById('achievements-modal')
    if (!modal) return
    modal.style.display = 'flex'
    const grid = document.getElementById('achievements-grid')
    if (grid) grid.innerHTML = '<p class="achievements-loading">Loading achievements…</p>'
    const merged = await fetchMergedAchievements(currentUserId)
    renderAchievementPanel(merged)
    sendEvent('achievement_panel_viewed', {})
  }
  window.agsCloseAchievements = () => {
    const modal = document.getElementById('achievements-modal')
    if (modal) modal.style.display = 'none'
  }
  window.agsRecordMatchHistory = async match => {
    if (!currentUserId) return
    await recordMatchHistory({ ...match, playerUserId: currentUserId })
  }

  window.agsPublishLiveMove = async () => {
    if (!currentUserId) return
    const data = window.getSpectatorMatchData?.()
    if (!data) return
    await publishLiveMatch(currentUserId, data)
  }
  window.agsClearLiveMatch = async () => {
    if (!currentUserId) return
    // Publish the final state with active=false but preserve all moves so watchers can replay.
    // clearLiveMatch() would wipe moves, causing the watcher's replay guard to fail.
    const data = window.getSpectatorMatchData?.()
    if (data) {
      await publishLiveMatch(currentUserId, { ...data, active: false })
    } else {
      await publishLiveMatch(currentUserId, { active: false, moves: [] })
    }
  }
  window.agsWatchFriend = (friendUserId, friendName) => {
    spectatorReplayIndex = -1
    spectatorLastMatchData = null
    // Save the current screen so Stop Watching returns to it, not unconditionally to home.
    spectatorPrevScreen = document.querySelector('.screen.active')?.id?.replace('screen-', '') || 'home'
    const statusEl = document.getElementById('spectator-status')
    const whiteEl = document.getElementById('spectator-white-name')
    const blackEl = document.getElementById('spectator-black-name')
    if (statusEl) statusEl.textContent = `Connecting to ${friendName || 'match'}…`
    if (whiteEl) whiteEl.textContent = 'White'
    if (blackEl) blackEl.textContent = 'Black'
    const boardEl = document.getElementById('spectator-board')
    if (boardEl) boardEl.innerHTML = ''
    setSpectatorReplayControls(false)
    switchToSpectatorScreen('spectator')
    startWatching(friendUserId, matchData => {
      spectatorLastMatchData = matchData
      if (!matchData.active && (matchData.moves || []).length > 0) {
        stopWatching()
        spectatorReplayIndex = (matchData.moves || []).length - 1
        renderSpectatorBoard(matchData, spectatorReplayIndex)
        setSpectatorReplayControls(true)
      } else {
        renderSpectatorBoard(matchData)
      }
    })
  }
  window.agsStopWatching = () => {
    stopWatching()
    spectatorReplayIndex = -1
    spectatorLastMatchData = null
    setSpectatorReplayControls(false)
    const target = spectatorPrevScreen || 'home'
    spectatorPrevScreen = null
    // Restore the previous screen directly — do NOT call window.showScreen() because that
    // is app.js's game navigation and has side effects (presence reset, peer teardown triggers).
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
    const el = document.getElementById('screen-' + target)
    if (el) {
      el.classList.add('active')
    } else if (typeof window.showScreen === 'function') {
      window.showScreen('home')
    }
  }
  window.agsSpectatorFirst = () => replayAt(0)
  window.agsSpectatorPrev  = () => replayAt(spectatorReplayIndex - 1)
  window.agsSpectatorNext  = () => replayAt(spectatorReplayIndex + 1)
  window.agsSpectatorLast  = () => replayAt((spectatorLastMatchData?.moves || []).length - 1)

  window.agsProfileEditName = () => {
    const nameEl = document.getElementById('profile-display-name')
    const form = document.getElementById('profile-name-edit-form')
    const input = document.getElementById('profile-name-edit-input')
    const message = document.getElementById('profile-name-edit-message')
    if (!form || !input) return
    if (message) message.textContent = ''
    input.value = nameEl?.textContent || ''
    form.style.display = ''
    input.focus()
    input.select()
  }
  window.agsProfileCancelEdit = () => {
    const form = document.getElementById('profile-name-edit-form')
    if (form) form.style.display = 'none'
    const message = document.getElementById('profile-name-edit-message')
    if (message) message.textContent = ''
  }
  window.agsProfileSaveName = async () => {
    const input = document.getElementById('profile-name-edit-input')
    const saveBtn = document.getElementById('profile-btn-save-name')
    const nameEl = document.getElementById('profile-display-name')
    const form = document.getElementById('profile-name-edit-form')
    const message = document.getElementById('profile-name-edit-message')
    if (!input) return
    const newName = input.value.trim()
    if (!newName) {
      if (message) {
        message.className = 'auth-message error'
        message.textContent = 'Enter a display name.'
      }
      return
    }
    if (message) message.textContent = ''
    if (saveBtn) saveBtn.disabled = true
    const updated = await updateDisplayName(newName)
    if (saveBtn) saveBtn.disabled = false
    if (!updated.ok) {
      if (message) {
        message.className = 'auth-message error'
        message.textContent = updated.error
      }
      return
    }
    if (updated.data) {
      const name = getDisplayName(updated.data)
      cacheDisplayName(currentUserId, name)
      if (nameEl) nameEl.textContent = name
      const homeNameEl = document.getElementById('ags-signedin-name')
      if (homeNameEl) homeNameEl.textContent = name
      if (typeof window.setPlayerFromAGS === 'function') window.setPlayerFromAGS(name)
      syncBasicProfile(name)
      if (form) form.style.display = 'none'
    }
  }
  window.agsEditName = () => {
    const nameEl = document.getElementById('ags-signedin-name')
    const form = document.getElementById('name-edit-form')
    const input = document.getElementById('name-edit-input')
    const message = document.getElementById('name-edit-message')
    if (!form || !input) return
    if (message) message.textContent = ''
    input.value = nameEl?.textContent || ''
    form.style.display = ''
    input.focus()
    input.select()
  }

  window.agsCancelEdit = () => {
    const form = document.getElementById('name-edit-form')
    if (form) form.style.display = 'none'
    const message = document.getElementById('name-edit-message')
    if (message) message.textContent = ''
  }

  window.agsSaveName = async () => {
    const input = document.getElementById('name-edit-input')
    const saveBtn = document.getElementById('btn-save-name')
    const form = document.getElementById('name-edit-form')
    const message = document.getElementById('name-edit-message')
    if (!input) return
    const newName = input.value.trim()
    if (!newName) {
      if (message) {
        message.className = 'auth-message error'
        message.textContent = 'Enter a display name.'
      }
      return
    }
    if (message) message.textContent = ''
    if (saveBtn) saveBtn.disabled = true
    const updated = await updateDisplayName(newName)
    if (saveBtn) saveBtn.disabled = false
    if (!updated.ok) {
      if (message) {
        message.className = 'auth-message error'
        message.textContent = updated.error
      }
      return
    }
    if (updated.data) {
      const name = getDisplayName(updated.data)
      cacheDisplayName(currentUserId, name)
      document.getElementById('ags-signedin-name').textContent = name
      if (typeof window.setPlayerFromAGS === 'function') window.setPlayerFromAGS(name)
      if (form) form.style.display = 'none'
    }
  }
}

async function refreshLeaderboard() {
  const needsRank = currentUserId && currentUserWins > 0
  const [rankings, userRankData] = await Promise.all([
    fetchTopRankings(10),
    needsRank ? fetchUserRank(currentUserId) : Promise.resolve(null),
  ])
  if (rankings === null) return  // hard failure — keep local leaderboard visible
  try { await enrichDisplayNames(rankings) } catch (e) { console.warn('[lb] enrichDisplayNames:', e) }
  const nameMap = resolveDisplayNames(rankings)
  renderAGSLeaderboard(rankings, nameMap, userRankData)
}

function renderAGSLeaderboard(rankings, nameMap, userRankData) {
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
  const listEl = document.getElementById('lb-list')
  const resetBtn = document.querySelector('.btn-lb-reset')
  if (!listEl) return

  if (resetBtn) resetBtn.style.display = 'none'

  if (rankings.length === 0) {
    listEl.innerHTML = '<p class="lb-empty">No entries yet — win a game!</p>'
    return
  }

  const inTop = rankings.some(r => r.userId === currentUserId)

  listEl.innerHTML = rankings.map((entry, i) => {
    const isYou = entry.userId === currentUserId
    const name = isYou
      ? (document.getElementById('ags-signedin-name')?.textContent || nameMap[entry.userId] || 'You')
      : (nameMap[entry.userId] || entry.userId.slice(0, 8))
    const safeName = esc(name)
    return `<div class="lb-entry${isYou ? ' lb-you' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <button class="lb-name lb-name-button" data-profile-user-id="${esc(entry.userId)}" data-profile-name="${safeName}">${safeName}${isYou ? ' (you)' : ''}</button>
      <span class="lb-wins">${entry.point}</span>
    </div>`
  }).join('')

  if (!inTop && userRankData) {
    const myName = document.getElementById('ags-signedin-name')?.textContent || 'You'
    const safeMyName = esc(myName)
    listEl.innerHTML += `<div class="lb-entry lb-you lb-me-sep">
      <span class="lb-rank">#${userRankData.rank}</span>
      <button class="lb-name lb-name-button" data-profile-user-id="${esc(currentUserId)}" data-profile-name="${safeMyName}">${safeMyName} (you)</button>
      <span class="lb-wins">${userRankData.point}</span>
    </div>`
  }
  bindLeaderboardProfileButtons(listEl)
}

function bindLeaderboardProfileButtons(listEl) {
  listEl.querySelectorAll('[data-profile-user-id]').forEach(button => {
    button.addEventListener('click', () => {
      openPublicProfile(button.dataset.profileUserId, button.dataset.profileName || '')
    })
  })
}

function showProfileTab(name = 'overview') {
  document.querySelectorAll('[data-profile-tab]').forEach(tab => {
    const selected = tab.dataset.profileTab === name
    tab.classList.toggle('active', selected)
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  })
  document.querySelectorAll('[data-profile-panel]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.profilePanel === name)
    if (panel.dataset.profilePanel === name) panel.scrollTop = 0
  })
}

function setProfileTabVisible(name, visible) {
  const tab = document.querySelector(`[data-profile-tab="${name}"]`)
  if (tab) tab.hidden = !visible
}

window.agsShowProfileTab = showProfileTab

async function openPublicProfile(userId, displayName = '') {
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
  activeProfileUser = { userId, displayName }
  const nameEl = document.getElementById('profile-display-name')
  const winsEl = document.getElementById('profile-wins')
  const lossesEl = document.getElementById('profile-losses')
  const rankEl = document.getElementById('profile-rank')
  const authGate = document.getElementById('profile-auth-gate')
  const statsGrid = document.getElementById('profile-stats-grid')
  const friendCard = document.getElementById('profile-friend-card')
  const statusEl = document.getElementById('profile-friend-status')
  const addBtn = document.getElementById('profile-add-friend-btn')
  const matchHistoryEl = document.getElementById('profile-match-history')
  const matchHistoryCountEl = document.getElementById('profile-match-history-count')
  const accountSafetyCard = document.getElementById('profile-account-safety')
  const ratingEl = document.getElementById('profile-rating')
  const chessStatsSection = document.getElementById('profile-chess-stats')

  const editBtn = document.getElementById('profile-btn-edit-name')
  const editForm = document.getElementById('profile-name-edit-form')

  if (typeof window.showScreen === 'function') window.showScreen('profile')
  showProfileTab('overview')
  setProfileTabVisible('stats', !!currentUserId)
  setProfileTabVisible('account', false)
  if (nameEl) nameEl.textContent = displayName || userId.slice(0, 8)
  if (editBtn) editBtn.style.display = 'none'
  if (editForm) editForm.style.display = 'none'
  if (accountSafetyCard) accountSafetyCard.style.display = 'none'

  if (!currentUserId) {
    profileMatchHistoryRows = []
    if (authGate) authGate.style.display = 'flex'
    if (statsGrid) statsGrid.classList.add('is-locked')
    if (friendCard) friendCard.style.display = 'none'
    if (winsEl) winsEl.textContent = '—'
    if (lossesEl) lossesEl.textContent = '—'
    if (rankEl) rankEl.textContent = '—'
    if (ratingEl) ratingEl.textContent = '—'
    if (chessStatsSection) chessStatsSection.style.display = 'none'
    if (statusEl) statusEl.textContent = ''
    if (addBtn) addBtn.style.display = 'none'
    if (matchHistoryCountEl) matchHistoryCountEl.textContent = 'Sign in required'
    if (matchHistoryEl) {
      matchHistoryEl.innerHTML = `<div class="profile-history-empty profile-history-locked">
        <strong>Sign in to view match history</strong>
        <span>Completed games and replays will appear here after you sign in.</span>
      </div>`
    }
    return
  }

  if (authGate) authGate.style.display = 'none'
  if (statsGrid) statsGrid.classList.remove('is-locked')
  if (friendCard) friendCard.style.display = ''
  if (winsEl) winsEl.textContent = '...'
  if (lossesEl) lossesEl.textContent = '...'
  if (rankEl) rankEl.textContent = '...'
  if (statusEl) statusEl.textContent = 'Loading profile...'
  if (addBtn) addBtn.style.display = 'none'
  if (matchHistoryCountEl) matchHistoryCountEl.textContent = 'Loading'
  if (matchHistoryEl) matchHistoryEl.innerHTML = '<div class="profile-history-loading"><span></span><span></span><span></span></div>'

  const [stats, rank, matchHistory, myMatchHistory] = await Promise.all([
    fetchStats(userId),
    fetchUserRank(userId),
    fetchMatchHistory(userId),
    userId === currentUserId ? Promise.resolve(null) : fetchMatchHistory(currentUserId),
  ])

  if (winsEl) winsEl.textContent = stats?.wins ?? 0
  if (lossesEl) lossesEl.textContent = stats?.losses ?? 0
  if (rankEl) rankEl.textContent = rank?.rank ? `#${rank.rank}` : 'Unranked'
  if (ratingEl) ratingEl.textContent = stats?.rating ?? '—'
  renderProfileMatchHistory(matchHistory)
  // Head-to-head is "my record vs this person" — on my own profile that's
  // just my own computed stats; on a friend's profile it needs my own match
  // history too (already fetched above), looked up by their userId.
  const headToHeadEntry = userId === currentUserId
    ? null
    : computeMatchStats(myMatchHistory).headToHead.find(h => h.opponentUserId === userId)
  renderChessStats(computeMatchStats(matchHistory), headToHeadEntry)

  const friend = friendsState.friends.find(item => item.userId === userId)
  const incoming = friendsState.incoming.find(item => item.userId === userId)
  const outgoing = friendsState.outgoing.find(item => item.userId === userId)

  if (userId === currentUserId) {
    if (statusEl) statusEl.textContent = 'This is your profile.'
    if (editBtn) editBtn.style.display = ''
    if (accountSafetyCard) accountSafetyCard.style.display = ''
    setProfileTabVisible('account', true)
    renderBlockedPlayers()
    return
  }

  if (friend) {
    const presence = friend.presence?.label || 'Offline'
    if (statusEl) statusEl.textContent = `Already friends · ${presence}`
    return
  }

  if (outgoing) {
    if (statusEl) statusEl.textContent = 'Friend request already sent.'
    return
  }

  if (incoming) {
    if (statusEl) statusEl.textContent = 'This player sent you a friend request.'
    if (addBtn) {
      addBtn.style.display = ''
      addBtn.disabled = false
      addBtn.textContent = 'Accept Friend Request'
    }
    activeProfileUser = { userId, displayName, action: 'accept' }
    return
  }

  if (!currentUserId) {
    if (statusEl) statusEl.textContent = 'Sign in to add this player as a friend.'
    return
  }

  if (statusEl) statusEl.textContent = ''
  if (addBtn) {
    addBtn.style.display = ''
    addBtn.disabled = false
    addBtn.textContent = 'Add Friend'
  }
  activeProfileUser = { userId, displayName, action: 'request' }
}

function renderBlockedPlayers() {
  const list = document.getElementById('profile-blocked-players')
  const count = document.getElementById('profile-blocked-count')
  if (!list) return
  if (count) count.textContent = String(blockedPlayers.length)
  list.textContent = ''
  if (!blockedPlayers.length) {
    const empty = document.createElement('p')
    empty.className = 'profile-safety-empty'
    empty.textContent = 'You have not blocked any players.'
    list.appendChild(empty)
    return
  }

  const names = resolveDisplayNames(blockedPlayers.map(item => ({ userId: item.userId })))
  for (const player of blockedPlayers) {
    const row = document.createElement('div')
    row.className = 'profile-blocked-row'
    const identity = document.createElement('div')
    const name = document.createElement('strong')
    name.textContent = names[player.userId] || `Player ${player.userId.slice(0, 8)}`
    const id = document.createElement('span')
    id.textContent = player.userId
    identity.append(name, id)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn-mini'
    button.textContent = 'Unblock'
    button.addEventListener('click', async () => {
      button.disabled = true
      const result = await window.agsUnblockPlayer?.(player.userId)
      if (!result?.ok) {
        button.disabled = false
        const message = document.getElementById('profile-safety-message')
        if (message) {
          message.className = 'auth-message error'
          message.textContent = result?.error || 'Could not unblock this player.'
        }
      }
    })
    row.append(identity, button)
    list.appendChild(row)
  }
}

function setAccountDeletionMessage(text, tone = '') {
  const message = document.getElementById('delete-account-message')
  if (!message) return
  message.className = `auth-message${tone ? ` ${tone}` : ''}`
  message.textContent = text || ''
}

async function openDeleteAccountModal() {
  const modal = document.getElementById('delete-account-modal')
  const input = document.getElementById('delete-account-confirmation')
  const submit = document.getElementById('delete-account-submit')
  if (!modal || !currentUserId) return
  deletionRequirements = null
  modal.style.display = 'flex'
  if (input) {
    input.value = ''
    input.disabled = true
  }
  if (submit) submit.disabled = true
  setAccountDeletionMessage('Checking account deletion requirements…')
  try {
    deletionRequirements = await fetchDeletionRequirements()
    if (input) {
      input.disabled = false
      input.focus()
    }
    setAccountDeletionMessage(
      deletionRequirements.appleReauthorizationRequired
        ? 'This account uses Sign in with Apple. Apple will ask you to authenticate once more before deletion.'
        : 'This action cannot be undone. Type DELETE to continue.'
    )
  } catch (error) {
    setAccountDeletionMessage(error?.message || 'Account deletion is temporarily unavailable.', 'error')
  }
}

function updateDeleteAccountConfirmation() {
  const input = document.getElementById('delete-account-confirmation')
  const submit = document.getElementById('delete-account-submit')
  if (submit) submit.disabled = !deletionRequirements || !validateDeletionConfirmation(input?.value)
}

async function confirmAccountDeletion() {
  const input = document.getElementById('delete-account-confirmation')
  const submit = document.getElementById('delete-account-submit')
  const confirmation = input?.value || ''
  if (!deletionRequirements || !validateDeletionConfirmation(confirmation)) {
    setAccountDeletionMessage('Type DELETE exactly to confirm.', 'error')
    return
  }
  if (submit) submit.disabled = true
  if (input) input.disabled = true
  try {
    setAccountDeletionMessage(
      deletionRequirements.appleReauthorizationRequired
        ? 'Waiting for Sign in with Apple…'
        : 'Submitting deletion request…'
    )
    const appleAuthorizationCode = await authorizeAppleDeletionIfRequired(deletionRequirements)
    setAccountDeletionMessage('Submitting deletion request…')
    await submitAccountDeletion({ confirmation, appleAuthorizationCode })
    setAccountDeletionMessage('Deletion accepted. Signing out…', 'success')

    stopFriendsRefresh()
    stopPresenceUpdates()
    stopGameInviteUpdates()
    stopInviteJoinUpdates()
    stopFriendsChangeUpdates()
    clearUnlockedCache()
    chatClient.disconnect()
    clearLiveMatch()
    try {
      await signOutPresence()
    } catch {}
    clearLocalAccountData()
    currentUserId = null
    window.agsCurrentUserId = null
    window.setTimeout(() => {
      window.history.replaceState({}, '', window.location.pathname)
      window.location.reload()
    }, 500)
  } catch (error) {
    if (input) input.disabled = false
    if (submit) submit.disabled = !validateDeletionConfirmation(input?.value)
    setAccountDeletionMessage(error?.message || 'Deletion failed. Your account was not deleted.', 'error')
  }
}

async function requestProfileFriend(profile) {
  const statusEl = document.getElementById('profile-friend-status')
  const addBtn = document.getElementById('profile-add-friend-btn')
  if (addBtn) addBtn.disabled = true

  const result = profile.action === 'accept'
    ? await acceptFriend(profile.userId)
    : await requestFriend(profile.userId)

  if (!result.ok) {
    if (statusEl) statusEl.textContent = result.error
    if (addBtn) addBtn.disabled = false
    return
  }

  await refreshFriendsUI(false)
  await openPublicProfile(profile.userId, profile.displayName)
}

function renderProfileMatchHistory(matches) {
  const el = document.getElementById('profile-match-history')
  const countEl = document.getElementById('profile-match-history-count')
  if (!el) return
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
  const visibleMatches = matches.slice(0, 20)
  profileMatchHistoryRows = visibleMatches
  if (countEl) countEl.textContent = `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`

  if (!matches.length) {
    profileMatchHistoryRows = []
    el.innerHTML = `<div class="profile-history-empty">
      <strong>No completed matches</strong>
      <span>Finished games will appear here with result, opponent, time, and duration.</span>
    </div>`
    return
  }

  el.innerHTML = visibleMatches.map((match, index) => {
    const canReplay = Array.isArray(match.moves) && match.moves.length > 0
    const ended = new Date(match.endedAt)
    const time = Number.isNaN(ended.getTime())
      ? 'Unknown time'
      : ended.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    const opponent = match.opponentName || 'Opponent'
    const rawResult = (match.result || 'completed').toLowerCase()
    const result = rawResult[0].toUpperCase() + rawResult.slice(1)
    const resultClass = ['win', 'loss', 'draw'].includes(rawResult) ? rawResult : 'completed'
    const mode = match.mode === 'computer'
      ? 'Computer'
      : match.mode === 'online'
        ? 'Online'
        : 'Match'
    return `<button class="profile-history-row${canReplay ? ' replayable' : ' no-replay'}" type="button" ${canReplay ? `onclick="window.agsReplayMatchHistory(${index})"` : 'disabled'}>
      <span class="profile-history-result ${esc(resultClass)}">${esc(result)}</span>
      <div class="profile-history-main">
        <strong>${esc(opponent)}</strong>
        <span>${esc(mode)} · ${esc(time)} · ${canReplay ? 'Click to replay' : 'Replay unavailable'}</span>
      </div>
      <div class="profile-history-meta">
        <span>Length</span>
        <span>${esc(formatDuration(match.durationMs))}</span>
      </div>
    </button>`
  }).join('')
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const restMinutes = minutes % 60
    return `${hours}h ${restMinutes}m`
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatPct(rate) {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`
}

function formatRecord(rec) {
  return rec ? `${rec.wins}-${rec.losses}-${rec.draws} (${formatPct(rec.rate)})` : '—'
}

const OPENING_NAMES = {
  e2e4: '1. e4', d2d4: '1. d4', g1f3: '1. Nf3', c2c4: '1. c4',
  b2b3: '1. b3', g2g3: '1. g3', f2f4: '1. f4', b1c3: '1. Nc3',
}

function renderChessStats(derived, headToHeadEntry) {
  const section = document.getElementById('profile-chess-stats')
  if (!section) return
  if (!derived.totalGames) {
    section.style.display = 'none'
    return
  }
  section.style.display = ''

  const set = (id, text) => {
    const el = document.getElementById(id)
    if (el) el.textContent = text
  }

  const h2h = document.getElementById('profile-head-to-head')
  if (headToHeadEntry) {
    if (h2h) h2h.style.display = ''
    set('profile-head-to-head-value', `${headToHeadEntry.wins}W-${headToHeadEntry.losses}L-${headToHeadEntry.draws}D`)
  } else if (h2h) {
    h2h.style.display = 'none'
  }

  set('profile-rate-white', formatRecord(derived.winRateByColor.white))
  set('profile-rate-black', formatRecord(derived.winRateByColor.black))
  set('profile-rate-vs-bot', formatRecord(derived.winRateByOpponentType.vsBot))
  set('profile-rate-vs-human', formatRecord(derived.winRateByOpponentType.vsHuman))

  set('profile-favorite-opening', derived.favoriteOpening
    ? `${OPENING_NAMES[derived.favoriteOpening.key] || derived.favoriteOpening.key} (${formatPct(derived.favoriteOpening.rate)} win)`
    : '—')

  set('profile-time-played', derived.timePlayed.totalMs ? formatDuration(derived.timePlayed.totalMs) : '—')
  set('profile-game-length', derived.timePlayed.longest && derived.timePlayed.shortest
    ? `${formatDuration(derived.timePlayed.longest.durationMs)} / ${formatDuration(derived.timePlayed.shortest.durationMs)}`
    : '—')
  set('profile-fastest-checkmate', derived.fastestCheckmateMoves != null ? `${derived.fastestCheckmateMoves} moves` : '—')

  const c = derived.castlingRate
  set('profile-castling', c.total
    ? `${formatPct(c.kingsidePct)} kingside · ${formatPct(c.queensidePct)} queenside`
    : '—')

  set('profile-comeback-wins', derived.comebackWins > 0 ? String(derived.comebackWins) : '—')

  const e = derived.endReasonCounts
  const decisive = e.checkmate + e.resignation
  set('profile-end-reasons', decisive || (e['draw-insufficient'] + e['draw-fifty-move'] + e['draw-repetition'] + e.stalemate)
    ? `${e.checkmate} checkmate · ${e.resignation} resign · ${e.stalemate + e['draw-insufficient'] + e['draw-fifty-move'] + e['draw-repetition']} draw`
    : '—')

  set('profile-nemesis', derived.nemesis ? `${derived.nemesis.name} (${formatRecord(derived.nemesis)})` : '—')
}

function updateAuthUI(loggedIn, name, userId) {
  const nameInput = document.getElementById('player-name-input')
  const signInBtn = document.getElementById('ags-signin-btn')
  const authActions = document.getElementById('ags-auth-actions')
  const authOrDivider = document.getElementById('ags-auth-or-divider')
  const guestDivider = document.getElementById('ags-guest-divider')
  const accountEntry = document.getElementById('ags-account-entry')
  const guestEntry = document.getElementById('ags-guest-entry')
  const guestOptions = document.getElementById('ags-guest-options')
  const guestTrigger = document.getElementById('ags-open-guest')
  const memberPlayActions = document.getElementById('ags-member-play-actions')
  const homeLeaderboard = document.getElementById('home-leaderboard-panel')
  const signedInInfo = document.getElementById('ags-signedin-info')
  const signedInName = document.getElementById('ags-signedin-name')
  const lbCta = document.getElementById('lb-signin-cta')

  if (!nameInput || !signInBtn || !signedInInfo) return

  // Switches the home screen into the compact, no-scroll signed-in dashboard.
  document.getElementById('screen-home')?.classList.toggle('signed-in', loggedIn)

  // Sign in with Apple is an iOS-only option (App Store Guideline 4.8).
  const appleBtn = document.getElementById('ags-signin-apple')
  const isNative = !!window.Capacitor?.isNativePlatform?.()
  if (appleBtn) appleBtn.style.display = (!loggedIn && isNative) ? '' : 'none'

  if (loggedIn) {
    nameInput.style.display = 'none'
    signInBtn.style.display = 'none'
    if (accountEntry) accountEntry.style.display = 'none'
    if (guestEntry) guestEntry.style.display = 'none'
    if (memberPlayActions) memberPlayActions.style.display = ''
    if (homeLeaderboard) homeLeaderboard.style.display = ''
    if (authActions) authActions.style.display = 'none'
    if (authOrDivider) authOrDivider.style.display = 'none'
    if (guestDivider) guestDivider.style.display = 'none'
    if (lbCta) lbCta.style.display = 'none'
    signedInInfo.style.display = 'flex'
    if (signedInName) signedInName.textContent = name || 'Player'
  } else {
    acceptedLegalDocuments = []
    renderAcceptedLegalDocuments()
    nameInput.style.display = ''
    signInBtn.style.display = ''
    if (accountEntry) accountEntry.style.display = ''
    if (guestEntry) guestEntry.style.display = ''
    if (memberPlayActions) memberPlayActions.style.display = 'none'
    if (homeLeaderboard) homeLeaderboard.style.display = 'none'
    if (guestOptions) guestOptions.hidden = true
    if (guestTrigger) {
      guestTrigger.style.display = ''
      guestTrigger.setAttribute('aria-expanded', 'false')
    }
    if (authActions) authActions.style.display = 'flex'
    if (authOrDivider) authOrDivider.style.display = ''
    if (guestDivider) guestDivider.style.display = ''
    if (lbCta) lbCta.style.display = ''
    signedInInfo.style.display = 'none'
    const randomBtn = document.getElementById('btn-play-random')
    if (randomBtn) randomBtn.style.display = 'none'
    friendsState = { friends: [], incoming: [], outgoing: [] }
    renderFriendsPanel(false)
  }
}

function updateStatsUI(stats, streak) {
  const el = document.getElementById('ags-stats')
  const achBtn = document.getElementById('btn-achievements')
  if (achBtn) achBtn.style.display = stats ? '' : 'none'
  if (!el) return
  if (stats) {
    el.style.display = ''
    const s = streak ?? currentStreak
    const rating = stats.rating ? `  ·  ⭐ ${stats.rating}` : ''
    el.textContent = s > 0
      ? `W ${stats.wins}  ·  L ${stats.losses}  ·  🔥 ${s}${rating}`
      : `W ${stats.wins}  ·  L ${stats.losses}${rating}`
    el.title = stats.rating
      ? 'Elo Style Rating: starts at 1200. Beating a higher-rated opponent gains more, losing to a lower-rated opponent costs more — up to about ±32 points per online match, scaled by the rating gap.'
      : ''
  } else {
    el.style.display = 'none'
  }
}

function escAch(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function safeAchievementIcon(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? escAch(url.toString()) : ''
  } catch {
    return ''
  }
}

function showAchievementToast(items) {
  const container = document.getElementById('achievement-toasts')
  if (!container || !items?.length) return
  for (const it of items) {
    const el = document.createElement('div')
    el.className = 'achievement-toast'
    const icon = safeAchievementIcon(it.icon)
    el.innerHTML =
      `${icon ? `<img src="${icon}" alt="" class="ach-toast-icon">` : '<span class="ach-toast-icon">🏆</span>'}` +
      `<div class="ach-toast-body">` +
        `<span class="ach-toast-label">Achievement Unlocked</span>` +
        `<span class="ach-toast-name">${escAch(it.name)}</span>` +
      `</div>`
    el.addEventListener('click', () => window.agsOpenAchievements?.())
    container.appendChild(el)
    requestAnimationFrame(() => el.classList.add('show'))
    setTimeout(() => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 400)
    }, 5000)
  }
}

function renderAchievementPanel(list) {
  const grid = document.getElementById('achievements-grid')
  if (!grid) return
  if (!list?.length) {
    grid.innerHTML = '<p class="achievements-loading">No achievements available.</p>'
    return
  }
  const unlockedCount = list.filter(a => a.unlocked).length
  grid.innerHTML =
    `<p class="ach-summary">${unlockedCount} of ${list.length} unlocked</p>` +
    `<div class="ach-cards">` +
    list.map(a => {
      const pct = a.goalValue ? Math.round((a.progress / a.goalValue) * 100) : 0
      const icon = safeAchievementIcon(a.icon)
      const footer = a.unlocked
        ? `<span class="ach-card-done">✓ Unlocked</span>` +
          `<button class="ach-share-btn" data-code="${escAch(a.code)}">📤 Share</button>` +
          `<div class="ach-share-slot"></div>`
        : `<div class="ach-progress"><div class="ach-progress-fill" style="width:${pct}%"></div></div>` +
          `<span class="ach-progress-text">${a.progress} / ${a.goalValue}</span>`
      return (
        `<div class="ach-card${a.unlocked ? ' unlocked' : ' locked'}">` +
          `${icon ? `<img src="${icon}" alt="" class="ach-card-icon">` : '<span class="ach-card-icon">🏆</span>'}` +
          `<span class="ach-card-name">${escAch(a.name)}</span>` +
          `<span class="ach-card-desc">${escAch(a.description)}</span>` +
          footer +
        `</div>`
      )
    }).join('') +
    `</div>`

  const byCode = {}
  for (const a of list) byCode[a.code] = a
  grid.querySelectorAll('.ach-share-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.parentElement.querySelector('.ach-share-slot')
      if (!slot) return
      if (slot.querySelector('.share-row')) { slot.innerHTML = ''; return }  // toggle off
      shareAchievement(byCode[btn.dataset.code], slot)
    })
  })
}

function shareAchievement(a, slot) {
  if (!a || !slot) return
  const inviteUrl = window.agsGetInviteUrl?.()
  if (!inviteUrl) { slot.innerHTML = '<p class="ach-share-hint">Sign in to share.</p>'; return }
  mountShareRow(slot, inviteUrl, {
    campaign: 'achievement-share',
    shareEvent: 'achievement_shared',
    sharePayload: { code: a.code },
    emailSubject: `I unlocked "${a.name}" in Ethan's Chess!`,
    gameText: u => `I just unlocked "${a.name}" in Ethan's Chess 🏆 — play with me: ${u}`,
    xText: `I just unlocked "${a.name}" 🏆 in Ethan's Chess — think you can?`,
  })
}

function setFriendsMessage(text, tone = '') {
  const el = document.getElementById('ags-friends-message')
  if (!el) return
  el.className = `auth-message${tone ? ' ' + tone : ''}`
  el.textContent = text || ''
}

function setAddFriendBusy(busy) {
  const input = document.getElementById('ags-add-friend-email')
  const submit = document.getElementById('ags-add-friend-submit')
  if (input) input.disabled = busy
  if (submit) {
    submit.disabled = busy
    submit.textContent = busy ? 'Searching...' : 'Send request'
  }
}

function renderAddFriendFeedback(tone, title, message, action) {
  const result = document.getElementById('ags-add-friend-result')
  if (!result) return null

  const card = document.createElement('div')
  card.className = `add-friend-feedback ${tone}`
  card.setAttribute('role', tone === 'error' ? 'alert' : 'status')

  const heading = document.createElement('p')
  heading.className = 'add-friend-feedback-title'
  heading.textContent = title
  const detail = document.createElement('p')
  detail.className = 'add-friend-feedback-message'
  detail.textContent = message
  card.append(heading, detail)

  if (action) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn-mini success'
    button.textContent = action.label
    button.addEventListener('click', action.onClick)
    card.append(button)
  }

  result.replaceChildren(card)
  return card
}

function addFriendErrorTitle(reason) {
  if (reason === 'invalid_email') return 'Check the email address'
  if (reason === 'self') return 'That is your account'
  if (reason === 'authentication') return 'Sign in again'
  if (reason === 'rate_limited') return 'Please wait'
  if (reason === 'not_allowed') return 'Request not available'
  if (reason === 'already_pending') return 'Request already pending'
  if (reason === 'unavailable') return 'Friends service unavailable'
  return 'Request not sent'
}

async function acceptAddFriendResult(friendId, displayName) {
  setAddFriendBusy(true)
  renderAddFriendFeedback('loading', 'Accepting request', `Adding ${displayName} to your Friends list...`)
  const result = await acceptFriend(friendId)
  setAddFriendBusy(false)
  if (!result.ok) {
    renderAddFriendFeedback('error', addFriendErrorTitle(result.reason), result.error)
    return
  }
  renderAddFriendFeedback('success', 'You are now friends', `${displayName} is now in your Friends list.`)
  sendEvent('friend_request_accepted', { source: 'email_lookup' })
  await refreshFriendsUI(false)
}

async function runFriendAction(action, successMessage) {
  setFriendsMessage('Updating friends...')
  const result = await action()
  if (!result.ok) {
    setFriendsMessage(result.error, 'error')
    return false
  }
  setFriendsMessage(successMessage, 'success')
  await refreshFriendsUI(false, true)
  return true
}

async function refreshFriendsUI(showLoading = true, preserveMessage = false) {
  if (!currentUserId) {
    renderFriendsPanel(false)
    return
  }
  if (showLoading) setFriendsMessage('Loading friends...')
  const state = await fetchFriendState()
  if (!state.ok) {
    setFriendsMessage(state.error, 'error')
    renderFriendsPanel(true)
    return
  }
  friendsState = state
  if (!preserveMessage) setFriendsMessage('')
  renderFriendsPanel(true)
  notifyNewFriendRequests(state.incoming)
  if ((state.friends?.length || 0) >= 5) unlockEventAchievement(currentUserId, 'chess-social-5')  // 5+ friends (409 no-op if already unlocked)

  const anyAccepted = await processIncomingInviteAcceptances(state.incoming)
  if (anyAccepted) await refreshFriendsUI(false)
}

function notifyNewFriendRequests(incoming = []) {
  const ids = incoming.map(item => item.userId).filter(Boolean)
  // First load after login: prime the set silently so we don't notify for
  // requests that were already pending before this session.
  if (seenIncomingRequestIds === null) {
    seenIncomingRequestIds = new Set(ids)
    return
  }
  const fresh = incoming.filter(item => item.userId && !seenIncomingRequestIds.has(item.userId))
  for (const id of ids) seenIncomingRequestIds.add(id)
  if (!fresh.length) return
  if (fresh.length === 1) {
    const name = fresh[0].displayName || fresh[0].name || 'Someone'
    notify('New friend request', { body: `${name} wants to be your friend`, tag: 'friend-request' })
  } else {
    notify('New friend requests', { body: `You have ${fresh.length} new friend requests`, tag: 'friend-request' })
  }
}

function startFriendsRefresh() {
  stopFriendsRefresh()
  friendsRefreshTimer = setInterval(() => {
    if (currentUserId) refreshFriendsUI(false)
  }, 15000)
}

function stopFriendsRefresh() {
  if (friendsRefreshTimer) {
    clearInterval(friendsRefreshTimer)
    friendsRefreshTimer = null
  }
}

function normalizeFriendUserId(userId) {
  return String(userId || '').replace(/-/g, '')
}

function startPresenceUpdates() {
  stopPresenceUpdates()
  unsubscribePresenceUpdates = subscribePresenceUpdates((userId, presence) => {
    const normalizedUserId = normalizeFriendUserId(userId)
    let changed = false
    const friends = friendsState.friends.map(friend => {
      if (normalizeFriendUserId(friend.userId) !== normalizedUserId) return friend
      changed = true
      return { ...friend, presence }
    })

    if (changed) {
      friendsState = { ...friendsState, friends }
      renderFriendsPanel(true)
    }
  })
  unsubscribeLobbyOpen = subscribeLobbyOpen(() => {
    if (currentUserId) refreshFriendsUI(false)
  })
}

function stopPresenceUpdates() {
  if (unsubscribePresenceUpdates) {
    unsubscribePresenceUpdates()
    unsubscribePresenceUpdates = null
  }
  if (unsubscribeLobbyOpen) {
    unsubscribeLobbyOpen()
    unsubscribeLobbyOpen = null
  }
}

function startGameInviteUpdates() {
  stopGameInviteUpdates()
  unsubscribeGameInvites = subscribeGameInvites(invite => {
    if (invite?.type === 'chess-match-declined') {
      if (typeof window.handleMatchDeclined === 'function') {
        window.handleMatchDeclined(invite)
      }
      return
    }
    notify(`${invite?.fromName || 'A friend'} invited you to play`, {
      body: 'Open Ethan\'s Chess to join the match',
      tag: 'game-invite',
    })
    if (typeof window.showFriendMatchInvite === 'function') {
      window.showFriendMatchInvite(invite)
    }
  })
}

function stopGameInviteUpdates() {
  if (unsubscribeGameInvites) {
    unsubscribeGameInvites()
    unsubscribeGameInvites = null
  }
}

function startInviteJoinUpdates() {
  stopInviteJoinUpdates()
  unsubscribeInviteJoins = subscribeInviteJoins(join => showInviteJoinToast(join))
}

function stopInviteJoinUpdates() {
  if (unsubscribeInviteJoins) {
    unsubscribeInviteJoins()
    unsubscribeInviteJoins = null
  }
}

// React the instant Lobby pushes a friend-relationship change, instead of
// waiting on the 15s periodic refresh (startFriendsRefresh) — that gap is what
// made an invitee see their inviter stuck at "pending" for several seconds
// after being accepted, while the accepting side (already refreshing itself
// locally) saw the change immediately.
function startFriendsChangeUpdates() {
  stopFriendsChangeUpdates()
  unsubscribeFriendsChanges = subscribeFriendsChanges(({ type, otherUserId }) => {
    const normalizedOtherId = otherUserId ? normalizeFriendUserId(otherUserId) : null
    if (type === 'requestFriendsNotif' && normalizedOtherId && expectedInviteFriendIds.has(normalizedOtherId)) {
      expectedInviteFriendIds.delete(normalizedOtherId)
      acceptFriend(otherUserId).then(result => {
        if (result.ok) {
          setFriendsMessage('You are now friends with your inviter!', 'success')
          refreshFriendsUI(false)
        }
      }).catch(() => {})
      return
    }
    refreshFriendsUI(false)
  })
}

function stopFriendsChangeUpdates() {
  if (unsubscribeFriendsChanges) {
    unsubscribeFriendsChanges()
    unsubscribeFriendsChanges = null
  }
}

function showInviteJoinToast({ fromUserId, fromName }) {
  const toast = document.getElementById('invite-join-toast')
  if (toast) {
    const nameEl = document.getElementById('invite-join-name')
    if (nameEl) {
      nameEl.textContent = fromName
        ? `${fromName} just signed up via your invite!`
        : 'Someone just signed up via your invite!'
    }
    toast.classList.add('show')
    clearTimeout(toast._timer)
    toast._timer = setTimeout(() => toast.classList.remove('show'), 10000)
  }
  sendEvent('invite_join_notif_shown', { hasName: !!fromName })

  // Complete the invite→friend link from the inviter's side: auto-accept the new
  // player's incoming friend request. Covers link invites (no stored pending-invite
  // email). The real-time requestFriendsNotif (handled in
  // startFriendsChangeUpdates) does the actual accepting the instant their
  // request lands — mark them as expected here so that listener recognizes it.
  // The one-off checks below are just a fallback for the (rare) case where the
  // push notification itself is missed, e.g. a lobby reconnect gap.
  if (fromUserId && fromUserId !== currentUserId) {
    expectedInviteFriendIds.add(normalizeFriendUserId(fromUserId))
    setTimeout(() => expectedInviteFriendIds.delete(normalizeFriendUserId(fromUserId)), EXPECTED_INVITE_TTL_MS)

    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const state = await fetchFriendState()
          if (!state.ok) break
          if (state.friends?.some(f => f.userId === fromUserId)) break
          if (state.incoming?.some(r => r.userId === fromUserId)) {
            const result = await acceptFriend(fromUserId)
            if (result.ok) { await refreshFriendsUI(false); break }
          }
        } catch { /* transient — retry */ }
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    })()
  }
}

function friendRow(item, actions = '') {
  const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  const presence = item.presence || { status: 'offline', label: 'Offline' }
  return `<div class="friend-row">
    <div class="friend-main">
      <span class="friend-name">${esc(item.displayName)}
        <span class="friend-presence ${esc(presence.status)}">${esc(presence.label)}</span>
      </span>
    </div>
    ${actions ? `<div class="friend-actions">${actions}</div>` : ''}
  </div>`
}

function renderFriendsListOnlineFirst(friends) {
  const el = document.getElementById('ags-friends-list')
  const countEl = document.getElementById('ags-count-friends')
  if (!el) return
  if (countEl) countEl.textContent = friends.length || ''

  if (!friends.length) {
    el.innerHTML = '<p class="friends-empty">No friends yet.</p>'
    return
  }

  const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
  const online = friends.filter(f => ['online', 'in-match'].includes(f.presence?.status))
  const offline = friends.filter(f => !['online', 'in-match'].includes(f.presence?.status))
  let html = ''
  if (online.length) {
    html += `<div class="friends-group-divider"><span>Online · ${online.length}</span></div>`
    html += online.map(item => {
      const inMatch = item.presence?.status === 'in-match'
      // Use data attributes — never put user-controlled strings into inline event handlers.
      const action = inMatch
        ? `<button class="btn-mini spectator" data-action="watch" data-user-id="${esc(item.userId)}" data-display-name="${esc(item.displayName || '')}">Watch</button>`
        : `<button class="btn-mini success" data-action="invite" data-user-id="${esc(item.userId)}">Invite</button>`
      return friendRow(item, action)
    }).join('')
  }
  if (offline.length) {
    if (online.length) html += `<div class="friends-group-divider"><span>Offline · ${offline.length}</span></div>`
    html += offline.map(item => friendRow(item, '')).join('')
  }
  el.innerHTML = html

  el.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { action, userId, displayName } = btn.dataset
      if (action === 'watch') window.agsWatchFriend?.(userId, displayName || '')
      else if (action === 'invite') window.agsInviteFriend?.(userId)
    })
  })
}

// onAction(action, userId) is called when any data-action button is clicked.
function renderCountedSection(sectionId, countId, listId, items, actionBuilder, onAction) {
  const sectionEl = document.getElementById(sectionId)
  const countEl = document.getElementById(countId)
  const listEl = document.getElementById(listId)
  if (!sectionEl || !listEl) return
  if (!items.length) {
    sectionEl.style.display = 'none'
    return
  }
  sectionEl.style.display = ''
  if (countEl) countEl.textContent = items.length
  listEl.innerHTML = items.map(item => friendRow(item, actionBuilder(item))).join('')
  if (onAction) {
    listEl.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => onAction(btn.dataset.action, btn.dataset.userId))
    })
  }
}

function renderFriendsPanel(loggedIn) {
  const panel = document.getElementById('ags-friends-panel')
  if (!panel) return
  panel.style.display = loggedIn ? '' : 'none'
  if (!loggedIn) return

  const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))

  renderFriendsListOnlineFirst(friendsState.friends)
  renderCountedSection('ags-section-incoming', 'ags-count-incoming', 'ags-friends-incoming',
    friendsState.incoming,
    item => `
      <button class="btn-mini success" data-action="accept" data-user-id="${esc(item.userId)}">Accept</button>
      <button class="btn-mini" data-action="reject" data-user-id="${esc(item.userId)}">Reject</button>
    `,
    (action, userId) => {
      if (action === 'accept') window.agsAcceptFriend?.(userId)
      else if (action === 'reject') window.agsRejectFriend?.(userId)
    }
  )
  renderCountedSection('ags-section-outgoing', 'ags-count-outgoing', 'ags-friends-outgoing',
    friendsState.outgoing,
    item => `<button class="btn-mini" data-action="cancel" data-user-id="${esc(item.userId)}">Cancel</button>`,
    (action, userId) => {
      if (action === 'cancel') window.agsCancelFriendRequest?.(userId)
    }
  )
}

async function updatePostMatchFriendAction(opponent) {
  const btn = document.getElementById('btn-add-match-friend')
  const note = document.getElementById('match-friend-message')
  if (!btn || !note) return
  if (!opponent?.userId || opponent.userId === currentUserId) {
    btn.style.display = 'none'
    note.textContent = ''
    return
  }
  if (blockedPlayers.some(item => item.userId === opponent.userId)) {
    btn.style.display = 'none'
    note.textContent = ''
    return
  }

  btn.style.display = ''
  btn.disabled = false
  btn.textContent = `Add ${opponent.name || 'opponent'}`
  btn.onclick = () => window.agsRequestLastOpponent && window.agsRequestLastOpponent()
  note.textContent = ''

  const status = await getFriendshipStatus(opponent.userId)
  if (!status.ok) return
  if (status.status === '3') {
    btn.style.display = 'none'
    note.textContent = ''
  } else if (status.status === '1') {
    btn.disabled = true
    btn.textContent = 'Request Sent'
  } else if (status.status === '2') {
    btn.textContent = 'Accept Friend Request'
    btn.onclick = () => window.agsAcceptFriend && window.agsAcceptFriend(opponent.userId)
  }
}

window.agsUpdateMatchFriendAction = updatePostMatchFriendAction

// Replay state — index of the move currently shown (-1 = live / not in replay)
let spectatorReplayIndex = -1
let spectatorLastMatchData = null
const spectatorAi = new ChessAI()

function replayAt(index) {
  if (!spectatorLastMatchData) return
  const moves = spectatorLastMatchData.moves || []
  spectatorReplayIndex = Math.max(0, Math.min(index, moves.length - 1))
  renderSpectatorBoard(spectatorLastMatchData, spectatorReplayIndex)
}

function switchToSpectatorScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  document.getElementById('screen-' + name)?.classList.add('active')
}

function setSpectatorReplayControls(visible) {
  const controls = document.getElementById('spectator-replay-controls')
  const liveNote = document.getElementById('spectator-live-note')
  const analysis = document.getElementById('spectator-analysis')
  if (controls) controls.style.display = visible ? '' : 'none'
  if (liveNote) liveNote.style.display = visible ? 'none' : ''
  if (analysis && !visible) analysis.style.display = 'none'
}

function replayMatchHistoryAt(index) {
  const match = profileMatchHistoryRows[index]
  if (!match || !Array.isArray(match.moves) || !match.moves.length) return

  spectatorPrevScreen = 'profile'
  spectatorReplayIndex = match.moves.length - 1
  const finalGame = buildReplayPosition(match.moves, match.moves.length - 1)
  spectatorLastMatchData = {
    active: false,
    moves: match.moves,
    whiteName: match.whiteName || 'White',
    blackName: match.blackName || 'Black',
    status: finalGame.status || 'completed',
    winner: finalGame.winner || null,
    startedAt: match.startedAt,
  }
  switchToSpectatorScreen('spectator')
  renderSpectatorBoard(spectatorLastMatchData, spectatorReplayIndex)
  setSpectatorReplayControls(true)
}

window.agsReplayMatchHistory = replayMatchHistoryAt

function addSpectatorCoordinateLabels(squareEl, r, c) {
  if (c === 0) {
    const rank = document.createElement('span')
    rank.className = 'coord-label coord-rank'
    rank.textContent = String(8 - r)
    squareEl.appendChild(rank)
  }
  if (r === 7) {
    const file = document.createElement('span')
    file.className = 'coord-label coord-file'
    file.textContent = 'abcdefgh'[c]
    squareEl.appendChild(file)
  }
}

function sameReplayMove(a, b) {
  if (!a || !b) return false
  const ap = a.promType || 'queen'
  const bp = b.promType || 'queen'
  return a.fr === b.fr && a.fc === b.fc && a.toR === b.toR && a.toC === b.toC && ap === bp
}

function scoreForColor(score, color) {
  return color === 'white' ? score : -score
}

function formatPawnLoss(cp) {
  const pawns = Math.max(0, cp) / 100
  if (pawns < 0.15) return 'about equal'
  if (pawns < 1) return `${pawns.toFixed(1)} pawn`
  return `${pawns.toFixed(1)} pawns`
}

function buildReplayPosition(moves, throughIndex) {
  const g = new ChessGame()
  for (let i = 0; i <= throughIndex; i++) {
    const m = moves[i]
    if (!m || !g.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen')) break
  }
  return g
}

function analyzeReplayMove(matchData, moveIndex) {
  const moves = matchData.moves || []
  const played = moves[moveIndex]
  if (!played) return null

  const before = buildReplayPosition(moves, moveIndex - 1)
  const mover = before.currentTurn
  const playedNotation = before.getMoveNotation(played.fr, played.fc, played.toR, played.toC, played.promType || 'queen')
  const best = spectatorAi.getBestMove(before, 'medium')
  if (!best) {
    return {
      grade: 'Forced',
      text: `${playedNotation} was played in a position with no meaningful alternative.`,
      recommendation: '',
    }
  }

  const bestNotation = before.getMoveNotation(best.fr, best.fc, best.toR, best.toC, best.promType || 'queen')
  const playedAfter = buildReplayPosition(moves, moveIndex - 1)
  playedAfter.makeMove(played.fr, played.fc, played.toR, played.toC, played.promType || 'queen')
  const bestAfter = buildReplayPosition(moves, moveIndex - 1)
  bestAfter.makeMove(best.fr, best.fc, best.toR, best.toC, best.promType || 'queen')

  const playedScore = scoreForColor(spectatorAi.evaluate(playedAfter), mover)
  const bestScore = scoreForColor(spectatorAi.evaluate(bestAfter), mover)
  const loss = bestScore - playedScore
  const sameMove = sameReplayMove(played, best)
  const moverName = mover === 'white' ? (matchData.whiteName || 'White') : (matchData.blackName || 'Black')

  if (sameMove || loss < 35) {
    return {
      grade: 'Strong move',
      text: `${moverName}'s ${playedNotation} matches the engine's preferred idea.`,
      recommendation: 'No better move found at this depth.',
    }
  }

  if (loss < 120) {
    return {
      grade: 'Playable',
      text: `${moverName}'s ${playedNotation} is playable, but it gives up ${formatPawnLoss(loss)} compared with the best line.`,
      recommendation: `Consider ${bestNotation} instead.`,
    }
  }

  return {
    grade: 'Better move available',
    text: `${moverName}'s ${playedNotation} misses a stronger continuation and gives up ${formatPawnLoss(loss)}.`,
    recommendation: `Recommended: ${bestNotation}.`,
  }
}

function renderSpectatorAnalysis(matchData, replayIndex) {
  const panel = document.getElementById('spectator-analysis')
  const gradeEl = document.getElementById('spectator-analysis-grade')
  const textEl = document.getElementById('spectator-analysis-text')
  const recEl = document.getElementById('spectator-analysis-recommendation')
  if (!panel || !gradeEl || !textEl || !recEl) return

  if (replayIndex < 0 || matchData.active) {
    panel.style.display = 'none'
    return
  }

  const result = analyzeReplayMove(matchData, replayIndex)
  if (!result) {
    panel.style.display = 'none'
    return
  }

  panel.style.display = ''
  gradeEl.textContent = result.grade
  textEl.textContent = result.text
  recEl.textContent = result.recommendation
}

function renderSpectatorBoard(matchData, replayIndex = -1) {
  const boardEl = document.getElementById('spectator-board')
  const statusEl = document.getElementById('spectator-status')
  const countEl = document.getElementById('spectator-move-count')
  const histEl = document.getElementById('spectator-move-history')
  const whiteEl = document.getElementById('spectator-white-name')
  const blackEl = document.getElementById('spectator-black-name')
  if (!boardEl) return

  if (whiteEl) whiteEl.textContent = matchData.whiteName || 'White'
  if (blackEl) blackEl.textContent = matchData.blackName || 'Black'

  const allMoves = matchData.moves || []
  const movesToShow = replayIndex >= 0 ? allMoves.slice(0, replayIndex + 1) : allMoves
  // The highlighted move index in the full notation list
  const highlightIdx = replayIndex >= 0 ? replayIndex : allMoves.length - 1

  // Replay moves, capturing algebraic notation before each move
  const g = new ChessGame()
  const notations = []
  for (const m of allMoves) {
    notations.push(g.getMoveNotation(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen'))
    g.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen')
  }

  // Board — replay only up to the chosen position
  const gView = new ChessGame()
  for (const m of movesToShow) {
    gView.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen')
  }
  boardEl.innerHTML = ''
  const last = gView.moveHistory[gView.moveHistory.length - 1]
  const kingInCheck = (gView.status === 'check' || gView.status === 'checkmate') ? gView.findKing(gView.currentTurn) : null
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = document.createElement('div')
      sq.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark')
      addSpectatorCoordinateLabels(sq, r, c)
      if (last && ((last.fr === r && last.fc === c) || (last.toR === r && last.toC === c))) sq.classList.add('last-move')
      if (kingInCheck?.r === r && kingInCheck?.c === c) sq.classList.add('in-check')
      const piece = gView.board[r][c]
      if (piece) {
        const p = document.createElement('div')
        p.className = 'piece ' + piece.color
        p.style.cursor = 'default'
        if (typeof window.setChessPieceGraphic === 'function') {
          window.setChessPieceGraphic(
            p,
            piece.type,
            piece.color,
            `${piece.color} ${piece.type} on ${'abcdefgh'[c]}${8 - r}`
          )
        }
        sq.appendChild(p)
      }
      boardEl.appendChild(sq)
    }
  }

  // Move history — all moves, highlighted entry = highlightIdx
  if (histEl) {
    histEl.innerHTML = ''
    let scrollTarget = null
    for (let i = 0; i < notations.length; i += 2) {
      const moveNum = Math.floor(i / 2) + 1
      const wn = notations[i] || ''
      const bn = notations[i + 1] || ''
      const wActive = i === highlightIdx
      const bActive = i + 1 === highlightIdx
      const row = document.createElement('div')
      row.className = 'move-row spectator-move-row'
      row.innerHTML =
        `<span class="move-num">${moveNum}.</span>` +
        `<span class="move-white${wActive ? ' move-active' : (i < movesToShow.length ? ' move-played' : ' move-future')}">${wn}</span>` +
        `<span class="move-black${bActive ? ' move-active' : (i + 1 < movesToShow.length ? ' move-played' : ' move-future')}">${bn}</span>`
      histEl.appendChild(row)
      if (wActive || bActive) scrollTarget = row
    }
    if (scrollTarget) scrollTarget.scrollIntoView({ block: 'nearest' })
  }

  // Replay nav counter
  const posEl = document.getElementById('spectator-replay-pos')
  if (posEl && replayIndex >= 0) {
    posEl.textContent = `Move ${replayIndex + 1} / ${allMoves.length}`
  }

  // Status and count
  const isReplayMode = replayIndex >= 0
  if (!matchData.active && !isReplayMode) {
    let endText = 'Match ended'
    if (g.status === 'checkmate') {
      const winnerName = g.winner === 'white' ? (matchData.whiteName || 'White') : (matchData.blackName || 'Black')
      endText = `${winnerName} wins by checkmate!`
    } else if (g.status === 'stalemate') {
      endText = 'Draw by stalemate'
    } else if (g.status === 'draw-insufficient') {
      endText = 'Draw by insufficient material'
    } else if (g.status === 'draw-fifty-move') {
      endText = 'Draw by the fifty-move rule'
    } else if (g.status === 'draw-repetition') {
      endText = 'Draw by threefold repetition'
    }
    if (statusEl) statusEl.textContent = endText
    if (countEl) countEl.textContent = `${notations.length} moves total`
  } else if (isReplayMode) {
    const turnName = gView.currentTurn === 'white' ? (matchData.whiteName || 'White') : (matchData.blackName || 'Black')
    if (statusEl) statusEl.textContent = gView.status === 'check'
      ? `${turnName} is in check!`
      : gView.status === 'checkmate'
        ? `Checkmate — ${gView.currentTurn === 'white' ? (matchData.blackName || 'Black') : (matchData.whiteName || 'White')} wins`
        : gView.status === 'stalemate'
          ? 'Stalemate'
          : gView.status === 'draw-insufficient'
            ? 'Draw by insufficient material'
            : gView.status === 'draw-fifty-move'
              ? 'Draw by the fifty-move rule'
              : gView.status === 'draw-repetition'
                ? 'Draw by threefold repetition'
          : `${turnName}'s turn`
    if (countEl) countEl.textContent = ''
  } else {
    const turnName = gView.currentTurn === 'white' ? (matchData.whiteName || 'White') : (matchData.blackName || 'Black')
    if (statusEl) statusEl.textContent = gView.status === 'check' ? `${turnName} is in check!` : `${turnName}'s turn`
    if (countEl) countEl.textContent = notations.length ? `${notations.length} moves` : ''
  }

  renderSpectatorAnalysis(matchData, replayIndex)
}

window.addEventListener('beforeunload', disconnectPresence)
window.addEventListener('pagehide', pausePresence)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    pausePresence()
  } else {
    resumePresence()
  }
})

initializeLegalReader()
initAuth()

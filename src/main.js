import { Capacitor, registerPlugin } from '@capacitor/core'
import { ConfigApi as ChatConfigApi, TopicApi as ChatTopicApi } from '@accelbyte/sdk-chat'
import { loginWithGoogle, loginWithApple, loginWithPassword, requestPasswordReset, resetPassword, registerWithPassword, registerChildAccount, handleCallback, getProfile, getDisplayName, updateDisplayName, syncBasicProfile, logout, refreshSession, hasStoredSession, clearStoredSession, clearLocalAccountData } from './auth.js'
import { validateBirthYear, isBirthYearUnder13, isChildSession, buildConsentRecord } from './family-safety.mjs'
import { setQueueUIHandler, cancelLoginQueue } from './login-queue.js'
import { sdk } from './ags-client.js'
import { extendFetch } from './extend-client.js'
import { installSessionKeepAlive, refreshIfStale, scheduleProactiveRefresh, subscribeAccessTokenRefresh } from './session.js'
import { fetchPendingLegalDocuments, fetchAcceptedLegalDocuments, fetchLegalAttachment, acceptLegalDocuments } from './legal.js'
import { parseLegalMarkdown } from './legal-markdown.mjs'
import { initStats, fetchStats, fetchLeaderboardPlayerStats, incrementStat, fetchMatchHistory, recordMatchHistory, fetchStreak, updateStreak, migrateStreakFromCloudSave, recordEloResult } from './stats.js'
import { sendEvent, flushPendingEvents, captureUtm, clearPendingEvents } from './telemetry.js'
import { readPrivacyPreferences, writePrivacyPreferences } from './privacy-preferences.mjs'
import { fetchTopRankings, fetchUserRank, resolveDisplayNames, enrichDisplayNames, cacheDisplayName, fetchInviterName, LEADERBOARD_VIEWS } from './leaderboard.js'
import { computeMatchStats, summarizeCoachingGrades, combineCoachingSummaries } from './match-stats.mjs'
import { deriveMatchRoles, computeDeadline, isPastDeadline, isResumable, pickAuthoritativeMoves } from './match-resume.mjs'
import { fetchFriendState, requestFriend, acceptFriend, rejectFriend, cancelFriendRequest, getFriendshipStatus, addFriendByEmail, storePendingInvite, processIncomingInviteAcceptances } from './friends.js'
import { formatCoins, accountDeletionNotices } from './club-contract.mjs'
import { deriveHighFiveButton, formatKudosCount } from './kudos-contract.mjs'
import { setPresenceStatus, disconnectPresence, pausePresence, resumePresence, refreshPresenceConnection, refreshPresenceToken, signOutPresence, subscribePresenceUpdates, subscribeGameInvites, subscribeLobbyOpen, sendGameInvite, subscribeInviteJoins, sendInviteJoinNotification, subscribeFriendsChanges } from './presence.js'
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
  getReportTicketId,
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

function createFeatureLoader(label, importer) {
  let loadedModule = null
  let pendingImport = null
  return {
    peek: () => loadedModule,
    load() {
      if (loadedModule) return Promise.resolve(loadedModule)
      if (!pendingImport) {
        pendingImport = importer().then(module => {
          loadedModule = module
          return module
        }).catch(error => {
          pendingImport = null
          console.warn(`[lazy] ${label} failed to load:`, error?.message || error)
          throw error
        })
      }
      return pendingImport
    },
  }
}

const achievementsFeature = createFeatureLoader('Achievements', () => import('./achievements.js'))
const spectatorFeature = createFeatureLoader('Spectator', () => import('./spectator.js'))
const matchmakingFeature = createFeatureLoader('Matchmaking', () => import('./matchmaking.js'))
const gusFeature = createFeatureLoader('Gambit Gus', () => import('./gus.js'))
const journalFeature = createFeatureLoader('Journal', () => import('./journal.js'))
const clubFeature = createFeatureLoader('Chess Club', () => import('./club.js'))
const coinStoreFeature = createFeatureLoader('Coin Store', () => import('./coin-store.js'))
const kudosFeature = createFeatureLoader('High Five', () => import('./kudos.js'))
const familyFeature = createFeatureLoader('Family', () => import('./family.js'))

const primeUnlockedCache = async (...args) => (await achievementsFeature.load()).primeUnlockedCache(...args)
const diffNewlyUnlocked = async (...args) => (await achievementsFeature.load()).diffNewlyUnlocked(...args)
const unlockEventAchievement = async (...args) => (await achievementsFeature.load()).unlockEventAchievement(...args)
const fetchMergedAchievements = async (...args) => (await achievementsFeature.load()).fetchMergedAchievements(...args)
function clearUnlockedCache() {
  try { localStorage.removeItem('ags-achievements-unlocked') } catch {}
  achievementsFeature.peek()?.clearUnlockedCache()
}

const publishLiveMatch = async (...args) => (await spectatorFeature.load()).publishLiveMatch(...args)
const clearLiveMatch = async (...args) => (await spectatorFeature.load()).clearLiveMatch(...args)
const fetchLiveMatch = async (...args) => (await spectatorFeature.load()).fetchLiveMatch(...args)
const fetchLiveMatchStrict = async (...args) => (await spectatorFeature.load()).fetchLiveMatchStrict(...args)
const resolveMatchForfeit = async (...args) => (await spectatorFeature.load()).resolveMatchForfeit(...args)
let spectatorWatchGeneration = 0
function startWatching(...args) {
  const generation = ++spectatorWatchGeneration
  void spectatorFeature.load().then(module => {
    if (generation === spectatorWatchGeneration) module.startWatching(...args)
  }).catch(error => {
    const status = document.getElementById('spectator-status')
    if (generation === spectatorWatchGeneration && status) status.textContent = 'Could not load spectator mode.'
    console.warn('[spectator] startup failed:', error?.message || error)
  })
}
function stopWatching() {
  spectatorWatchGeneration++
  spectatorFeature.peek()?.stopWatching()
}

async function startMatchmaking(...args) {
  try {
    return await (await matchmakingFeature.load()).startMatchmaking(...args)
  } catch (error) {
    args[2]?.('Matchmaking could not start. Check your connection and try again.')
    console.warn('[matchmaking] startup failed:', error?.message || error)
    return null
  }
}
async function cancelMatchmaking(...args) {
  try {
    return await (await matchmakingFeature.load()).cancelMatchmaking(...args)
  } catch (error) {
    console.warn('[matchmaking] cancellation failed:', error?.message || error)
    return null
  }
}

async function initGusPanel(...args) {
  try { return await (await gusFeature.load()).initGusPanel(...args) }
  catch { return null }
}
function resetGusPanel() { gusFeature.peek()?.resetGusPanel() }
async function openGusProfile(...args) {
  if (typeof window.showScreen === 'function') window.showScreen('gus')
  const status = document.getElementById('gus-profile-status')
  if (status) {
    status.textContent = 'Loading Gus’s latest…'
    status.style.display = ''
  }
  try { return await (await gusFeature.load()).openGusProfile(...args) }
  catch { if (status) status.textContent = 'Could not load Gus right now. Try again.' }
}
const refreshGusProfile = async (...args) => (await gusFeature.load()).refreshGusProfile(...args)
const showGusTab = async (...args) => (await gusFeature.load()).showGusTab(...args)
async function startGusMatchmakingFlow(...args) {
  try {
    return await (await gusFeature.load()).startGusMatchmaking(...args)
  } catch (error) {
    args[2]?.('Gambit Gus could not join right now. Try again in a moment.')
    console.warn('[gus] matchmaking startup failed:', error?.message || error)
    return null
  }
}

let preparedJournalRender = null
let journalRenderGeneration = 0
function prepareJournalTab(userId, matchHistory, options) {
  preparedJournalRender = { userId, matchHistory, options, generation: ++journalRenderGeneration }
}
async function renderPreparedJournalTab() {
  const request = preparedJournalRender
  if (!request) return
  const list = document.getElementById('journal-entries')
  if (list) list.innerHTML = '<div class="profile-history-loading"><span></span><span></span><span></span></div>'
  try {
    const module = await journalFeature.load()
    if (request !== preparedJournalRender || request.generation !== journalRenderGeneration) return
    await module.renderJournalTab(request.userId, request.matchHistory, request.options)
  } catch (error) {
    if (request === preparedJournalRender && list) {
      list.innerHTML = '<div class="profile-history-empty"><strong>Journal unavailable</strong><span>Close your profile and try again.</span></div>'
    }
  }
}
function resetJournalState() {
  preparedJournalRender = null
  journalRenderGeneration++
  journalFeature.peek()?.resetJournalState()
}

function readStoredClubStatus() {
  try {
    const stored = JSON.parse(localStorage.getItem('chess-club-status-v1') || 'null')
    return stored?.status || null
  } catch {
    return null
  }
}
function getClubStatus() { return clubFeature.peek()?.getClubStatus() || readStoredClubStatus() }
function hasClub() { return !!getClubStatus()?.active }
function getCoins() { return getClubStatus()?.coins ?? 0 }
async function initClubPanel(...args) {
  try { return await (await clubFeature.load()).initClubPanel(...args) }
  catch { return null }
}
async function openClubScreen(...args) {
  if (typeof window.showScreen === 'function') window.showScreen('club')
  const status = document.getElementById('club-status-line')
  if (status) status.textContent = 'Loading…'
  try { return await (await clubFeature.load()).openClubScreen(...args) }
  catch { if (status) status.textContent = 'Could not load Club. Try again in a moment.' }
}
const refreshClubManageAction = async (...args) => (await clubFeature.load()).refreshClubManageAction(...args)
const triggerRestorePurchases = async (...args) => (await clubFeature.load()).triggerRestorePurchases(...args)
const giveCoins = async (...args) => (await clubFeature.load()).giveCoins(...args)
const initNativeIAP = async (...args) => (await clubFeature.load()).initNativeIAP(...args)
function consumeClubReturnParams() {
  if (!new URLSearchParams(window.location.search).has('club')) return
  void clubFeature.load().then(module => module.consumeClubReturnParams()).catch(() => {})
}
function resetClubStatus() {
  if (clubFeature.peek()) clubFeature.peek().resetClubStatus()
  else {
    try { localStorage.removeItem('chess-club-status-v1') } catch {}
    const panel = document.getElementById('ags-club-panel')
    if (panel) panel.style.display = 'none'
  }
}

async function initCosmetics(...args) {
  try { return await (await coinStoreFeature.load()).initCosmetics(...args) }
  catch { return null }
}
async function loadCoinStore(...args) {
  const grid = document.getElementById('coin-store-grid')
  if (grid) grid.innerHTML = '<div class="profile-history-loading"><span></span><span></span><span></span></div>'
  try { return await (await coinStoreFeature.load()).loadCoinStore(...args) }
  catch {
    if (grid) grid.innerHTML = '<div class="profile-history-empty"><strong>Store unavailable</strong><span>Close and try again.</span></div>'
    return null
  }
}
function getEquippedFlairBadge() { return coinStoreFeature.peek()?.getEquippedFlairBadge() || null }
function triggerVictoryEffect() { coinStoreFeature.peek()?.triggerVictoryEffect() }
function resetCosmetics() {
  if (coinStoreFeature.peek()) coinStoreFeature.peek().resetCosmetics()
  else {
    for (const className of [...document.body.classList]) {
      if (className.startsWith('board-theme-') || className.startsWith('piece-set-')) {
        document.body.classList.remove(className)
      }
    }
  }
}

const sendHighFive = async (...args) => (await kudosFeature.load()).sendHighFive(...args)
function hasSentHighFive(matchId) { return kudosFeature.peek()?.hasSentHighFive(matchId) || false }

const fetchFamilyState = async (...args) => (await familyFeature.load()).fetchFamilyState(...args)
const createFamilyGroup = async (...args) => (await familyFeature.load()).createFamilyGroup(...args)
const inviteToFamily = async (...args) => (await familyFeature.load()).inviteToFamily(...args)
const acceptFamilyInvite = async (...args) => (await familyFeature.load()).acceptFamilyInvite(...args)
const rejectFamilyInvite = async (...args) => (await familyFeature.load()).rejectFamilyInvite(...args)
const removeFamilyMember = async (...args) => (await familyFeature.load()).removeFamilyMember(...args)
const leaveFamily = async (...args) => (await familyFeature.load()).leaveFamily(...args)
const recordParentalConsent = async (...args) => (await familyFeature.load()).recordParentalConsent(...args)
function familyTransportAvailable() {
  return !!import.meta.env.DEV || !!import.meta.env.VITE_EXTEND_EMAIL_URL
}

if (import.meta.env.DEV) {
  // Keep the existing offline test seam available before the Journal chunk is
  // requested; page.evaluate awaits the returned Promise automatically.
  window.agsRenderJournalForTesting = async (userId, matchHistory, options) => {
    const module = await journalFeature.load()
    module.resetJournalState()
    return module.renderJournalTab(userId, matchHistory, options)
  }
  for (const name of [
    'agsClubStatusForTesting',
    'agsClubNativeIAPReadyForTesting',
    'agsRenderClubForTesting',
    'agsSetClubNativeIAPReadyForTesting',
    'agsSetClubNativePurchaseStoreForTesting',
    'agsAppleTransactionIdForTesting',
    'agsSimulateNativeTransactionForTesting',
  ]) {
    const shim = async (...args) => {
      if (name === 'agsRenderClubForTesting' && args[0]) {
        try {
          localStorage.setItem('chess-club-status-v1', JSON.stringify({ status: args[0], ts: Date.now() }))
        } catch {}
      }
      await clubFeature.load()
      const implementation = window[name]
      if (implementation === shim) throw new Error(`${name} was not installed by the Club module`)
      return implementation(...args)
    }
    window[name] = shim
  }
}
const nativeVideoCallAudio = registerPlugin('VideoCallAudio')
let realtimeRuntimePromise = null

// PeerJS and the video runtime are unnecessary for guests, local games, and
// most Home sessions. Load them only when an online flow begins; app.js starts
// this during color selection, which overlaps the fetch with the player's taps.
async function prepareRealtimeRuntime() {
  if (window.chessVideoCall?.runtimeReady) return window.chessVideoCall
  if (!realtimeRuntimePromise) {
    realtimeRuntimePromise = Promise.all([
      import('peerjs'),
      import('./video-call.mjs'),
    ]).then(([peerModule, videoModule]) => {
      const Peer = peerModule.Peer
      window.Peer = Peer
      const runtime = videoModule.createVideoCallRuntime({
        Peer,
        iceConfigUrl: import.meta.env.VITE_RTC_ICE_CONFIG_URL || '',
        getAccessToken: () => sdk.getToken()?.accessToken || '',
        nativeAudio: nativeVideoCallAudio,
        isNativeIOS: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios',
      })
      // Preserve a peer factory injected while the chunk was loading (the
      // same seam is useful for reconnect tests and native wrappers).
      window.chessVideoCall = {
        ...runtime,
        ...(window.chessVideoCall || {}),
        runtimeReady: true,
      }
      return window.chessVideoCall
    }).catch(error => {
      realtimeRuntimePromise = null
      throw error
    })
  }
  return realtimeRuntimePromise
}

window.agsPrepareRealtimeRuntime = prepareRealtimeRuntime
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
  if (chatClient.snapshot().connected) {
    void chatClient.refreshToken(accessToken).then(refreshed => {
      if (!refreshed) console.warn('[Chat] token handoff missed; reconnecting with the new token')
    }).catch(error => {
      console.warn('[Chat] token refresh handoff failed:', error?.message || error)
    })
  }
  void refreshPresenceToken(accessToken).then(refreshed => {
    if (!refreshed) console.warn('[AGS presence] token handoff missed; reconnecting with the new token')
  }).catch(error => {
    console.warn('[AGS presence] token refresh handoff failed:', error?.message || error)
  })
})

window.agsPrepareSessionChat = () => chatClient.prepareSessionChat()
// Chat is limited to friends and family — it's a private channel, and casual
// opponents (random matchmaking, the cold-start bot) are strangers by
// default. Peers whose identity can't be established count as strangers.
// The rejection message surfaces through app.js's normal chat-unavailable
// path; the match itself is unaffected. (This also covers the stricter
// COPPA rule for protected child sessions, since a child's friend list is
// already restricted to family elsewhere in the app.)
async function chatPeerGuardError(otherUserId) {
  if (!otherUserId) return new Error('Chat requires both players to be signed in.')
  const isFamilyMember = familyState.members.some(m => m.userId === otherUserId)
  if (isFamilyMember) return null
  const isFriend = await window.agsIsFriendWith(otherUserId)
  return isFriend ? null : new Error('Chat is only available with friends and family.')
}
window.agsActivateSessionChat = async (sessionId, opponentUserId) => {
  const guardError = await chatPeerGuardError(opponentUserId)
  if (guardError) return Promise.reject(guardError)
  return chatClient.activateSessionChat(sessionId)
}
window.agsActivatePersonalChat = async otherUserId => {
  const guardError = await chatPeerGuardError(otherUserId)
  if (guardError) return Promise.reject(guardError)
  return chatClient.activatePersonalChat(otherUserId)
}
window.agsSendChatMessage = message => chatClient.send(message)
window.agsDeactivateChat = () => chatClient.deactivateTopic()
window.agsGetChatState = () => chatClient.snapshot()

const STATIC_ACTIONS = new Set([
  'acceptFriendMatchInvite',
  'acceptRematch',
  'acceptVideoCall',
  'addContact',
  'backFromContacts',
  'blockCurrentOpponent',
  'cancelWaiting',
  'closeModal',
  'closeSafetyReport',
  'coachPlayOn',
  'coachTakeBack',
  'confirmGoHome',
  'confirmNewGame',
  'copyInviteLink',
  'declineFriendMatchInvite',
  'declineRematch',
  'declineVideoCall',
  'endVideoChat',
  'flipBoard',
  'handleChatInputKeydown',
  'hideAddContact',
  'openJournalFromGameOver',
  'openMatchSafety',
  'playAgainFromGameOver',
  'reportCurrentOpponent',
  'requestRematch',
  'resetLeaderboard',
  'resignGame',
  'selectColor',
  'sendChatMessage',
  'sendHighFive',
  'shareInviteLink',
  'showAddContact',
  'showColorSelect',
  'showContactsForInvite',
  'showHint',
  'showMatchTab',
  'showScreen',
  'toggleCoachMode',
  'startGusMatchmaking',
  'startNewGame',
  'startRandomMatchmaking',
  'startVideoChat',
  'startVsComputer',
  'submitSafetyReport',
  'toggleAudio',
  'toggleVideoFeed',
  'agsAcceptLegal',
  'agsAddFriendByEmail',
  'agsCancelEdit',
  'agsCancelLoginQueue',
  'agsChooseAnalytics',
  'agsClubManageSubscription',
  'agsClubRestorePurchases',
  'agsCloseAchievements',
  'agsCloseCoinStore',
  'agsCloseDeleteAccount',
  'agsCloseOfflineFriends',
  'agsCloseLeaderboardOverlay',
  'agsClosePrivacyChoices',
  'agsCompletePasswordReset',
  'agsConfirmDeleteAccount',
  'agsCopyInviteLink',
  'agsCreateChildAccount',
  'agsCreateFamily',
  'agsDeclineLegal',
  'agsDiscardActiveMatch',
  'agsDismissFamilyNudge',
  'agsEditName',
  'agsLeaveFamily',
  'agsLogin',
  'agsLoginApple',
  'agsLogout',
  'agsOpenDeleteAccount',
  'agsOpenAchievements',
  'agsOpenForgotPassword',
  'agsOpenClub',
  'agsOpenCoinStore',
  'agsOpenGuestPlay',
  'agsOpenGusProfile',
  'agsOpenLegalDocument',
  'agsOpenJournal',
  'agsOpenLogin',
  'agsOpenMyProfile',
  'agsOpenOfflineFriends',
  'agsOpenPolicy',
  'agsOpenPrivacyChoices',
  'agsOpenRegister',
  'agsPasswordLogin',
  'agsPlayFamilyNudge',
  'agsProfileAddFriend',
  'agsProfileCancelEdit',
  'agsProfileEditName',
  'agsProfileSaveName',
  'agsRefreshFamily',
  'agsRefreshFriends',
  'agsRefreshGusProfile',
  'agsRegister',
  'agsRequestLastOpponent',
  'agsRequestPasswordReset',
  'agsResumeActiveMatch',
  'agsSaveName',
  'agsSavePrivacyChoices',
  'agsShowProfileTab',
  'agsShowGusTab',
  'agsSpectatorFirst',
  'agsSpectatorLast',
  'agsSpectatorNext',
  'agsSpectatorPrev',
  'agsStopWatching',
  'agsSwitchLeaderboardOverlayView',
  'agsSwitchLeaderboardView',
  'agsToggleAddChild',
  'agsToggleAddFriend',
  'agsToggleFamilyInvite',
  'agsUpdateDeleteConfirmation',
])

function parseStaticArgs(rawArgs, event) {
  const raw = String(rawArgs || '').trim()
  if (!raw) return []
  return raw.split(',').map(value => {
    const token = value.trim()
    if (token === 'event') return event
    if (token === 'true') return true
    if (token === 'false') return false
    const quoted = /^'([^']*)'$/.exec(token)
    if (quoted) return quoted[1]
    const number = Number(token)
    if (Number.isFinite(number)) return number
    throw new Error(`Unsupported static action argument: ${token}`)
  })
}

function runStaticCall(source, event, element) {
  const action = String(source || '').trim().replace(/;$/, '')
  if (!action) return
  if (action === "this.closest('#invite-join-toast').classList.remove('show')") {
    element.closest('#invite-join-toast')?.classList.remove('show')
    return
  }
  if (action === "this.closest('#club-toast').classList.remove('show')") {
    element.closest('#club-toast')?.classList.remove('show')
    return
  }

  let match = /^window\.([A-Za-z0-9_]+)\s*&&\s*window\.\1\((.*)\)$/.exec(action)
  if (!match) match = /^window\.([A-Za-z0-9_]+)\((.*)\)$/.exec(action)
  if (!match) match = /^([A-Za-z0-9_]+)\((.*)\)$/.exec(action)
  if (!match) throw new Error(`Unsupported static action: ${action}`)

  const [, name, rawArgs] = match
  if (!STATIC_ACTIONS.has(name) || typeof window[name] !== 'function') {
    throw new Error(`Blocked static action: ${name}`)
  }
  window[name](...parseStaticArgs(rawArgs, event))
}

function runStaticAction(source, event, element) {
  const action = String(source || '').trim()
  if (action.startsWith('event.preventDefault();')) {
    event.preventDefault()
    runStaticAction(action.slice('event.preventDefault();'.length), event, element)
    return
  }

  if (action.startsWith('if(event.key===')) {
    const keyPattern = /if\(event\.key==='([^']+)'(?:\|\|event\.key==='([^']+)')?\)\s*([^;]+(?:;|$))/g
    for (const match of action.matchAll(keyPattern)) {
      const [, firstKey, secondKey, callSource] = match
      if (event.key === firstKey || event.key === secondKey) {
        runStaticCall(callSource.replace(/;$/, ''), event, element)
      }
    }
    return
  }

  runStaticCall(action, event, element)
}

function bindStaticActions(root = document) {
  for (const element of root.querySelectorAll('[data-click]')) {
    element.addEventListener('click', event => runStaticAction(element.dataset.click, event, element))
  }
  for (const element of root.querySelectorAll('[data-keydown]')) {
    element.addEventListener('keydown', event => runStaticAction(element.dataset.keydown, event, element))
  }
  for (const element of root.querySelectorAll('[data-submit]')) {
    element.addEventListener('submit', event => runStaticAction(element.dataset.submit, event, element))
  }
  for (const element of root.querySelectorAll('[data-input]')) {
    element.addEventListener('input', event => runStaticAction(element.dataset.input, event, element))
  }
}

bindStaticActions()

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
let currentProfile = null  // hydrated IAM profile — needed for child-session (COPPA) checks
let currentUserWins = 0
let currentStreak = 0
let currentUserRating = 1200
let currentLeaderboardView = 'rating'
let pendingOpponentRating = null  // received from the opponent over the peer connection for the in-progress online match
let seenIncomingRequestIds = null  // null until first friends load — avoids notifying for pre-existing requests
let pendingLegalDocuments = []
let pendingLegalProfile = null
let reviewedLegalDocumentIds = new Set()
let acceptedLegalDocuments = []
let activeLegalReaderDocument = null
let legalReaderTrigger = null
let friendsState = { friends: [], incoming: [], outgoing: [] }
let familyState = { group: null, members: [], incomingInvites: [] }
let friendsRefreshTimer = null
let friendsVisibilityHandler = null
let friendsRefreshPromise = null
let friendsRefreshQueued = false
let friendsRefreshQueuedPreserveMessage = false
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
let spectatorReturnProfileTab = ''
let profileMatchHistoryRows = []
let blockedPlayers = []
let deletionRequirements = null

function isGambitGusIdentity(userId, displayName = '') {
  const normalizedUserId = String(userId || '').trim().toLowerCase()
  const normalizedDisplayName = String(displayName || '').trim().toLowerCase()
  const knownUserId = String(window.agsGambitGusUserId || '').trim().toLowerCase()
  const knownName = String(window.agsGambitGusName || 'Gambit Gus').trim().toLowerCase()
  return normalizedUserId === 'gambit-gus'
    || (knownUserId && normalizedUserId === knownUserId)
    || normalizedDisplayName === knownName
}

window.isGambitGusIdentity = isGambitGusIdentity

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
  const childSession = isProtectedChildSession()
  document.body?.classList.toggle('privacy-choice-pending', !preferences.decided && !childSession)
  if (toggle) {
    toggle.checked = childSession ? false : preferences.analytics
    toggle.disabled = childSession
  }
  if (status) {
    status.textContent = childSession
      ? 'Analytics stays off on this protected account.'
      : preferences.decided
        ? `Optional analytics are ${preferences.analytics ? 'enabled' : 'disabled'}.`
        : 'You have not made a privacy choice yet.'
  }
  // A child session never sees the consent banner — there is nothing to opt
  // in to.
  if (banner) banner.hidden = preferences.decided || childSession
}

async function saveAnalyticsPreference(analytics) {
  // Protected child sessions can never opt in to analytics (COPPA) — the
  // preference is pinned off no matter which UI path tries to set it.
  if (analytics && isProtectedChildSession()) analytics = false
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
    const response = await extendFetch('/referral', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviterUserId: inviter }),
    })
    if (!response.ok) {
      console.warn('[referral] report rejected:', response.status)
      // Validation failures cannot improve on retry; transient/service errors
      // retain the session marker so a later hydration can try again.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        sessionStorage.removeItem('chess_invite_by')
      }
      return
    }
    sendEvent('referral_reported', { inviter_user_id: inviter })
    sessionStorage.removeItem('chess_invite_by')
  } catch (error) {
    console.warn('[referral] report unavailable:', error?.message || error)
  }
}

async function sendInviteEmail({ to, fromName, inviteLink }) {
  if (!to || !inviteLink) return { ok: false, error: 'Email and invite link are required.' }
  try {
    const response = await extendFetch('/invite/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from_name: fromName || 'A friend', invite_link: inviteLink }),
    })
    if (response.ok) return { ok: true }
    const payload = await response.json().catch(() => ({}))
    return {
      ok: false,
      error: response.status === 429
        ? 'Too many invite emails were sent. Try again later.'
        : (payload?.errorMessage || payload?.message || payload?.error || 'Could not send the invite email.'),
    }
  } catch (error) {
    console.warn('[invite] email delivery failed:', error?.message || error)
    return { ok: false, error: 'Could not reach the email service. Check your connection and try again.' }
  }
}

// app.js is a classic script, so expose the authenticated/refreshing transport
// as a narrow bridge instead of letting it make a second raw Extend fetch.
window.agsSendInviteEmail = sendInviteEmail

// Send the new player a welcome email via the Extend service. Best-effort:
// runs after a successful email/password registration and never blocks signup.
async function sendWelcomeEmail(emailAddress, displayName) {
  if (!emailAddress || !sdk.getToken()?.accessToken) return
  try {
    const response = await extendFetch('/welcome/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: emailAddress, display_name: displayName || '' }),
    })
    if (!response.ok) {
      console.warn('[welcome] email delivery rejected:', response.status)
      return
    }
    sendEvent('welcome_email_sent', { method: 'email' })
  } catch (error) {
    console.warn('[welcome] email delivery unavailable:', error?.message || error)
  }
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
    hideX = false,
    nativeLabel = '📤 More…',
    title = '',
    description = '',
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

  if (title || description) {
    const intro = document.createElement('div')
    intro.className = 'share-row-intro'
    if (title) {
      const heading = document.createElement('strong')
      heading.className = 'share-row-title'
      heading.textContent = title
      intro.appendChild(heading)
    }
    if (description) {
      const copy = document.createElement('p')
      copy.className = 'share-row-copy'
      copy.textContent = description
      intro.appendChild(copy)
    }
    containerEl.appendChild(intro)
  }

  const row = document.createElement('div')
  row.className = 'share-row'
  const emailStatus = emailTo ? document.createElement('p') : null
  if (emailStatus) {
    emailStatus.className = 'share-row-status'
    emailStatus.setAttribute('role', 'status')
    emailStatus.setAttribute('aria-live', 'polite')
  }

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

  if (!hideX) {
    const tw = document.createElement('a')
    tw.className = 'share-chip share-chip-x'
    tw.href = `https://x.com/intent/tweet?text=${enc(xText)}&url=${enc(twitterUrl)}`
    tw.target = '_blank'
    tw.rel = 'noopener'
    tw.textContent = '𝕏 Post'
    tw.addEventListener('click', () => fire('twitter'))
    row.appendChild(tw)
  }

  if (emailTo) {
    const emailBtn = document.createElement('button')
    emailBtn.className = 'share-chip share-chip-email'
    emailBtn.textContent = '✉️ Email'
    emailBtn.addEventListener('click', async () => {
      emailBtn.disabled = true
      emailBtn.textContent = 'Sending…'
      const result = await sendInviteEmail({ to: emailTo, fromName, inviteLink: emailUrl })
      if (result.ok) {
        fire('email')
        emailStatus.textContent = `Invite email sent to ${emailTo}.`
        emailStatus.classList.remove('error')
        emailBtn.textContent = '✅ Sent!'
        setTimeout(() => {
          emailBtn.textContent = '✉️ Email'
          emailBtn.disabled = false
          emailStatus.textContent = ''
        }, 3000)
      } else {
        emailStatus.textContent = result.error
        emailStatus.classList.add('error')
        emailBtn.textContent = '↻ Retry email'
        emailBtn.title = result.error
        emailBtn.setAttribute('aria-label', `${result.error} Retry email`)
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
    nativeBtn.textContent = nativeLabel
    nativeBtn.addEventListener('click', () => {
      const nativeUrl = addUtm(url, 'native', campaign)
      navigator.share({ title: "Ethan's Chess", text: gameTextFor(nativeUrl), url: nativeUrl }).catch(() => {})
      fire('native_share')
    })
    row.appendChild(nativeBtn)
  }

  containerEl.appendChild(row)
  if (emailStatus) containerEl.appendChild(emailStatus)
  return row
}

// live=true means this landing came from a live-match link (?peer=) — the
// gate requires a signed-in account before the player can join.
// live=false is the referral-only link (?invitedBy=), unchanged: account
// creation is the primary CTA since there's no match waiting to join.
function showInviteScreen(inviterName, { live = false } = {}) {
  const titleEl = document.getElementById('invite-landing-title')
  const subEl = document.getElementById('invite-landing-sub')
  if (titleEl) {
    titleEl.textContent = inviterName
      ? (live ? `${inviterName} is waiting for you!` : `${inviterName} challenged you to chess!`)
      : (live ? 'Your friend is waiting for you!' : 'A friend challenged you to chess!')
  }
  if (subEl) {
    subEl.textContent = live
      ? 'Sign in or create an account to join this live match.'
      : 'Create a free account to accept the challenge and start playing.'
  }
  const defaultActions = document.getElementById('invite-landing-actions-default')
  const defaultDivider = document.getElementById('invite-landing-divider-default')
  const defaultSignin = document.getElementById('invite-landing-signin-default')
  const liveActions = document.getElementById('invite-landing-actions-live')
  if (defaultActions) defaultActions.style.display = live ? 'none' : ''
  if (defaultDivider) defaultDivider.style.display = live ? 'none' : ''
  if (defaultSignin) defaultSignin.style.display = live ? 'none' : ''
  if (defaultSignin) {
    const defaultAppleBtn = document.getElementById('invite-default-apple')
    if (defaultAppleBtn) defaultAppleBtn.style.display = (!live && window.Capacitor?.isNativePlatform?.()) ? '' : 'none'
  }
  if (liveActions) {
    liveActions.style.display = live ? '' : 'none'
    const appleBtn = document.getElementById('invite-live-apple')
    if (appleBtn) appleBtn.style.display = (live && window.Capacitor?.isNativePlatform?.()) ? '' : 'none'
  }
  if (typeof window.showScreen === 'function') window.showScreen('invite')
}

async function hydrateAuthenticatedUser(profile) {
  const hydratedUserId = profile.userId
  currentUserId = profile.userId
  currentProfile = profile
  window.agsCurrentUserId = currentUserId
  // Child sessions never store an email (COPPA data minimization — the
  // address on a parent-created account is the parent's mailbox anyway).
  const userEmail = profile.emailAddress || ''
  if (userEmail && !isChildSession({ profile })) {
    localStorage.setItem('chess_user_email', userEmail)
    window.agsCurrentUserEmail = userEmail
  }
  void refreshAcceptedLegalDocuments()
  connectAuthenticatedChat().catch(error => {
    console.warn('[Chat] connection unavailable:', error?.message || error)
  })
  // Telemetry delivery is never part of the first authenticated paint.
  void flushPendingEvents().catch(error => {
    console.warn('[telemetry] queued-event flush unavailable:', error?.message || error)
  })
  const name = getDisplayName(profile)
  cacheDisplayName(currentUserId, name)
  syncBasicProfile(name)
  if (typeof window.setPlayerFromAGS === 'function') {
    window.setPlayerFromAGS(name)
  }
  updateAuthUI(true, name, currentUserId)
  // Authentication and the legal gate are the only prerequisites for Home.
  // Present it before starting any social/statistics/optional-feature hydration.
  if (typeof window.showScreen === 'function') window.showScreen('home')
  setPresenceStatus('online')
  startPresenceUpdates()
  startGameInviteUpdates()
  startInviteJoinUpdates()
  startFriendsChangeUpdates()
  startFriendsRefresh()
  setFriendsMessage('Loading friends…')
  void refreshFriendsUI(false)
  void listBlockedPlayers().then(players => {
    if (currentUserId === hydratedUserId) blockedPlayers = players
  }).catch(error => {
    if (currentUserId === hydratedUserId) blockedPlayers = []
    console.warn('[AGS safety] blocked-player list unavailable:', getSafetyError(error))
  })

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
        void sendInviteJoinNotification({
          to: invitedBy,
          fromUserId: currentUserId,
          fromName: name,
        }).then(result => {
          if (result?.ok) return
          sessionStorage.removeItem(notifKey)
          console.warn('[invite] join notification was not delivered:', result?.error || 'unknown error')
        }).catch(error => {
          sessionStorage.removeItem(notifKey)
          console.warn('[invite] join notification failed:', error?.message || error)
        })
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

  const randomBtn = document.getElementById('btn-play-random')
  if (randomBtn) randomBtn.style.display = ''
  const leaderboardList = document.getElementById('lb-list')
  if (leaderboardList) leaderboardList.innerHTML = '<p class="lb-empty">Loading leaderboard…</p>'

  // Stats have a small internal dependency chain, but the entire chain is
  // secondary to showing Home. It runs concurrently with friends and safety.
  void (async () => {
    await initStats(hydratedUserId)
    if (currentUserId !== hydratedUserId) return
    await migrateStreakFromCloudSave(hydratedUserId)
    if (currentUserId !== hydratedUserId) return
    const [stats, streakData] = await Promise.all([
      fetchStats(hydratedUserId),
      fetchStreak(hydratedUserId),
    ])
    if (currentUserId !== hydratedUserId) return
    currentUserWins = stats?.wins ?? 0
    currentStreak = streakData?.streak ?? 0
    currentUserRating = stats?.rating ?? 1200
    updateStatsUI(stats, currentStreak)
    void primeUnlockedCache(hydratedUserId)
    await refreshLeaderboard()
    if (currentUserId === hydratedUserId) sendEvent('leaderboard_viewed', { trigger: 'session_start' })
  })().catch(error => {
    console.warn('[AGS] background stats hydration failed:', error?.message || error)
    if (currentUserId === hydratedUserId && leaderboardList) {
      leaderboardList.innerHTML = '<p class="lb-empty">Leaderboard unavailable — tap Refresh to retry.</p>'
    }
  })
  // Gus's home card + play button (fire-and-forget: a slow/absent Extend
  // service must not delay session hydration — Gus just stays hidden).
  void initGusPanel()
  // Club home card (fire-and-forget, same reasoning as Gus above).
  void initClubPanel(isProtectedChildSession())
  // Loads + applies equipped cosmetics (board theme, piece set, flair) —
  // fire-and-forget, same reasoning as Gus/Club above.
  void initCosmetics(currentUserId)
  // Returning from a Stripe checkout redirect (?club=success|cancel).
  consumeClubReturnParams()
  window.agsCheckResumableMatch?.()  // any unfinished online match from before a disconnect/reload?
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

    // The in-app reader fetches the attachment from AGS's CloudFront CDN,
    // which doesn't send CORS headers — fine on native (CapacitorHttp is a
    // native HTTP client, not subject to browser CORS) but always fails as a
    // browser fetch() on web. Open externally there instead, same as before
    // the in-app reader existed.
    const isNative = !!window.Capacitor?.isNativePlatform?.()
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'btn btn-secondary legal-review-button'
    action.textContent = doc.attachmentLocation ? (isNative ? 'Read in app' : 'Open document') : 'Document unavailable'
    action.disabled = !doc.attachmentLocation
    if (doc.attachmentLocation) {
      if (isNative) {
        action.addEventListener('click', () => openLegalReader(doc, action))
      } else {
        action.addEventListener('click', async () => {
          action.disabled = true
          const opened = await openExternalURL(doc.attachmentLocation)
          action.disabled = false
          if (!opened) {
            setLegalMessage('The document could not be opened. Check your connection and try again.', 'error')
            return
          }
          reviewedLegalDocumentIds.add(doc.localizedPolicyVersionId)
          action.textContent = 'Reviewed'
          action.classList.add('reviewed')
          status.textContent = 'Reviewed'
          card.classList.add('reviewed')
          setLegalMessage('')
          updateLegalAcceptanceState()
        })
      }
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
  // A live-match invite link (?peer=) that required signing in first — now that
  // we have an account, join the match instead of just landing on home. Covers
  // Google's full-page redirect too, since the id survives in sessionStorage.
  const pendingPeerId = sessionStorage.getItem('chess_pending_peer')
  if (pendingPeerId) {
    sessionStorage.removeItem('chess_pending_peer')
    window.history.replaceState({}, '', window.location.pathname + window.location.hash)
    window.agsJoinPeer?.(pendingPeerId)
  }
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
  // Expose the send function to non-module scripts (app.js) up front, not just
  // after login — sendEvent() already gates on consent and queues pre-auth
  // events, so guest play (which never authenticates) still needs this to
  // fire game_started/game_completed/matchmaking_* events.
  window.agsSendEvent = (name, payload) => sendEvent(name, payload)
  // One anchor event per browser session (DAU / session counts / retention).
  // Queued pre-auth, so guest sessions that later sign in are captured too;
  // guests who never authenticate can't deliver protected events at all.
  try {
    if (!sessionStorage.getItem('chess_session_evt')) {
      sessionStorage.setItem('chess_session_evt', '1')
      sendEvent('session_started', {})
    }
  } catch {}
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
  // Live match invite (?peer=<hostPeerId>). Like invitedBy, the Google OAuth
  // redirect wipes the URL, so stash it in sessionStorage and fall back to
  // that ONLY on the callback page load — otherwise a friend who signs in
  // with Google from this screen never actually joins the match they
  // clicked. A fresh, non-callback visit with no ?peer= clears any stale
  // value instead of falling back to it — otherwise an abandoned invite
  // visit earlier in the same tab session could silently join a later,
  // unrelated page load into the wrong (or long-gone) match.
  const peerParam = params.get('peer')
  if (peerParam) {
    sessionStorage.setItem('chess_pending_peer', peerParam)
  } else if (!hasCallback) {
    sessionStorage.removeItem('chess_pending_peer')
  }
  const pendingPeerId = peerParam || (hasCallback ? sessionStorage.getItem('chess_pending_peer') : null)

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
      currentProfile = null
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
    currentProfile = null
    window.agsCurrentUserId = null
    chatClient.disconnect()
    updateAuthUI(false, null, null)
    updateStatsUI(null)
    refreshLeaderboard()
    if (inviteByParam || pendingPeerId) {
      const live = !!pendingPeerId
      showInviteScreen(null, { live })
      if (inviteByParam) {
        fetchInviterName(inviteByParam).then(name => {
          if (name) {
            const titleEl = document.getElementById('invite-landing-title')
            if (titleEl) titleEl.textContent = live ? `${name} is waiting for you!` : `${name} challenged you to chess!`
          }
        })
      }
    }
  }

  window.agsLogin = loginWithGoogle

  // Sign in with Apple (iOS only — shown by updateAuthUI on native, and on the
  // invite screen's live-match gate). Two buttons can be visible at once (home
  // + invite screen), so toggle every .btn-apple rather than one fixed id.
  window.agsLoginApple = async () => {
    const appleBtns = document.querySelectorAll('.btn-apple')
    appleBtns.forEach(btn => { btn.disabled = true })
    const result = await loginWithApple()
    appleBtns.forEach(btn => { btn.disabled = false })
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
    resetGusPanel()
    resetJournalState()
    resetClubStatus()
    resetCosmetics()
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
  // Swap the register form for the kid-friendly "ask a parent" panel and drop
  // everything the child typed — none of it is sent or kept.
  function showRegisterAskParent() {
    for (const id of ['ags-register-birth-year', 'ags-register-email', 'ags-register-display-name', 'ags-register-password']) {
      const field = document.getElementById(id)
      if (field) field.value = ''
    }
    const form = document.getElementById('ags-register-form')
    const askParent = document.getElementById('ags-register-ask-parent')
    if (form) form.style.display = 'none'
    if (askParent) askParent.style.display = ''
  }

  window.agsOpenRegister = () => {
    clearAuthMessages()
    if (typeof window.showScreen === 'function') window.showScreen('register')
    // Once the neutral age gate has said "under 13" this session, re-opening
    // the form doesn't offer a second try with a different year.
    if (sessionStorage.getItem('chess_age_gate') === '1') {
      showRegisterAskParent()
      return
    }
    const termsCheckbox = document.getElementById('ags-register-terms')
    if (termsCheckbox) termsCheckbox.checked = false
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

    // Only ever delivered if this visitor later signs in (protected events
    // need auth) — which is exactly the guest→register conversion signal.
    sendEvent('guest_mode_entered', {})
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
    // Age gate first — nothing else typed into the form is read, sent, or
    // kept until the year says the player can self-register. Under 13 the
    // whole form is cleared and the parent-managed path is shown instead
    // (COPPA: no personal information collected from the child).
    const birthYearCheck = validateBirthYear(document.getElementById('ags-register-birth-year')?.value)
    if (!birthYearCheck.ok) {
      setAuthMessage('register', birthYearCheck.error, 'error')
      return
    }
    if (isBirthYearUnder13(birthYearCheck.year)) {
      sessionStorage.setItem('chess_age_gate', '1')
      showRegisterAskParent()
      return
    }
    const emailAddress = document.getElementById('ags-register-email')?.value.trim() || ''
    const displayName = document.getElementById('ags-register-display-name')?.value.trim() || ''
    const passwordInput = document.getElementById('ags-register-password')
    const password = passwordInput?.value || ''
    const termsCheckbox = document.getElementById('ags-register-terms')
    const button = document.getElementById('ags-register-submit')
    if (!emailAddress || !displayName || !password) {
      setAuthMessage('register', 'Enter your email, display name, and a password.', 'error')
      return
    }
    if (!termsCheckbox?.checked) {
      setAuthMessage('register', 'Accept the Terms of Use and Community Standards to create an account.', 'error')
      termsCheckbox?.focus()
      return
    }
    if (button) button.disabled = true
    setAuthMessage('register', 'Creating account…')
    if (passwordInput) passwordInput.value = ''
    const created = await registerWithPassword({ emailAddress, displayName, password, reachMinimumAge: true })
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
  window.agsTriggerVictoryEffect = triggerVictoryEffect
  // Thin wrappers so app.js (a plain script, can't import ES modules) can
  // reach the pure eligibility logic + network call — same pattern as
  // window.isGambitGusIdentity. isBot/isBlocked/gameMode/recipientUserId
  // are read from app.js's own closure state (currentOpponent etc.) and
  // passed in fresh on every call, never cached here.
  window.agsHighFiveButtonState = opts => deriveHighFiveButton({
    ...opts,
    senderId: currentUserId,
    coins: getCoins(),
    alreadySent: hasSentHighFive(opts?.matchId),
  })
  window.agsSendHighFive = (matchId, recipientUserId) => sendHighFive(matchId, recipientUserId)
  window.agsFormatKudosCount = formatKudosCount
  window.agsStartMatchmaking = startMatchmaking
  window.agsCancelMatchmaking = cancelMatchmaking
  window.agsStartGusMatchmaking = startGusMatchmakingFlow
  window.agsOpenGusProfile = openGusProfile
  window.agsRefreshGusProfile = refreshGusProfile
  window.agsShowGusTab = showGusTab
  // Guest gate (dev-plan §11.5): signed-out sessions must never reach the
  // Club screen or trigger a /club/status call — the UI entry points are
  // already hidden for guests, this hard-guards direct invocation too.
  window.agsOpenClub = () => {
    if (!currentUserId) return
    openClubScreen(isProtectedChildSession())
  }
  window.agsClubManageSubscription = refreshClubManageAction
  window.agsClubRestorePurchases = triggerRestorePurchases
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
  window.agsRefreshFamily = refreshFamilyUI
  window.agsCreateFamily = async () => {
    const myName = document.getElementById('ags-signedin-name')?.textContent || 'My'
    setFamilyMessage('Creating your family...')
    const result = await createFamilyGroup(`${myName}'s Family`)
    if (!result.ok) {
      setFamilyMessage(result.error, 'error')
      return
    }
    setFamilyMessage('Family created — invite your family members!', 'success')
    await refreshFamilyUI(false)
    window.agsToggleFamilyInvite?.(true)
  }
  window.agsToggleFamilyInvite = forceOpen => {
    const picker = document.getElementById('ags-family-invite-picker')
    if (!picker) return
    const open = forceOpen === true || picker.style.display === 'none'
    picker.style.display = open ? '' : 'none'
    if (open) renderFamilyInvitePicker()
  }
  window.agsInviteToFamily = async userId => {
    if (!familyState.group) return
    ensureNotificationPermission()  // user gesture — ask now so they can be notified of the reply
    setFamilyMessage('Sending family invite...')
    const result = await inviteToFamily(userId, familyState.group.groupId)
    setFamilyMessage(result.ok ? 'Family invite sent.' : result.error, result.ok ? 'success' : 'error')
    if (result.ok) sendEvent('family_invite_sent', {})
  }
  window.agsAcceptFamilyInvite = async groupId => {
    setFamilyMessage('Joining family...')
    const result = await acceptFamilyInvite(groupId)
    if (!result.ok) {
      setFamilyMessage(result.error, 'error')
      return
    }
    setFamilyMessage('Welcome to the family!', 'success')
    sendEvent('family_invite_accepted', {})
    await refreshFamilyUI(false)
  }
  window.agsRejectFamilyInvite = async groupId => {
    const result = await rejectFamilyInvite(groupId)
    setFamilyMessage(result.ok ? 'Family invite declined.' : result.error, result.ok ? '' : 'error')
    if (result.ok) await refreshFamilyUI(false)
  }
  window.agsRemoveFamilyMember = async userId => {
    if (!familyState.group) return
    const member = familyState.members.find(m => m.userId === userId)
    if (!confirm(`Remove ${member?.displayName || 'this member'} from the family?`)) return
    const result = await removeFamilyMember(userId, familyState.group.groupId)
    setFamilyMessage(result.ok ? 'Family member removed.' : result.error, result.ok ? '' : 'error')
    if (result.ok) await refreshFamilyUI(false)
  }
  // Family allowance (dev-plan §6.8/§10): guardian → child coin gift. Uses
  // the same lightweight prompt()/setFamilyMessage() pattern as the other
  // family actions above rather than a new modal — this is a rare, low-
  // stakes action that doesn't warrant its own UI surface.
  window.agsGiveCoins = async userId => {
    if (!familyState.group) return
    const member = familyState.members.find(m => m.userId === userId)
    const name = member?.displayName || 'this child'
    const input = prompt(`Give how many coins to ${name}?`, '50')
    if (input === null) return
    const amount = Math.trunc(Number(input))
    if (!Number.isFinite(amount) || amount < 1) {
      setFamilyMessage('Enter a whole number of coins (1 or more).', 'error')
      return
    }
    try {
      const { guardianBalance } = await giveCoins(userId, amount)
      setFamilyMessage(`Gave ${amount} coins to ${name}. Your balance: ${formatCoins(guardianBalance)}.`)
    } catch (err) {
      setFamilyMessage(err.message || 'Could not give coins. Try again.', 'error')
    }
  }
  window.agsLeaveFamily = async () => {
    if (!familyState.group) return
    if (!confirm('Leave this family? A guardian can invite you back later.')) return
    const result = await leaveFamily(familyState.group.groupId)
    setFamilyMessage(result.ok ? 'You left the family.' : result.error, result.ok ? '' : 'error')
    if (result.ok) await refreshFamilyUI(false)
  }
  window.agsToggleAddChild = forceOpen => {
    const form = document.getElementById('ags-add-child-form')
    if (!form) return
    const open = forceOpen === true || form.style.display === 'none'
    form.style.display = open ? '' : 'none'
    const handoff = document.getElementById('ags-child-handoff')
    if (handoff && open) handoff.style.display = 'none'
    if (open) {
      // Prefill the consenting parent's own address (saved at sign-in).
      const emailField = document.getElementById('ags-child-parent-email')
      if (emailField && !emailField.value) {
        emailField.value = window.agsCurrentUserEmail || localStorage.getItem('chess_user_email') || ''
      }
      document.getElementById('ags-child-nickname')?.focus()
    }
  }
  // Parent-managed child account (COPPA): the guardian's signed-in session is
  // the consent act — recorded before the family invite goes out. Order
  // matters: account → consent record → invite, so there is never an invited
  // child without a stored consent.
  window.agsCreateChildAccount = async () => {
    const setMessage = (text, tone = '') => {
      const el = document.getElementById('ags-add-child-message')
      if (el) {
        el.className = `auth-message${tone ? ' ' + tone : ''}`
        el.textContent = text || ''
      }
    }
    if (!familyState.group) {
      setMessage('Create your family first, then add your child.', 'error')
      return
    }
    const nickname = document.getElementById('ags-child-nickname')?.value.trim() || ''
    const birthYearCheck = validateBirthYear(document.getElementById('ags-child-birth-year')?.value)
    const parentEmail = document.getElementById('ags-child-parent-email')?.value.trim() || ''
    const password = document.getElementById('ags-child-password')?.value || ''
    const consented = document.getElementById('ags-child-consent')?.checked === true
    if (!nickname || !parentEmail || !password) {
      setMessage('Fill in the nickname, your email, and a password.', 'error')
      return
    }
    if (!birthYearCheck.ok) {
      setMessage(birthYearCheck.error, 'error')
      return
    }
    if (password.length < 8) {
      setMessage('Pick a password of at least 8 characters.', 'error')
      return
    }
    if (!consented) {
      setMessage('Please confirm you are the parent or guardian and consent.', 'error')
      return
    }
    const button = document.getElementById('btn-add-child-submit')
    if (button) button.disabled = true
    setMessage('Creating the child account…')

    const created = await registerChildAccount({
      groupId: familyState.group.groupId,
      parentEmail,
      nickname,
      birthYear: birthYearCheck.year,
      password,
    })
    if (!created.ok) {
      if (button) button.disabled = false
      setMessage(created.error, 'error')
      return
    }

    const consent = buildConsentRecord({
      parentUserId: currentUserId,
      childUserId: created.userId,
      childName: created.displayName,
      birthYear: birthYearCheck.year,
    })
    const consentSaved = await recordParentalConsent(currentUserId, consent)

    const invited = await inviteToFamily(created.userId, familyState.group.groupId)
    if (button) button.disabled = false
    setMessage('')
    window.agsToggleAddChild(false)

    const handoff = document.getElementById('ags-child-handoff')
    if (handoff) {
      const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
      const inviteNote = invited.ok
        ? 'A family invite is waiting — it appears the moment they sign in.'
        : 'The family invite could not be sent automatically; use “Invite to Family” once they appear in your friends.'
      const consentNote = consentSaved.ok ? '' : `<p class="child-handoff-warn">${esc(consentSaved.error)}</p>`
      handoff.innerHTML = `
        <h4>♟️ ${esc(created.displayName)} is ready to play!</h4>
        <p>Have them sign in on their device with:</p>
        <p class="child-handoff-cred"><strong>Email:</strong> ${esc(created.emailAddress)}<br /><strong>Password:</strong> the one you just chose</p>
        <p>${inviteNote}</p>
        <p>Their account is protected: analytics stays off, chat works with family only, and password resets come to your email.</p>
        ${consentNote}
        <button class="btn-mini" type="button">Done</button>`
      // Inserted after bindStaticActions ran, so wire the click directly.
      handoff.querySelector('button')?.addEventListener('click', () => {
        handoff.style.display = 'none'
      })
      handoff.style.display = ''
    }
    for (const id of ['ags-child-nickname', 'ags-child-birth-year', 'ags-child-password']) {
      const field = document.getElementById(id)
      if (field) field.value = ''
    }
    const consentBox = document.getElementById('ags-child-consent')
    if (consentBox) consentBox.checked = false
    sendEvent('family_child_account_created', {})
    await refreshFamilyUI(false)
  }
  window.agsInviteFamilyMember = userId => {
    ensureNotificationPermission()
    const member = familyState.members.find(m => m.userId === userId)
    if (!member) {
      setFamilyMessage('Family member is not available.', 'error')
      return
    }
    if (typeof window.startFriendMatchInvite !== 'function') {
      setFamilyMessage('Match invites are not ready yet.', 'error')
      return
    }
    // Same match-invite flow friends use — a family member row carries the
    // same {userId, displayName} shape startFriendMatchInvite expects.
    window.startFriendMatchInvite(member)
  }
  window.agsRequestFriend = async friendId => {
    ensureNotificationPermission()  // user gesture — ask now so they can be notified when accepted
    await runFriendAction(() => requestFriend(friendId), 'Friend request sent.')
    sendEvent('friend_request_sent', { source: 'manual' })
  }
  window.agsOpenProfile = openPublicProfile
  window.agsOpenMyProfile = () => {
    if (currentUserId) openPublicProfile(currentUserId, getDisplayName(currentProfile))
  }
  // Game-over nudge target: own profile, landed on the Journal tab.
  window.agsOpenJournal = async () => {
    if (!currentUserId) return
    sendEvent('journal_nudge_clicked', {})
    await openPublicProfile(currentUserId, getDisplayName(currentProfile))
    showProfileTab('journal')
  }
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
    if (!container) return
    if (container.querySelector('.share-row')) {
      container.innerHTML = ''
      return
    }
    mountShareRow(container, link, {
      hideX: true,
      nativeLabel: '📤 More',
      title: 'Invite outside friends',
      description: 'Share a link, WhatsApp, email, or More so people outside your Friends list can join.',
    })
  }
  window.agsRequestLastOpponent = async () => {
    const opponent = window.agsLastOpponent
    if (!opponent?.userId) return
    if (blockedPlayers.some(item => item.userId === opponent.userId)) return
    if (isGambitGusIdentity(opponent.userId, opponent.name)) {
      const message = document.getElementById('match-friend-message')
      if (message) message.textContent = 'Gambit Gus cannot be added as a friend.'
      return
    }
    const sent = await runFriendAction(() => requestFriend(opponent.userId, opponent.name), 'Friend request sent.')
    if (sent) await window.agsRefreshMatchChatGate?.({ requestSent: true })
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
      const data = await reportChatMessage(input)
      return { ok: true, data, ticketId: getReportTicketId(data) }
    } catch (error) {
      return { ok: false, error: getSafetyError(error, 'Could not report this message.') }
    }
  }
  window.agsReportPlayer = async input => {
    try {
      const data = await reportPlayer(input)
      return { ok: true, data, ticketId: getReportTicketId(data) }
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
    const displayName = document.getElementById('ags-signedin-name')?.textContent || null
    const newRating = await recordEloResult(currentUserId, currentUserRating, pendingOpponentRating, score, displayName)
    if (newRating != null) {
      currentUserRating = newRating
      updateStatsUI(await fetchStats(currentUserId), currentStreak)
    }
    pendingOpponentRating = null
  }
  // agsGetPendingOpponentRating: read-only peek at the same value, for
  // markMatchDisconnected() to stash before it's lost on a reload — a
  // disconnected match never reaches agsRecordEloResult (which would
  // otherwise consume/clear it), so it stays valid for the whole time the tab
  // remains open after a drop.
  window.agsGetPendingOpponentRating = () => pendingOpponentRating
  // Match-resume bridges (app.js is a plain script, not a module, so it can't
  // import match-resume.mjs/spectator.js directly — these mirror the existing
  // agsGetRating-style bridge pattern). See docs/ags-plans (match resiliency).
  window.agsDeriveMatchRoles = (myUserId, opponentUserId) => deriveMatchRoles(myUserId, opponentUserId)
  window.agsComputeDeadline = (disconnectedAt) => computeDeadline(disconnectedAt)
  window.agsIsPastDeadline = (deadline, now) => isPastDeadline(deadline, now)
  window.agsIsResumable = (record, now) => isResumable(record, now)
  window.agsPickAuthoritativeMoves = (mine, theirs) => pickAuthoritativeMoves(mine, theirs)
  window.agsFetchLiveMatch = (userId) => fetchLiveMatch(userId)
  window.agsFetchLiveMatchStrict = (userId) => fetchLiveMatchStrict(userId)
  window.agsResolveMatchForfeit = (userId, matchId, loserUserId) => resolveMatchForfeit(userId, matchId, loserUserId)
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
    // Land back on the tab the drill-down came from (e.g. the Journal tab).
    if (spectatorReturnProfileTab && target === 'profile') {
      showProfileTab(spectatorReturnProfileTab)
    }
    spectatorReturnProfileTab = ''
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
  // Fetch one entry past the top-10 display cap, purely to detect whether a
  // "View full leaderboard" link is worth showing — there's no separate
  // total-count API.
  const [rankings, userRankData] = await Promise.all([
    fetchTopRankings(currentLeaderboardView, 11),
    needsRank ? fetchUserRank(currentUserId, currentLeaderboardView) : Promise.resolve(null),
  ])
  if (rankings === null) return  // hard failure — keep local leaderboard visible
  const hasMore = rankings.length > 10
  const top10 = rankings.slice(0, 10)
  const leaderboardStatsPromise = fetchLeaderboardPlayerStats([
    ...top10.map(entry => entry.userId),
    ...(userRankData && currentUserId ? [currentUserId] : []),
  ])
  try { await enrichDisplayNames(top10) } catch (e) { console.warn('[lb] enrichDisplayNames:', e) }
  const nameMap = resolveDisplayNames(top10)
  renderAGSLeaderboard(top10, nameMap, userRankData, hasMore, await leaderboardStatsPromise)
}

function switchLeaderboardView(view) {
  if (!LEADERBOARD_VIEWS[view] || view === currentLeaderboardView) return
  currentLeaderboardView = view
  document.querySelectorAll('[data-lb-view]').forEach(btn => {
    const selected = btn.dataset.lbView === view
    btn.classList.toggle('active', selected)
    btn.setAttribute('aria-selected', String(selected))
  })
  const listEl = document.getElementById('lb-list')
  if (listEl) listEl.innerHTML = '<p class="lb-empty">Loading…</p>'
  refreshLeaderboard()
}
window.agsSwitchLeaderboardView = switchLeaderboardView

function leaderboardStatValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function leaderboardPlayerStatsMarkup(stats) {
  if (!stats) return ''
  const wins = leaderboardStatValue(stats.wins)
  const losses = leaderboardStatValue(stats.losses)
  const streak = leaderboardStatValue(stats.streak)
  const streakDays = streak === 1 ? 'day' : 'days'
  const description = `${wins} wins, ${losses} losses, current streak ${streak} ${streakDays}`
  return `<span class="lb-player-stats" title="${description}" aria-label="${description}">W ${wins} · L ${losses} · 🔥 ${streak}</span>`
}

function leaderboardPlayerDetailsMarkup(name, isYou, stats) {
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
  return `<span class="lb-name">${esc(name)}${isYou ? ' (you)' : ''}${isYou ? ownNameBadgesMarkup() : ''}</span>${leaderboardPlayerStatsMarkup(stats)}`
}

// Badges shown next to the CALLER's own name only — self-status is already
// cached client-side (hasClub()/getEquippedFlairBadge()), so this never adds
// a per-row network lookup for other players (dev-plan §7.5/§8: "do NOT add
// per-row status lookups", "self-badge only in v1").
function ownNameBadgesMarkup() {
  let badges = ''
  if (hasClub()) badges += ' <span class="own-badge own-badge-club" title="Ethan\'s Chess Club member">♛</span>'
  const flair = getEquippedFlairBadge()
  if (flair) badges += ` <span class="own-badge own-badge-flair" title="${flair.label}">${flair.emoji}</span>`
  return badges
}

function renderAGSLeaderboard(rankings, nameMap, userRankData, hasMore = false, statsByUserId = {}) {
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
  const listEl = document.getElementById('lb-list')
  const resetBtn = document.querySelector('.btn-lb-reset')
  const rankCard = document.getElementById('lb-your-rank')
  const viewMoreBtn = document.getElementById('lb-view-more')
  if (!listEl) return

  if (resetBtn) resetBtn.style.display = 'none'

  if (rankings.length === 0) {
    listEl.innerHTML = '<p class="lb-empty">No entries yet — win a game!</p>'
    if (rankCard) { rankCard.style.display = 'none'; rankCard.innerHTML = '' }
    if (viewMoreBtn) viewMoreBtn.style.display = 'none'
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
      <button class="lb-name-button" data-profile-user-id="${esc(entry.userId)}" data-profile-name="${safeName}">${leaderboardPlayerDetailsMarkup(name, isYou, statsByUserId?.[entry.userId])}</button>
      <span class="lb-wins">${entry.point}</span>
    </div>`
  }).join('')
  bindLeaderboardProfileButtons(listEl)

  // Your own rank, when it doesn't fit in the top 10 — a small callout below
  // the list instead of one more row buried at the bottom of it.
  if (rankCard) {
    if (!inTop && userRankData) {
      const myName = document.getElementById('ags-signedin-name')?.textContent || 'You'
      rankCard.style.display = ''
      rankCard.innerHTML = `<span class="lb-your-rank-label">Your rank</span>
        <div class="lb-entry lb-you">
          <span class="lb-rank">#${userRankData.rank}</span>
          <span class="lb-name-with-stats">${leaderboardPlayerDetailsMarkup(myName, true, statsByUserId?.[currentUserId])}</span>
          <span class="lb-wins">${userRankData.point}</span>
        </div>`
    } else {
      rankCard.style.display = 'none'
      rankCard.innerHTML = ''
    }
  }

  if (viewMoreBtn) viewMoreBtn.style.display = hasMore ? '' : 'none'
}

function bindLeaderboardProfileButtons(listEl) {
  listEl.querySelectorAll('[data-profile-user-id]').forEach(button => {
    button.addEventListener('click', () => {
      openPublicProfile(button.dataset.profileUserId, button.dataset.profileName || '')
    })
  })
}

if (import.meta.env.DEV) {
  window.agsRenderLeaderboardForTesting = renderAGSLeaderboard
}

// ── Full leaderboard overlay ────────────────────────────────────────────────
// "View full leaderboard" opens this when the home panel's top-10 list
// doesn't hold everyone. Independent fetch (its own page size, its own view
// toggle) rather than sharing state with the home panel — simpler than
// keeping two renderings of the same data in sync.

let leaderboardOverlayView = 'rating'
const LEADERBOARD_OVERLAY_PAGE_SIZE = 50
const leaderboardOverlay = createOverlayController('leaderboard-overlay', 'leaderboard-overlay-close')

function syncLeaderboardOverlayTabs() {
  document.querySelectorAll('[data-lb-overlay-view]').forEach(btn => {
    const selected = btn.dataset.lbOverlayView === leaderboardOverlayView
    btn.classList.toggle('active', selected)
    btn.setAttribute('aria-selected', String(selected))
  })
}

async function loadFullLeaderboard() {
  const listEl = document.getElementById('leaderboard-overlay-list')
  if (!listEl) return
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
  listEl.innerHTML = '<p class="lb-empty">Loading…</p>'
  const rankings = await fetchTopRankings(leaderboardOverlayView, LEADERBOARD_OVERLAY_PAGE_SIZE)
  if (rankings === null) {
    listEl.innerHTML = '<p class="lb-empty">Could not load the leaderboard. Try again in a moment.</p>'
    return
  }
  if (!rankings.length) {
    listEl.innerHTML = '<p class="lb-empty">No entries yet — win a game!</p>'
    return
  }
  const leaderboardStatsPromise = fetchLeaderboardPlayerStats(rankings.map(entry => entry.userId))
  try { await enrichDisplayNames(rankings) } catch (e) { console.warn('[lb] enrichDisplayNames:', e) }
  const nameMap = resolveDisplayNames(rankings)
  const statsByUserId = await leaderboardStatsPromise
  listEl.innerHTML = rankings.map((entry, i) => {
    const isYou = entry.userId === currentUserId
    const name = isYou
      ? (document.getElementById('ags-signedin-name')?.textContent || nameMap[entry.userId] || 'You')
      : (nameMap[entry.userId] || entry.userId.slice(0, 8))
    const safeName = esc(name)
    return `<div class="lb-entry${isYou ? ' lb-you' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <button class="lb-name-button" data-profile-user-id="${esc(entry.userId)}" data-profile-name="${safeName}">${leaderboardPlayerDetailsMarkup(name, isYou, statsByUserId?.[entry.userId])}</button>
      <span class="lb-wins">${entry.point}</span>
    </div>`
  }).join('')
  listEl.querySelectorAll('[data-profile-user-id]').forEach(button => {
    button.addEventListener('click', () => {
      closeLeaderboardOverlay()
      openPublicProfile(button.dataset.profileUserId, button.dataset.profileName || '')
    })
  })
}

function openLeaderboardOverlay(trigger = null) {
  leaderboardOverlayView = currentLeaderboardView
  syncLeaderboardOverlayTabs()
  leaderboardOverlay.open(trigger)
  loadFullLeaderboard()
}

function closeLeaderboardOverlay() {
  leaderboardOverlay.close()
}

function switchLeaderboardOverlayView(view) {
  if (!LEADERBOARD_VIEWS[view] || view === leaderboardOverlayView) return
  leaderboardOverlayView = view
  syncLeaderboardOverlayTabs()
  loadFullLeaderboard()
}

window.agsOpenLeaderboardOverlay = openLeaderboardOverlay
window.agsCloseLeaderboardOverlay = closeLeaderboardOverlay
window.agsSwitchLeaderboardOverlayView = switchLeaderboardOverlayView

function showProfileTab(name = 'overview') {
  sendEvent('profile_tab_viewed', {
    tab: name,
    own_profile: !!currentUserId && activeProfileUser?.userId === currentUserId,
  })
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
  if (name === 'journal') void renderPreparedJournalTab()
}

function setProfileTabVisible(name, visible) {
  const tab = document.querySelector(`[data-profile-tab="${name}"]`)
  if (tab) tab.hidden = !visible
}

window.agsShowProfileTab = showProfileTab

async function openPublicProfile(userId, displayName = '') {
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
  activeProfileUser = { userId, displayName }
  preparedJournalRender = null
  journalRenderGeneration++
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
  const kudosEl = document.getElementById('profile-kudos')
  const chessStatsSection = document.getElementById('profile-chess-stats')

  const editBtn = document.getElementById('profile-btn-edit-name')
  const editForm = document.getElementById('profile-name-edit-form')

  if (typeof window.showScreen === 'function') window.showScreen('profile')
  showProfileTab('overview')
  setProfileTabVisible('stats', !!currentUserId)
  setProfileTabVisible('account', false)
  setProfileTabVisible('coaching', false)
  setProfileTabVisible('journal', false)
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
    if (kudosEl) kudosEl.textContent = '—'
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
  if (kudosEl) kudosEl.textContent = formatKudosCount(stats?.kudos)
  renderProfileMatchHistory(matchHistory)
  // Head-to-head is "my record vs this person" — on my own profile that's
  // just my own computed stats; on a friend's profile it needs my own match
  // history too (already fetched above), looked up by their userId.
  const headToHeadEntry = userId === currentUserId
    ? null
    : computeMatchStats(myMatchHistory).headToHead.find(h => h.opponentUserId === userId)
  renderChessStats(computeMatchStats(matchHistory), headToHeadEntry)
  // Advanced stats are Club-gated (dev-plan §1.2). We only know the VIEWER's
  // own Club status without an extra per-user lookup ("do NOT add per-row
  // status lookups") — so the gate applies on your own profile only; a
  // friend's profile always shows their advanced stats.
  renderAdvancedStats(computeMatchStats(matchHistory), {
    hasClub: userId === currentUserId ? hasClub() : true,
    isChildSession: isProtectedChildSession(),
  })

  // Coaching tab: guardians only, and only on a linked child's profile —
  // the role check is against the shared chess-family group.
  const showCoaching = currentUserIsGuardian()
    && familyState.members.some(m => m.userId === userId && m.role === 'child')
  setProfileTabVisible('coaching', showCoaching)
  if (showCoaching) renderFamilyCoachingTab(userId, matchHistory)

  const friend = friendsState.friends.find(item => item.userId === userId)
  const incoming = friendsState.incoming.find(item => item.userId === userId)
  const outgoing = friendsState.outgoing.find(item => item.userId === userId)
  const isGus = isGambitGusIdentity(userId, displayName)

  if (userId === currentUserId) {
    if (statusEl) statusEl.textContent = 'This is your profile.'
    if (editBtn) editBtn.style.display = ''
    if (accountSafetyCard) accountSafetyCard.style.display = ''
    setProfileTabVisible('account', true)
    // Journal is owner-only (a deliberately different gate from the
    // guardian-only Coaching tab) — reflections are the player's own space.
    setProfileTabVisible('journal', true)
    prepareJournalTab(userId, matchHistory, {
      isChildSession: isProtectedChildSession(),
      clubActive: hasClub(),
      journalOpen: getClubStatus()?.journalOpen || null,
      narrativesRemainingToday: getClubStatus()?.narrativesRemainingToday ?? null,
    })
    renderBlockedPlayers()
    return
  }

  if (friend) {
    const presence = friend.presence?.label || 'Offline'
    if (statusEl) statusEl.textContent = `Already friends · ${presence}`
    return
  }

  if (isGus) {
    if (statusEl) statusEl.textContent = 'Gambit Gus cannot be added as a friend.'
    if (addBtn) addBtn.style.display = 'none'
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
  const clubNotices = document.getElementById('delete-account-club-notices')
  if (!modal || !currentUserId) return
  deletionRequirements = null
  modal.style.display = 'flex'
  if (input) {
    input.value = ''
    input.disabled = true
  }
  if (submit) submit.disabled = true
  if (clubNotices) clubNotices.style.display = 'none'
  setAccountDeletionMessage('Checking account deletion requirements…')
  try {
    deletionRequirements = await fetchDeletionRequirements()
    // Club/coins warnings (dev-plan §11.8) must be visible BEFORE the final
    // confirm: an active Apple subscription survives account deletion, and
    // any coin balance is forfeited.
    if (clubNotices) {
      const notices = accountDeletionNotices(deletionRequirements)
      clubNotices.textContent = notices.join(' ')
      clubNotices.style.display = notices.length ? '' : 'none'
    }
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
    resetClubStatus()
    resetCosmetics()
    chatClient.disconnect()
    clearLiveMatch()
    try {
      await signOutPresence()
    } catch {}
    clearLocalAccountData()
    currentUserId = null
    currentProfile = null
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

  if (isGambitGusIdentity(profile?.userId, profile?.displayName)) {
    if (statusEl) statusEl.textContent = 'Gambit Gus cannot be added as a friend.'
    if (addBtn) addBtn.style.display = 'none'
    return
  }

  const result = profile.action === 'accept'
    ? await acceptFriend(profile.userId)
    : await requestFriend(profile.userId, profile.displayName)

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
    return `<button class="profile-history-row${canReplay ? ' replayable' : ' no-replay'}" type="button" ${canReplay ? `data-replay-index="${index}"` : 'disabled'}>
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
  el.querySelectorAll('[data-replay-index]').forEach(button => {
    button.addEventListener('click', () => {
      window.agsReplayMatchHistory?.(Number(button.dataset.replayIndex))
    })
  })
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
}

// Advanced stats panel (openings report, nemesis, etc.) is Club-gated
// (dev-plan §1.2) — free tier sees a locked upsell card in its place. Basic
// win-rate stats above are never gated (dev-plan §1.2: "Do NOT gate...
// basic stats").
function renderAdvancedStats(derived, { hasClub = false, isChildSession = false } = {}) {
  const wrap = document.getElementById('profile-advanced-stats')
  if (!wrap || !derived) return

  if (!hasClub) {
    wrap.innerHTML = isChildSession
      ? `<div class="profile-history-empty">
          <strong>Advanced stats are a Club perk</strong>
          <span>Openings report, nemesis history, and more — ask your parent about Club ♛.</span>
        </div>`
      : `<div class="profile-history-empty profile-history-locked" data-purchase-ui="1">
          <strong>Advanced stats are a Club perk</strong>
          <span>Openings report, castling habits, comeback wins, and your toughest opponent.</span>
          <button type="button" class="btn-mini" data-click="window.agsOpenClub && window.agsOpenClub()">Learn more ♛</button>
        </div>`
    return
  }

  const c = derived.castlingRate
  const e = derived.endReasonCounts
  const decisive = e.checkmate + e.resignation
  wrap.innerHTML = `
    <div class="profile-stat">
      <span>Favorite opening</span>
      <strong>${derived.favoriteOpening
        ? `${escAch(OPENING_NAMES[derived.favoriteOpening.key] || derived.favoriteOpening.key)} (${formatPct(derived.favoriteOpening.rate)} win)`
        : '—'}</strong>
    </div>
    <div class="profile-stat">
      <span>Time played</span>
      <strong>${derived.timePlayed.totalMs ? formatDuration(derived.timePlayed.totalMs) : '—'}</strong>
    </div>
    <div class="profile-stat">
      <span>Castling</span>
      <strong>${c.total ? `${formatPct(c.kingsidePct)} kingside · ${formatPct(c.queensidePct)} queenside` : '—'}</strong>
    </div>
    <div class="profile-stat">
      <span>Longest / shortest</span>
      <strong>${derived.timePlayed.longest && derived.timePlayed.shortest
        ? `${formatDuration(derived.timePlayed.longest.durationMs)} / ${formatDuration(derived.timePlayed.shortest.durationMs)}`
        : '—'}</strong>
    </div>
    <div class="profile-stat">
      <span>Fastest checkmate</span>
      <strong>${derived.fastestCheckmateMoves != null ? `${derived.fastestCheckmateMoves} moves` : '—'}</strong>
    </div>
    <div class="profile-stat">
      <span>Comeback wins</span>
      <strong>${derived.comebackWins > 0 ? String(derived.comebackWins) : '—'}</strong>
    </div>
    <div class="profile-stat">
      <span>Game endings</span>
      <strong>${decisive || (e['draw-insufficient'] + e['draw-fifty-move'] + e['draw-repetition'] + e.stalemate)
        ? `${e.checkmate} checkmate · ${e.resignation} resign · ${e.stalemate + e['draw-insufficient'] + e['draw-fifty-move'] + e['draw-repetition']} draw`
        : '—'}</strong>
    </div>
    <div class="profile-stat">
      <span>Toughest opponent</span>
      <strong>${derived.nemesis ? `${escAch(derived.nemesis.name)} (${formatRecord(derived.nemesis)})` : '—'}</strong>
    </div>
  `
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
  const loginAppleLink = document.getElementById('login-apple-link')
  if (loginAppleLink) loginAppleLink.style.display = (!loggedIn && isNative) ? '' : 'none'

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
    resetClubStatus()
    resetCosmetics()
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

async function performFriendsRefresh(showLoading, preserveMessage) {
  if (!currentUserId) {
    renderFriendsPanel(false)
    renderFamilyPanel(false)
    return
  }
  const userId = currentUserId
  if (showLoading) setFriendsMessage('Loading friends...')
  const state = await fetchFriendState()
  if (currentUserId !== userId) return
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

  // Family rides the same refresh cycle (login, 15s timer, lobby reconnect) —
  // fire-and-forget so a family hiccup never blocks the friends list.
  void refreshFamilyUI(false)

  const anyAccepted = await processIncomingInviteAcceptances(state.incoming)
  if (anyAccepted && currentUserId === userId) {
    await performFriendsRefresh(false, preserveMessage)
  }
}

async function refreshFriendsUI(showLoading = true, preserveMessage = false) {
  if (friendsRefreshPromise) {
    // Coalesce timer/Lobby/manual refresh storms, but remember that one more
    // pass is needed after the current snapshot so action-triggered updates
    // cannot be overwritten by an older in-flight response.
    friendsRefreshQueued = true
    friendsRefreshQueuedPreserveMessage ||= preserveMessage
    return friendsRefreshPromise
  }

  friendsRefreshPromise = (async () => {
    let nextShowLoading = showLoading
    let nextPreserveMessage = preserveMessage
    do {
      friendsRefreshQueued = false
      friendsRefreshQueuedPreserveMessage = false
      await performFriendsRefresh(nextShowLoading, nextPreserveMessage)
      nextShowLoading = false
      nextPreserveMessage = friendsRefreshQueuedPreserveMessage
    } while (friendsRefreshQueued && currentUserId)
  })()

  try {
    return await friendsRefreshPromise
  } finally {
    friendsRefreshPromise = null
  }
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
    if (currentUserId && document.visibilityState === 'visible') void refreshFriendsUI(false)
  }, 60000)
  friendsVisibilityHandler = () => {
    if (document.visibilityState === 'visible' && currentUserId) void refreshFriendsUI(false)
  }
  document.addEventListener('visibilitychange', friendsVisibilityHandler)
}

function stopFriendsRefresh() {
  if (friendsRefreshTimer) {
    clearInterval(friendsRefreshTimer)
    friendsRefreshTimer = null
  }
  if (friendsVisibilityHandler) {
    document.removeEventListener('visibilitychange', friendsVisibilityHandler)
    friendsVisibilityHandler = null
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
      if (friend.presence?.status === presence?.status && friend.presence?.label === presence?.label) return friend
      changed = true
      return { ...friend, presence }
    })

    if (changed) {
      friendsState = { ...friendsState, friends }
      renderFriendsPanel(true)
    }

    // Family-online nudge: same event stream, filtered to family members
    // coming online. Compare against the previously-stored presence on the
    // member entry so only the offline→online transition fires it.
    let familyChanged = false
    const members = familyState.members.map(member => {
      if (normalizeFriendUserId(member.userId) !== normalizedUserId) return member
      if (member.presence?.status === presence?.status && member.presence?.label === presence?.label) return member
      const wasOnline = ['online', 'in-match'].includes(member.presence?.status)
      const isOnline = ['online', 'in-match'].includes(presence?.status)
      if (!wasOnline && isOnline && member.userId !== currentUserId) {
        showFamilyOnlineNudge(member)
      }
      familyChanged = true
      return { ...member, presence }
    })
    if (familyChanged) {
      familyState = { ...familyState, members }
      renderFamilyPanel(true)
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
  window.clearFriendMatchInvite?.()
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
// waiting on the periodic refresh (startFriendsRefresh) — that gap is what
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

function friendRow(item, actions = '', { profileLink = false, roleLabel = '' } = {}) {
  const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
  const presence = item.presence || { status: 'offline', label: 'Offline' }
  const identity = `<span class="friend-name">${esc(item.displayName)}
    <span class="friend-presence ${esc(presence.status)}">${esc(presence.label)}</span>
    ${roleLabel ? `<span class="family-role-badge">${esc(roleLabel)}</span>` : ''}
  </span>`
  return `<div class="friend-row">
    <div class="friend-main">
      ${profileLink
        ? `<button type="button" class="friend-profile-link" data-action="profile" data-user-id="${esc(item.userId)}" data-display-name="${esc(item.displayName || '')}" aria-label="View ${esc(item.displayName || 'friend')} profile and stats">${identity}</button>`
        : identity}
    </div>
    ${actions ? `<div class="friend-actions">${actions}</div>` : ''}
  </div>`
}

function openFriendProfile(userId, displayName = '') {
  closeOfflineFriends()
  openPublicProfile(userId, displayName)
}

function renderOfflineFriends(friends) {
  const list = document.getElementById('offline-friends-list')
  const title = document.getElementById('offline-friends-title')
  if (!list || !title) return

  title.textContent = `Offline friends (${friends.length})`
  list.innerHTML = friends.length
    ? friends.map(item => friendRow(item, '', { profileLink: true })).join('')
    : '<p class="friends-empty">No friends are offline.</p>'
  list.querySelectorAll('[data-action="profile"]').forEach(button => {
    button.addEventListener('click', () => {
      openFriendProfile(button.dataset.userId, button.dataset.displayName || '')
    })
  })
}

// Generic small-modal controller (open/close + ESC / backdrop-click / focus
// trap) shared by every "overlay on top of the home screen" dialog — offline
// friends and the full leaderboard both use this instead of duplicating the
// same dismissal wiring.
function createOverlayController(overlayId, closeButtonId) {
  let trigger = null
  function open(fromTrigger = null) {
    const overlay = document.getElementById(overlayId)
    const closeButton = document.getElementById(closeButtonId)
    if (!overlay || !closeButton) return
    trigger = fromTrigger || document.activeElement
    overlay.hidden = false
    document.body.classList.add('offline-friends-open')
    closeButton.focus()
  }
  function close() {
    const overlay = document.getElementById(overlayId)
    if (!overlay || overlay.hidden) return
    overlay.hidden = true
    document.body.classList.remove('offline-friends-open')
    const el = trigger
    trigger = null
    el?.focus?.()
  }
  function bindDismissal() {
    const overlay = document.getElementById(overlayId)
    overlay?.addEventListener('click', event => {
      if (event.target === overlay) close()
    })
    document.addEventListener('keydown', event => {
      if (overlay?.hidden !== false) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...overlay.querySelectorAll('button:not(:disabled)')]
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
  return { open, close, bindDismissal }
}

const offlineFriendsOverlay = createOverlayController('offline-friends-overlay', 'offline-friends-close')
function openOfflineFriends(trigger = null) { offlineFriendsOverlay.open(trigger) }
function closeOfflineFriends() { offlineFriendsOverlay.close() }

window.agsOpenOfflineFriends = openOfflineFriends
window.agsCloseOfflineFriends = closeOfflineFriends

const coinStoreOverlay = createOverlayController('coin-store-overlay', 'coin-store-close')
window.agsOpenCoinStore = trigger => {
  coinStoreOverlay.open(trigger)
  void loadCoinStore()
}
window.agsCloseCoinStore = () => coinStoreOverlay.close()

function renderFriendsListOnlineFirst(friends) {
  const el = document.getElementById('ags-friends-list')
  const countEl = document.getElementById('ags-count-friends')
  if (!el) return
  if (countEl) countEl.textContent = friends.length || ''

  if (!friends.length) {
    el.innerHTML = `<div class="friends-online-empty">
      <strong>No friends yet</strong>
      <span>Add a friend or share an invite to start playing together.</span>
    </div>`
    renderOfflineFriends([])
    return
  }

  const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
  const online = friends.filter(f => ['online', 'in-match'].includes(f.presence?.status))
  const offline = friends.filter(f => !['online', 'in-match'].includes(f.presence?.status))
  // Total is already shown in the section header (#ags-count-friends); an
  // "N online / M total" bar here just repeated both numbers a second time,
  // directly above the "Online · N" divider repeating the online count a
  // third time — reviewed and removed as pure redundancy.
  let html = ''
  if (online.length) {
    html += `<div class="friends-group-divider"><span>Online · ${online.length}</span></div>`
    html += online.map(item => {
      const inMatch = item.presence?.status === 'in-match'
      // Use data attributes — never put user-controlled strings into inline event handlers.
      const action = inMatch
        ? `<button class="btn-mini spectator" data-action="watch" data-user-id="${esc(item.userId)}" data-display-name="${esc(item.displayName || '')}">Watch</button>`
        : `<button class="btn-mini success" data-action="invite" data-user-id="${esc(item.userId)}">Invite</button>`
      return friendRow(item, action, { profileLink: true })
    }).join('')
  } else {
    html += `<div class="friends-online-empty">
      <strong>No friends online right now</strong>
      <span>You can still view offline profiles or share an invite.</span>
    </div>`
  }
  if (offline.length) {
    html += `<button type="button" class="offline-friends-trigger" data-action="offline">
      <span>Offline friends</span>
      <strong>${offline.length}</strong>
      <span aria-hidden="true">View →</span>
    </button>`
  }
  el.innerHTML = html
  renderOfflineFriends(offline)

  el.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { action, userId, displayName } = btn.dataset
      if (action === 'watch') window.agsWatchFriend?.(userId, displayName || '')
      else if (action === 'invite') window.agsInviteFriend?.(userId)
      else if (action === 'profile') openFriendProfile(userId, displayName || '')
      else if (action === 'offline') openOfflineFriends(btn)
    })
  })
}

if (import.meta.env.DEV) {
  window.agsRenderFriendsListForTesting = renderFriendsListOnlineFirst
  // currentUserId is a private module binding (real ES module — unlike
  // app.js's plain-script globals, nothing here is reachable as window.x by
  // default). Offline e2e specs that need main.js's OWN notion of "signed
  // in" (e.g. window.agsHighFiveButtonState's senderId, window.agsOpenMyProfile's
  // gate) must go through this setter, not window.agsCurrentUserId (that's
  // a one-way mirror app.js reads, not the other direction).
  window.agsSetCurrentUserIdForTesting = id => { currentUserId = id }
  // familyState is likewise a private module binding — offline e2e specs
  // that need to exercise the real renderFamilyPanel()/agsGiveCoins() code
  // paths (not just assert on hand-injected DOM, as people-panel.spec.js
  // does elsewhere) go through this setter rather than trying to drive a
  // full Group-service invite/accept flow.
  window.agsSetFamilyStateForTesting = state => {
    familyState = { group: null, members: [], incomingInvites: [], ...state }
    renderFamilyPanel(true)
  }
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

// ─── Family panel ───────────────────────────────────────────────────────────

function setFamilyMessage(text, tone = '') {
  const el = document.getElementById('ags-family-message')
  if (!el) return
  el.className = `auth-message${tone ? ' ' + tone : ''}`
  el.textContent = text || ''
}

function currentUserIsGuardian() {
  return familyState.members.some(m => m.userId === currentUserId && m.role === 'guardian')
}

function myFamilyRole() {
  return familyState.members.find(m => m.userId === currentUserId)?.role || ''
}

// A protected child session (COPPA): under-13 by IAM dateOfBirth, or holding
// the guardian-assigned 'child' family role (covers accounts that predate DOB
// collection). Protections: analytics forced off, no stored email, no
// add-friend-by-email, chat with family members only.
function isProtectedChildSession() {
  return isChildSession({ profile: currentProfile, familyRole: myFamilyRole() })
}

// Idempotent — runs after hydration and after every family refresh, because
// the role-based signal only becomes known once the family state loads.
function applyChildSessionRestrictions() {
  if (!isProtectedChildSession()) return
  if (readPrivacyPreferences().analytics) {
    writePrivacyPreferences({ analytics: false })
  }
  localStorage.removeItem('chess_user_email')
  delete window.agsCurrentUserEmail
  for (const id of ['btn-add-friend-expand', 'ags-add-friend-form']) {
    const element = document.getElementById(id)
    if (element) element.style.display = 'none'
  }
}

async function refreshFamilyUI(showLoading = true) {
  if (!currentUserId) {
    renderFamilyPanel(false)
    return
  }
  const userId = currentUserId
  if (showLoading) setFamilyMessage('Loading family...')
  let state
  try {
    state = await fetchFamilyState()
  } catch (error) {
    if (currentUserId === userId) {
      setFamilyMessage('Family features could not load. Try again.', 'error')
      renderFamilyPanel(true)
    }
    return
  }
  if (currentUserId !== userId) return
  if (!state.ok) {
    setFamilyMessage(state.error, 'error')
    renderFamilyPanel(true)
    return
  }
  familyState = state
  if (showLoading) setFamilyMessage('')
  renderFamilyPanel(true)
  // The 'child' family role is a protection signal — re-check every time the
  // family state (and with it, this player's role) refreshes.
  applyChildSessionRestrictions()
  // Re-render with the now-accurate child flag (cached status, no extra
  // network call — same reasoning as applyChildSessionRestrictions above).
  void initClubPanel(isProtectedChildSession())
}

function renderFamilyPanel(loggedIn) {
  const panel = document.getElementById('ags-family-panel')
  if (!panel) return
  // Hidden entirely where the Group transport can't work: no transport at
  // build time (familyTransportAvailable), or the deployed Extend service
  // doesn't have the /family/group proxy yet (transportMissing) — no
  // half-working panel either way.
  const transportReady = familyTransportAvailable() && !familyState.transportMissing
  panel.style.display = loggedIn && transportReady ? '' : 'none'
  if (!loggedIn || !transportReady) return

  const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
  const membersSection = document.getElementById('ags-section-family-members')
  const listEl = document.getElementById('ags-family-list')
  const nameEl = document.getElementById('ags-family-name')
  const countEl = document.getElementById('ags-count-family')
  const emptyEl = document.getElementById('ags-family-empty')
  const actionsEl = document.getElementById('ags-family-actions')
  const inviteBtn = document.getElementById('btn-family-invite-expand')
  if (!membersSection || !listEl) return

  const isGuardian = currentUserIsGuardian()

  if (familyState.group) {
    membersSection.style.display = ''
    if (emptyEl) emptyEl.style.display = 'none'
    if (actionsEl) actionsEl.style.display = ''
    // Only guardians hold GROUP:INVITE — the button gate is cosmetic, the
    // group service enforces it server-side either way. Add Child is
    // guardian-only for real: it's the parental-consent act.
    if (inviteBtn) inviteBtn.style.display = isGuardian ? '' : 'none'
    const addChildBtn = document.getElementById('btn-family-add-child')
    if (addChildBtn) addChildBtn.style.display = isGuardian ? '' : 'none'
    if (!isGuardian) {
      const addChildForm = document.getElementById('ags-add-child-form')
      if (addChildForm) addChildForm.style.display = 'none'
    }
    if (nameEl) nameEl.textContent = familyState.group.groupName
    if (countEl) countEl.textContent = familyState.members.length

    listEl.innerHTML = familyState.members.map(member => {
      const isSelf = member.userId === currentUserId
      const online = ['online', 'in-match'].includes(member.presence?.status)
      const actions = [
        !isSelf && online ? `<button class="btn-mini success" data-action="play" data-user-id="${esc(member.userId)}">Play</button>` : '',
        !isSelf && isGuardian ? `<button class="btn-mini" data-action="give-coins" data-user-id="${esc(member.userId)}">Give coins</button>` : '',
        !isSelf && isGuardian ? `<button class="btn-mini" data-action="remove" data-user-id="${esc(member.userId)}">Remove</button>` : '',
      ].filter(Boolean).join('')
      return friendRow(member, actions, {
        profileLink: !isSelf,
        roleLabel: member.role === 'guardian' ? 'Guardian' : 'Child',
      })
    }).join('')
    listEl.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const { action, userId, displayName } = btn.dataset
        if (action === 'play') window.agsInviteFamilyMember?.(userId)
        else if (action === 'give-coins') window.agsGiveCoins?.(userId)
        else if (action === 'remove') window.agsRemoveFamilyMember?.(userId)
        else if (action === 'profile') openPublicProfile(userId, displayName || '')
      })
    })
  } else {
    membersSection.style.display = 'none'
    if (actionsEl) actionsEl.style.display = 'none'
    if (emptyEl) emptyEl.style.display = familyState.incomingInvites.length ? 'none' : ''
  }

  const invitesSection = document.getElementById('ags-section-family-invites')
  const invitesList = document.getElementById('ags-family-invites')
  const invitesCount = document.getElementById('ags-count-family-invites')
  if (invitesSection && invitesList) {
    const invites = familyState.group ? [] : familyState.incomingInvites
    invitesSection.style.display = invites.length ? '' : 'none'
    if (invitesCount) invitesCount.textContent = invites.length
    // Said before Accept, not after: this account doesn't hold the child
    // role yet, so isProtectedChildSession() can't gate a warning onto the
    // post-accept state — the only honest place for it is right here.
    const notice = invites.length
      ? '<p class="family-invite-notice">Accepting turns on supervision for this account: analytics off, chat and friends limited to family.</p>'
      : ''
    invitesList.innerHTML = notice + invites.map(invite => `<div class="friend-row">
      <div class="friend-main"><span class="friend-name">${esc(invite.groupName)}</span></div>
      <div class="friend-actions">
        <button class="btn-mini success" data-action="accept-family" data-group-id="${esc(invite.groupId)}">Accept</button>
        <button class="btn-mini" data-action="decline-family" data-group-id="${esc(invite.groupId)}">Decline</button>
      </div>
    </div>`).join('')
    invitesList.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const { action, groupId } = btn.dataset
        if (action === 'accept-family') window.agsAcceptFamilyInvite?.(groupId)
        else if (action === 'decline-family') window.agsRejectFamilyInvite?.(groupId)
      })
    })
  }

  renderFamilyInvitePicker()
}

// "Your kid is online — play now?" banner. Fired from the presence stream on
// an offline→online transition of a family member; deliberately quiet
// otherwise (at most one nudge per member per session).
let familyNudgeUserId = null
const familyNudgedThisSession = new Set()

function showFamilyOnlineNudge(member) {
  if (familyNudgedThisSession.has(member.userId)) return
  const banner = document.getElementById('family-online-notification')
  const nameEl = document.getElementById('family-online-name')
  if (!banner || !nameEl) return
  // Don't interrupt an active game with a social nudge.
  if (document.getElementById('screen-game')?.classList.contains('active')) return
  familyNudgedThisSession.add(member.userId)
  familyNudgeUserId = member.userId
  nameEl.textContent = `${member.displayName || 'A family member'} is online`
  banner.style.display = 'flex'
  sendEvent('family_nudge_shown', {})
}

window.agsPlayFamilyNudge = () => {
  const banner = document.getElementById('family-online-notification')
  if (banner) banner.style.display = 'none'
  if (familyNudgeUserId) {
    sendEvent('family_nudge_accepted', {})
    window.agsInviteFamilyMember?.(familyNudgeUserId)
  }
  familyNudgeUserId = null
}

window.agsDismissFamilyNudge = () => {
  const banner = document.getElementById('family-online-notification')
  if (banner) banner.style.display = 'none'
  familyNudgeUserId = null
}

// Guardian picks family members from the existing friends list — the
// invite/accept handshake is the real consent, friendship is just the
// discovery UX (no typing user IDs).
function renderFamilyInvitePicker() {
  const picker = document.getElementById('ags-family-invite-picker')
  if (!picker || picker.style.display === 'none') return
  const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
  const memberIds = new Set(familyState.members.map(m => m.userId))
  const candidates = friendsState.friends.filter(friend => !memberIds.has(friend.userId))
  // This is for a child who already has their own account (an older kid, or
  // one made before the family existed) — only guardian + child roles exist,
  // so accepting supervises the account regardless of the friend's actual
  // age. Said plainly here so a guardian never does this to an adult by
  // mistake, and Accept/Decline (renderFamilyPanel) repeats it for the
  // person on the receiving end.
  const notice = '<p class="family-invite-notice">Only for a child\'s own account — accepting turns on supervision (analytics off, chat and friends limited to family), even for an adult account.</p>'
  picker.innerHTML = notice + (candidates.length
    ? candidates.map(friend => friendRow(friend,
        `<button class="btn-mini success" data-action="family-invite" data-user-id="${esc(friend.userId)}">Invite</button>`)).join('')
    : '<p class="friends-empty">All your friends are already in the family — add more friends first.</p>')
  picker.querySelectorAll('button[data-action="family-invite"]').forEach(btn => {
    btn.addEventListener('click', () => window.agsInviteToFamily?.(btn.dataset.userId))
  })
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
  if (isGambitGusIdentity(opponent.userId, opponent.name)) {
    btn.style.display = 'none'
    note.textContent = 'Gambit Gus cannot be added as a friend.'
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

// Friendship probe for gated features (video chat is friends-only). AGS
// friendship is mutual, so status '3' on our side means both players are
// friends. Fails closed: any error, guest session, or self-check → false.
window.agsIsFriendWith = async userId => {
  if (!userId || !currentUserId || userId === currentUserId) return false
  const status = await getFriendshipStatus(userId)
  return !!(status.ok && status.status === '3')
}

window.agsIsFamilyMember = userId => !!userId
  && familyState.members.some(member => member.userId === userId)

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

// replayMatchData opens any recorded match (own history, a friend's, or Gus's)
// on the spectator board in replay mode; prevScreen is where Back returns to.
// startIndex jumps straight to a specific ply (journal key moments); default
// is the final position. returnTab re-selects a profile tab on Back so a
// drill-down from the Journal tab lands back on the Journal tab.
function replayMatchData(match, prevScreen = 'profile', { startIndex = -1, returnTab = '' } = {}) {
  if (!match || !Array.isArray(match.moves) || !match.moves.length) return

  sendEvent('replay_viewed', { source: returnTab || prevScreen, at_ply: startIndex >= 0 })
  spectatorPrevScreen = prevScreen
  spectatorReturnProfileTab = returnTab
  const lastIndex = match.moves.length - 1
  spectatorReplayIndex = startIndex >= 0 && startIndex <= lastIndex ? startIndex : lastIndex
  const finalGame = buildReplayPosition(match.moves, lastIndex)
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

function replayMatchHistoryAt(index) {
  replayMatchData(profileMatchHistoryRows[index], 'profile')
}

window.agsReplayMatchHistory = replayMatchHistoryAt
window.agsReplayMatchData = replayMatchData
// Grading seam for src/journal.js: its incremental grader maintains the
// running position itself and calls this per player ply (the thresholds and
// prose stay defined in exactly one place). Also used to judge puzzle answers.
window.agsGradeMoveInPosition = gradeMoveInPosition

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

// gradeMoveInPosition is the core grader: it takes an already-built "position
// before the move" so callers control the cost of getting there.
// analyzeReplayMove wraps it for the replay viewer (rebuilding the prefix per
// call); the journal's incremental grader (src/journal.js) walks one running
// position through a game and calls this per player ply — avoiding the O(n²)
// prefix replays. Returns the human-facing grade fields plus the raw numbers
// (loss/scores/SANs) that key-moment selection needs.
async function gradeMoveInPosition(before, played, names = {}) {
  try {
    if (window.chessBackgroundWorker?.gradePosition) {
      return await window.chessBackgroundWorker.gradePosition(before, played, names, {
        timeBudgetMs: 150,
        maxNodes: 25_000,
      })
    }
  } catch (error) {
    console.warn('[analysis] background worker unavailable; using bounded fallback:', error?.message || error)
  }
  return gradeMoveInPositionSync(before, played, names)
}

function gradeMoveInPositionSync(before, played, { whiteName, blackName } = {}) {
  const mover = before.currentTurn
  const playedNotation = before.getMoveNotation(played.fr, played.fc, played.toR, played.toC, played.promType || 'queen')
  const best = spectatorAi.getBestMove(before, 'medium', { timeBudgetMs: 150, maxNodes: 25_000 })
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
      preScore: scoreForColor(spectatorAi.evaluate(before), mover),
    }
  }

  const bestNotation = before.getMoveNotation(best.fr, best.fc, best.toR, best.toC, best.promType || 'queen')
  const preScore = scoreForColor(spectatorAi.evaluate(before), mover)
  const playedAfter = spectatorAi._cloneGame(before)
  playedAfter.makeMove(played.fr, played.fc, played.toR, played.toC, played.promType || 'queen')
  const bestAfter = spectatorAi._cloneGame(before)
  bestAfter.makeMove(best.fr, best.fc, best.toR, best.toC, best.promType || 'queen')

  // The preferred-move search is budgeted, while these two one-ply scores are
  // tiny and must not inherit an already-expired search deadline.
  spectatorAi._deadline = Infinity
  spectatorAi._maxNodes = Infinity
  spectatorAi._nodes = 0
  spectatorAi._timedOut = false

  // Score each candidate AFTER the opponent's best answer (one-ply minimax),
  // not with a raw static eval of the resulting position — a static eval
  // can't see a hanging piece (Qxh7 "wins a pawn" right up until ...Rxh7),
  // and hung pieces are exactly the mistakes this grader exists to catch.
  const opponentIsWhite = mover !== 'white'
  const playedScore = scoreForColor(
    spectatorAi.minimax(playedAfter, 1, -Infinity, Infinity, opponentIsWhite), mover)
  const bestScore = scoreForColor(
    spectatorAi.minimax(bestAfter, 1, -Infinity, Infinity, opponentIsWhite), mover)
  const loss = bestScore - playedScore
  const sameMove = sameReplayMove(played, best)
  const moverName = mover === 'white' ? (whiteName || 'White') : (blackName || 'Black')
  const raw = { playedNotation, bestNotation, loss, playedScore, bestScore, preScore, matchedBest: sameMove }

  if (sameMove || loss < 35) {
    return {
      grade: 'Strong move',
      text: `${moverName}'s ${playedNotation} matches the engine's preferred idea.`,
      recommendation: 'No better move found at this depth.',
      ...raw,
    }
  }

  if (loss < 120) {
    return {
      grade: 'Playable',
      text: `${moverName}'s ${playedNotation} is playable, but it gives up ${formatPawnLoss(loss)} compared with the best line.`,
      recommendation: `Consider ${bestNotation} instead.`,
      ...raw,
    }
  }

  return {
    grade: 'Better move available',
    text: `${moverName}'s ${playedNotation} misses a stronger continuation and gives up ${formatPawnLoss(loss)}.`,
    recommendation: `Recommended: ${bestNotation}.`,
    ...raw,
  }
}

async function analyzeReplayMove(matchData, moveIndex) {
  const moves = matchData.moves || []
  const played = moves[moveIndex]
  if (!played) return null

  const before = buildReplayPosition(moves, moveIndex - 1)
  return gradeMoveInPosition(before, played, {
    whiteName: matchData.whiteName,
    blackName: matchData.blackName,
  })
}

// ─── Coaching summary (family feature) ──────────────────────────────────────
// Aggregates the existing per-move analyzeReplayMove grading across whole
// games into a parent-readable summary. Engine-dependent orchestration lives
// here; the pure counting/labeling lives in match-stats.mjs
// (summarizeCoachingGrades/combineCoachingSummaries) where it's unit-tested.

const coachingGradesCache = new Map()

async function gradeAllMoves(matchData) {
  const moves = matchData.moves || []
  const last = moves[moves.length - 1]
  const cacheKey = `${matchData.id || ''}:${moves.length}:${last ? `${last.fr}${last.fc}${last.toR}${last.toC}${last.promType || ''}` : ''}`
  if (coachingGradesCache.has(cacheKey)) return coachingGradesCache.get(cacheKey)
  try {
    if (window.chessBackgroundWorker?.analyzeMatch) {
      const grades = await window.chessBackgroundWorker.analyzeMatch(matchData, {
        scope: 'all',
        timeBudgetMs: 150,
        maxNodes: 25_000,
      })
      coachingGradesCache.set(cacheKey, grades)
      if (coachingGradesCache.size > 25) coachingGradesCache.delete(coachingGradesCache.keys().next().value)
      return grades
    }
  } catch (error) {
    console.warn('[analysis] batch worker unavailable; grading incrementally:', error?.message || error)
  }

  const running = new ChessGame()
  const grades = []
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index]
    const mover = running.currentTurn
    const analysis = gradeMoveInPositionSync(running, move, {
      whiteName: matchData.whiteName,
      blackName: matchData.blackName,
    })
    if (analysis) grades.push({ moveIndex: index, mover, ...analysis })
    if (!running.makeMove(move.fr, move.fc, move.toR, move.toC, move.promType || 'queen')) break
  }
  coachingGradesCache.set(cacheKey, grades)
  return grades
}

// The subject's single worst graded ply — the "review this together" landing
// point for the guardian coaching drill-down. Null when there's no blunder.
function worstGradedPly(grades, subjectColor) {
  let worst = null
  for (const g of grades || []) {
    if (g.mover !== subjectColor || g.grade !== 'Better move available') continue
    if (!worst || g.loss > worst.loss) worst = g
  }
  return worst ? worst.moveIndex : null
}

let coachingRenderToken = 0

async function renderFamilyCoachingTab(userId, matchHistory) {
  const statusEl = document.getElementById('profile-coaching-status')
  const headlineEl = document.getElementById('profile-coaching-headline')
  const gridEl = document.getElementById('profile-coaching-grid')
  const gamesEl = document.getElementById('profile-coaching-games')
  if (!headlineEl || !gamesEl) return
  const token = ++coachingRenderToken
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))

  // Work from profileMatchHistoryRows (set by renderProfileMatchHistory just
  // before this runs) so drill-down indices line up with replayMatchHistoryAt.
  const candidates = profileMatchHistoryRows
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => Array.isArray(match.moves) && match.moves.length
      && (match.myColor === 'white' || match.myColor === 'black'))
    .slice(0, 5)

  if (!candidates.length) {
    if (statusEl) statusEl.textContent = ''
    headlineEl.textContent = 'No analyzable games yet — play a game or two and check back.'
    if (gridEl) gridEl.style.display = 'none'
    gamesEl.innerHTML = ''
    return
  }

  if (statusEl) statusEl.textContent = `Analyzing ${candidates.length} game${candidates.length === 1 ? '' : 's'}…`
  headlineEl.textContent = ''
  if (gridEl) gridEl.style.display = 'none'
  gamesEl.innerHTML = '<div class="profile-history-loading"><span></span><span></span><span></span></div>'

  // Grading re-runs the engine for every ply — a few hundred depth-2 evals
  // for 5 games. Yield between games so the UI stays responsive, and bail if
  // the user navigated to a different profile mid-analysis.
  const perGame = []
  for (const { match, index } of candidates) {
    await new Promise(resolve => setTimeout(resolve, 0))
    if (token !== coachingRenderToken) return
    const grades = await gradeAllMoves(match)
    if (token !== coachingRenderToken) return
    perGame.push({
      index,
      match,
      summary: summarizeCoachingGrades(grades, match.moves.length, match.myColor),
      worstPly: worstGradedPly(grades, match.myColor),
    })
  }
  if (token !== coachingRenderToken) return

  const combined = combineCoachingSummaries(perGame.map(g => g.summary))
  if (statusEl) statusEl.textContent = `Last ${combined.gamesAnalyzed} game${combined.gamesAnalyzed === 1 ? '' : 's'}`
  headlineEl.textContent = combined.headline
  if (gridEl) {
    gridEl.style.display = ''
    const set = (id, text) => {
      const el = document.getElementById(id)
      if (el) el.textContent = text
    }
    set('coaching-strong', combined.strongRate != null ? `${Math.round(combined.strongRate * 100)}%` : '—')
    set('coaching-blunders', String(combined.blunderCount))
    set('coaching-focus', combined.weakestPhase
      ? combined.weakestPhase[0].toUpperCase() + combined.weakestPhase.slice(1)
      : 'None')
  }

  gamesEl.innerHTML = perGame.map(({ index, match, summary, worstPly }) => {
    const result = match.result === 'win' ? 'Won' : match.result === 'loss' ? 'Lost' : 'Draw'
    const reviewHint = worstPly != null ? ' · tap to review the key moment together' : ''
    return `<button class="profile-history-row replayable" type="button" data-coaching-replay="${index}"${worstPly != null ? ` data-coaching-ply="${worstPly}"` : ''}>
      <span class="profile-history-result ${esc(match.result || '')}">${esc(result)}</span>
      <div class="profile-history-main">
        <strong>vs ${esc(match.opponentName || 'Opponent')}</strong>
        <span>${esc(summary.headline + reviewHint)}</span>
      </div>
    </button>`
  }).join('')
  gamesEl.querySelectorAll('[data-coaching-replay]').forEach(button => {
    button.addEventListener('click', () => {
      // Jumps into the replay viewer + per-move analysis panel, landing
      // directly on the child's worst moment (when there is one) so parent
      // and kid can review it together instead of scrubbing for it.
      const index = Number(button.dataset.coachingReplay)
      const ply = button.dataset.coachingPly
      replayMatchData(profileMatchHistoryRows[index], 'profile', {
        startIndex: ply != null ? Number(ply) : -1,
        returnTab: 'coaching',
      })
    })
  })
}

let spectatorAnalysisToken = 0

async function renderSpectatorAnalysis(matchData, replayIndex) {
  const panel = document.getElementById('spectator-analysis')
  const gradeEl = document.getElementById('spectator-analysis-grade')
  const textEl = document.getElementById('spectator-analysis-text')
  const recEl = document.getElementById('spectator-analysis-recommendation')
  if (!panel || !gradeEl || !textEl || !recEl) return

  if (replayIndex < 0 || matchData.active) {
    spectatorAnalysisToken++
    panel.style.display = 'none'
    return
  }

  const token = ++spectatorAnalysisToken
  panel.style.display = ''
  gradeEl.textContent = 'Analyzing…'
  textEl.textContent = 'Reviewing this position without blocking the board.'
  recEl.textContent = ''
  const result = await analyzeReplayMove(matchData, replayIndex)
  if (token !== spectatorAnalysisToken || spectatorLastMatchData !== matchData) return
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

  void renderSpectatorAnalysis(matchData, replayIndex)
}

window.addEventListener('beforeunload', disconnectPresence)
window.addEventListener('pagehide', pausePresence)
async function restoreRealtimeAfterResume() {
  try {
    await refreshIfStale()
  } catch (error) {
    console.warn('[AGS lifecycle] session refresh after resume failed:', error?.message || error)
  } finally {
    // A transient refresh failure must not leave realtime permanently paused;
    // Presence will reconnect persistently and the session timer will retry.
    if (sdk.getToken()?.accessToken) resumePresence()
    // Club status refresh-on-resume (dev-plan §11.7): non-forced — the 1h
    // cache TTL inside fetchClubStatus is exactly the "when cache older
    // than 1h" rule, so a recent cache stays untouched.
    if (currentUserId) void initClubPanel(isProtectedChildSession())
  }
}

window.addEventListener('pageshow', () => { void restoreRealtimeAfterResume() })
document.addEventListener('visibilitychange', () => {
  const native = !!window.Capacitor?.isNativePlatform?.()
  if (document.visibilityState === 'hidden' && native) {
    // iOS suspends background sockets; close cleanly and reconnect with a
    // fresh token on foreground. Web tabs stay connected so browser game
    // invite notifications can actually arrive while the tab is hidden.
    pausePresence()
  } else if (document.visibilityState === 'visible') {
    void restoreRealtimeAfterResume()
  }
})

initializeLegalReader()
offlineFriendsOverlay.bindDismissal()
leaderboardOverlay.bindDismissal()
coinStoreOverlay.bindDismissal()
// Bound directly (not data-click) so the overlay controller reliably gets the
// clicked element as its focus-return trigger across engines.
document.getElementById('lb-view-more')?.addEventListener('click', event => openLeaderboardOverlay(event.currentTarget))
initAuth()
// Registers the StoreKit approved/verified/finished pipeline at genuine app
// startup, independent of sign-in — a previously-unfinished transaction must
// be re-delivered and re-synced with AGS even before hydration completes
// (dev-plan §7.3 "Finish ordering"). No-ops immediately on web.
if (window.Capacitor?.isNativePlatform?.()) void initNativeIAP()

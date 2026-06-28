import { loginWithGoogle, loginWithPassword, registerWithPassword, handleCallback, getProfile, getDisplayName, updateDisplayName, syncBasicProfile, logout, refreshSession, hasStoredSession, clearStoredSession } from './auth.js'
import { sdk } from './ags-client.js'
import { fetchPendingLegalDocuments, acceptLegalDocuments } from './legal.js'
import { initStats, fetchStats, incrementStat, fetchMatchHistory, recordMatchHistory, fetchStreak, updateStreak, migrateStreakFromCloudSave } from './stats.js'
import { primeUnlockedCache, diffNewlyUnlocked, unlockEventAchievement, clearUnlockedCache, fetchMergedAchievements } from './achievements.js'
import { sendEvent, flushPendingEvents, captureUtm } from './telemetry.js'
import { publishLiveMatch, clearLiveMatch, startWatching, stopWatching } from './spectator.js'
import { fetchTopRankings, fetchUserRank, resolveDisplayNames, enrichDisplayNames, cacheDisplayName, fetchInviterName } from './leaderboard.js'
import { startMatchmaking, cancelMatchmaking } from './matchmaking.js'
import { fetchFriendState, requestFriend, acceptFriend, rejectFriend, cancelFriendRequest, getFriendshipStatus, addFriendByEmail, storePendingInvite, processIncomingInviteAcceptances } from './friends.js'
import { setPresenceStatus, disconnectPresence, pausePresence, resumePresence, signOutPresence, subscribePresenceUpdates, subscribeGameInvites, subscribeLobbyOpen, sendGameInvite, subscribeInviteJoins, sendInviteJoinNotification } from './presence.js'
import { ensureNotificationPermission, notify } from './notifications.js'

let currentUserId = null
let currentUserWins = 0
let currentStreak = 0
let seenIncomingRequestIds = null  // null until first friends load — avoids notifying for pre-existing requests
let pendingLegalDocuments = []
let pendingLegalProfile = null
let friendsState = { friends: [], incoming: [], outgoing: [] }
let friendsRefreshTimer = null
let unsubscribePresenceUpdates = null
let unsubscribeGameInvites = null
let unsubscribeInviteJoins = null
let unsubscribeLobbyOpen = null
let activeProfileUser = null
let spectatorPrevScreen = null
let profileMatchHistoryRows = []

function setAuthMessage(kind, text, tone = '') {
  const el = document.getElementById(`ags-${kind}-message`)
  if (!el) return
  el.className = `auth-message${tone ? ' ' + tone : ''}`
  el.textContent = text || ''
}

function clearAuthMessages() {
  setAuthMessage('login', '')
  setAuthMessage('register', '')
}

function showInviteConfirmation(invitedBy, onAccept) {
  const el = document.getElementById('ags-friends-message')
  if (!el) return
  el.className = 'auth-message'
  el.textContent = ''

  const msg = document.createElement('span')
  msg.textContent = 'You were invited by a friend. Add them?'

  const acceptBtn = document.createElement('button')
  acceptBtn.className = 'btn-mini success'
  acceptBtn.textContent = 'Yes, add friend'
  acceptBtn.style.marginLeft = '8px'

  const declineBtn = document.createElement('button')
  declineBtn.className = 'btn-mini'
  declineBtn.textContent = 'No thanks'
  declineBtn.style.marginLeft = '4px'

  const dismiss = () => { el.textContent = '' }

  acceptBtn.addEventListener('click', () => { dismiss(); onAccept() })
  declineBtn.addEventListener('click', dismiss)

  el.appendChild(msg)
  el.appendChild(acceptBtn)
  el.appendChild(declineBtn)
}

// Tell the Extend service who referred this newly-registered user, so the
// inviter's chess-recruiter achievement unlocks server-side. Best-effort.
async function reportReferral() {
  const inviter = sessionStorage.getItem('chess_invite_by')
  const token = sdk.getToken()?.accessToken
  if (!inviter || !token || inviter === currentUserId) return
  try {
    const extendBase = import.meta.env.VITE_EXTEND_EMAIL_URL || '/extend'
    await fetch(`${extendBase}/referral`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ inviterUserId: inviter }),
    })
    sendEvent('referral_reported', { inviter_user_id: inviter })
  } catch {}
  sessionStorage.removeItem('chess_invite_by')
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
  const emailUrl     = addUtm(url, 'email', campaign)
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
        const token = sdk.getToken()?.accessToken ?? null
        const extendBase = import.meta.env.VITE_EXTEND_EMAIL_URL || '/extend'
        const res = await fetch(`${extendBase}/invite/email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
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
  startFriendsRefresh()
  await refreshFriendsUI()

  const urlParams = new URLSearchParams(window.location.search)
  const invitedBy = urlParams.get('invitedBy')
  if (invitedBy && invitedBy !== currentUserId) {
    // Notify the inviter in real-time (once per session per inviter)
    const notifKey = `chess_join_notif_${invitedBy}`
    if (!sessionStorage.getItem(notifKey)) {
      sessionStorage.setItem(notifKey, '1')
      sendInviteJoinNotification({ to: invitedBy, fromUserId: currentUserId, fromName: name }).catch(() => {})
    }
    window.history.replaceState({}, '', window.location.pathname + window.location.hash)
    showInviteConfirmation(invitedBy, async () => {
      const state = await fetchFriendState()
      const hasIncomingFromInviter = state.ok && state.incoming?.some(r => r.userId === invitedBy)
      if (hasIncomingFromInviter) {
        const result = await acceptFriend(invitedBy)
        if (result.ok) setFriendsMessage('Invite accepted! You are now friends.', 'success')
      } else {
        const result = await requestFriend(invitedBy)
        if (result.ok) setFriendsMessage('Almost there — you\'ll be friends automatically once your inviter is online.', 'success')
      }
      await refreshFriendsUI(false)
    })
  }

  await initStats(currentUserId)
  await migrateStreakFromCloudSave(currentUserId)  // one-time CloudSave→Statistics backfill (no-op after first run)
  const [stats, streakData] = await Promise.all([fetchStats(currentUserId), fetchStreak(currentUserId)])
  currentUserWins = stats?.wins ?? 0
  currentStreak = streakData?.streak ?? 0
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

  const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  if (!documents.length) {
    listEl.innerHTML = '<article class="legal-doc-card"><h3>Legal documents unavailable</h3><p>We could not load the required agreements for this account. Sign out and try again.</p></article>'
    return
  }

  listEl.innerHTML = documents.map(doc => {
    const meta = [
      doc.policyType || 'Legal document',
      doc.policyVersionDisplay ? `Version ${doc.policyVersionDisplay}` : '',
      doc.localeCode ? doc.localeCode.toUpperCase() : '',
    ].filter(Boolean).join(' · ')

    return `<article class="legal-doc-card">
      <div class="legal-doc-meta">${esc(meta)}</div>
      <h3>${esc(doc.policyName || 'Legal document')}</h3>
      <p>${esc(doc.description || 'Review and accept this document to continue.')}</p>
    </article>`
  }).join('')
}

function showLegalGate(documents, profile = null, message = '') {
  pendingLegalDocuments = documents
  pendingLegalProfile = profile
  renderLegalDocuments(documents)
  setLegalMessage(message || '')
  const checkbox = document.getElementById('ags-legal-confirm')
  if (checkbox) checkbox.checked = false
  const acceptBtn = document.getElementById('ags-legal-accept')
  if (acceptBtn) acceptBtn.disabled = documents.length === 0
  if (typeof window.showScreen === 'function') window.showScreen('legal')
}

function setLegalMessage(text, tone = '') {
  const el = document.getElementById('ags-legal-message')
  if (!el) return
  el.className = `auth-message${tone ? ' ' + tone : ''}`
  el.textContent = text || ''
}

async function maybeRequireLegalAcceptance(profile = null, tokenData = null) {
  if (tokenData && tokenData.is_comply === true) return true

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
  if (typeof window.showScreen === 'function') window.showScreen('home')
  return true
}

async function initAuth() {
  window.agsRefreshLeaderboard = refreshLeaderboard
  window.cacheDisplayName = cacheDisplayName

  const params = new URLSearchParams(window.location.search)
  const hashParams = new URLSearchParams(window.location.hash.slice(1))
  const hasCallback = params.has('code') || params.has('error') ||
                      hashParams.has('id_token') || hashParams.has('error')

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
      currentUserId = null
      window.agsCurrentUserId = null
      updateAuthUI(false, null, null)
      updateStatsUI(null)
      refreshLeaderboard()
    }
  } else {
    stopFriendsRefresh()
    stopPresenceUpdates()
    stopGameInviteUpdates()
    stopInviteJoinUpdates()
    currentUserId = null
    window.agsCurrentUserId = null
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
  window.agsLogout = async () => {
    stopFriendsRefresh()
    stopPresenceUpdates()
    stopGameInviteUpdates()
    stopInviteJoinUpdates()
    seenIncomingRequestIds = null
    currentStreak = 0
    clearUnlockedCache()
    await signOutPresence()
    await logout()
  }
  window.agsOpenLogin = () => {
    clearAuthMessages()
    if (typeof window.showScreen === 'function') window.showScreen('login')
  }
  window.agsOpenRegister = () => {
    clearAuthMessages()
    if (typeof window.showScreen === 'function') window.showScreen('register')
    if (prefilledEmail) {
      const emailField = document.getElementById('ags-register-email')
      if (emailField && !emailField.value) emailField.value = prefilledEmail
    }
  }
  window.agsPasswordLogin = async () => {
    const identifier = document.getElementById('ags-login-identifier')?.value.trim() || ''
    const password = document.getElementById('ags-login-password')?.value || ''
    const button = document.getElementById('ags-login-submit')
    if (!identifier || !password) {
      setAuthMessage('login', 'Enter your username or email and password.', 'error')
      return
    }
    if (button) button.disabled = true
    setAuthMessage('login', 'Signing in…')
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
  window.agsRegister = async () => {
    const emailAddress = document.getElementById('ags-register-email')?.value.trim() || ''
    const displayName = document.getElementById('ags-register-display-name')?.value.trim() || ''
    const password = document.getElementById('ags-register-password')?.value || ''
    const button = document.getElementById('ags-register-submit')
    if (!emailAddress || !displayName || !password) {
      setAuthMessage('register', 'Enter email, display name, and password.', 'error')
      return
    }
    if (button) button.disabled = true
    setAuthMessage('register', 'Creating account…')
    const created = await registerWithPassword({ emailAddress, displayName, password })
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
    if (!checkbox?.checked) {
      setLegalMessage('Confirm that you accept the required documents before continuing.', 'error')
      return
    }

    if (acceptBtn) acceptBtn.disabled = true
    setLegalMessage('Accepting documents…')

    const accepted = await acceptLegalDocuments(pendingLegalDocuments)
    if (!accepted.ok) {
      if (acceptBtn) acceptBtn.disabled = false
      setLegalMessage(accepted.error, 'error')
      return
    }

    if (!accepted.comply) {
      if (acceptBtn) acceptBtn.disabled = false
      setLegalMessage('Your account is still missing required agreements. Please try again.', 'error')
      return
    }

    const refreshed = await refreshSession()
    if (!refreshed.ok) {
      console.warn('[AGS] refreshSession after legal accept:', refreshed.error)
    }

    const profile = pendingLegalProfile || await getProfile()
    if (!profile) {
      if (acceptBtn) acceptBtn.disabled = false
      setLegalMessage('Accepted, but failed to restore your session. Please sign in again.', 'error')
      return
    }

    pendingLegalDocuments = []
    pendingLegalProfile = null
    setLegalMessage('')
    await hydrateAuthenticatedUser(profile)
    if (typeof window.showScreen === 'function') window.showScreen('home')
  }
  window.agsDeclineLegal = async () => {
    stopFriendsRefresh()
    stopPresenceUpdates()
    stopGameInviteUpdates()
    stopInviteJoinUpdates()
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
    const esc = window.escapeHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    const emailInput = document.getElementById('ags-add-friend-email')
    const resultEl = document.getElementById('ags-add-friend-result')
    const email = emailInput?.value.trim() || ''
    if (!email) return
    if (resultEl) resultEl.innerHTML = '<span class="auth-message">Looking up…</span>'

    const result = await addFriendByEmail(email, currentUserId)

    if (!result.ok) {
      if (resultEl) resultEl.innerHTML = `<span class="auth-message error">${esc(result.error)}</span>`
      return
    }

    if (result.found) {
      if (resultEl) resultEl.innerHTML = `<span class="auth-message success">Friend request sent to ${esc(result.displayName)}!</span>`
      if (emailInput) emailInput.value = ''
      sendEvent('friend_request_sent', { source: 'email_lookup' })
      await refreshFriendsUI(false)
      return
    }

    // User not found — store pending invite and show share options
    storePendingInvite(email, currentUserId)
    const inviteUrl = addUtm(window.location.origin + window.location.pathname + '?invitedBy=' + encodeURIComponent(currentUserId) + '&email=' + encodeURIComponent(email), 'email')
    if (resultEl) {
      resultEl.innerHTML = `
        <span class="auth-message">No account found. Share this invite:</span>
        <div class="invite-link-box" style="margin:6px 0">
          <span class="invite-link-text">${esc(inviteUrl)}</span>
        </div>
      `
      const fromName = document.getElementById('ags-signedin-name')?.textContent || 'A friend'
      mountShareRow(resultEl, inviteUrl, { emailTo: email, fromName })
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
      if (result) result.innerHTML = ''
    }
  }
  window.agsShareRow = mountShareRow
  window.agsGetInviteUrl = () =>
    currentUserId
      ? window.location.origin + window.location.pathname + '?invitedBy=' + encodeURIComponent(currentUserId)
      : null
  window.agsCopyInviteLink = () => {
    const link = window.location.origin + window.location.pathname + (currentUserId ? `?invitedBy=${encodeURIComponent(currentUserId)}` : '')
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
    await runFriendAction(() => requestFriend(opponent.userId), 'Friend request sent.')
    await updatePostMatchFriendAction(opponent)
  }
  window.agsGetStats = (userId) => fetchStats(userId)
  window.agsGetToken = () => sdk.getToken()?.accessToken ?? null
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
  window.agsUnlockAchievement = (code) => {
    if (!currentUserId || !code) return
    return unlockEventAchievement(currentUserId, code)
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
    if (!form || !input) return
    input.value = nameEl?.textContent || ''
    form.style.display = ''
    input.focus()
    input.select()
  }
  window.agsProfileCancelEdit = () => {
    const form = document.getElementById('profile-name-edit-form')
    if (form) form.style.display = 'none'
  }
  window.agsProfileSaveName = async () => {
    const input = document.getElementById('profile-name-edit-input')
    const saveBtn = document.getElementById('profile-btn-save-name')
    const nameEl = document.getElementById('profile-display-name')
    const form = document.getElementById('profile-name-edit-form')
    if (!input) return
    const newName = input.value.trim()
    if (!newName) return
    if (saveBtn) saveBtn.disabled = true
    const updated = await updateDisplayName(newName)
    if (saveBtn) saveBtn.disabled = false
    if (updated) {
      const name = getDisplayName(updated)
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
    if (!form || !input) return
    input.value = nameEl?.textContent || ''
    form.style.display = ''
    input.focus()
    input.select()
  }

  window.agsCancelEdit = () => {
    const form = document.getElementById('name-edit-form')
    if (form) form.style.display = 'none'
  }

  window.agsSaveName = async () => {
    const input = document.getElementById('name-edit-input')
    const saveBtn = document.getElementById('btn-save-name')
    const form = document.getElementById('name-edit-form')
    if (!input) return
    const newName = input.value.trim()
    if (!newName) return
    if (saveBtn) saveBtn.disabled = true
    const updated = await updateDisplayName(newName)
    if (saveBtn) saveBtn.disabled = false
    if (updated) {
      const name = getDisplayName(updated)
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

async function openPublicProfile(userId, displayName = '') {
  const esc = window.escapeHtml || (s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
  activeProfileUser = { userId, displayName }
  const nameEl = document.getElementById('profile-display-name')
  const winsEl = document.getElementById('profile-wins')
  const lossesEl = document.getElementById('profile-losses')
  const rankEl = document.getElementById('profile-rank')
  const statusEl = document.getElementById('profile-friend-status')
  const addBtn = document.getElementById('profile-add-friend-btn')
  const matchHistoryEl = document.getElementById('profile-match-history')
  const matchHistoryCountEl = document.getElementById('profile-match-history-count')

  const editBtn = document.getElementById('profile-btn-edit-name')
  const editForm = document.getElementById('profile-name-edit-form')

  if (typeof window.showScreen === 'function') window.showScreen('profile')
  if (nameEl) nameEl.textContent = displayName || userId.slice(0, 8)
  if (editBtn) editBtn.style.display = 'none'
  if (editForm) editForm.style.display = 'none'
  if (winsEl) winsEl.textContent = '...'
  if (lossesEl) lossesEl.textContent = '...'
  if (rankEl) rankEl.textContent = '...'
  if (statusEl) statusEl.textContent = 'Loading profile...'
  if (addBtn) addBtn.style.display = 'none'
  if (matchHistoryCountEl) matchHistoryCountEl.textContent = 'Loading'
  if (matchHistoryEl) matchHistoryEl.innerHTML = '<div class="profile-history-loading"><span></span><span></span><span></span></div>'

  const [stats, rank, matchHistory] = await Promise.all([
    fetchStats(userId),
    fetchUserRank(userId),
    fetchMatchHistory(userId),
  ])

  if (winsEl) winsEl.textContent = stats?.wins ?? 0
  if (lossesEl) lossesEl.textContent = stats?.losses ?? 0
  if (rankEl) rankEl.textContent = rank?.rank ? `#${rank.rank}` : 'Unranked'
  renderProfileMatchHistory(matchHistory)

  const friend = friendsState.friends.find(item => item.userId === userId)
  const incoming = friendsState.incoming.find(item => item.userId === userId)
  const outgoing = friendsState.outgoing.find(item => item.userId === userId)

  if (userId === currentUserId) {
    if (statusEl) statusEl.textContent = 'This is your profile.'
    if (editBtn) editBtn.style.display = ''
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

function updateAuthUI(loggedIn, name, userId) {
  const nameInput = document.getElementById('player-name-input')
  const signInBtn = document.getElementById('ags-signin-btn')
  const authActions = document.getElementById('ags-auth-actions')
  const authOrDivider = document.getElementById('ags-auth-or-divider')
  const guestDivider = document.getElementById('ags-guest-divider')
  const signedInInfo = document.getElementById('ags-signedin-info')
  const signedInName = document.getElementById('ags-signedin-name')
  const lbCta = document.getElementById('lb-signin-cta')

  if (!nameInput || !signInBtn || !signedInInfo) return

  if (loggedIn) {
    nameInput.style.display = 'none'
    signInBtn.style.display = 'none'
    if (authActions) authActions.style.display = 'none'
    if (authOrDivider) authOrDivider.style.display = 'none'
    if (guestDivider) guestDivider.style.display = 'none'
    if (lbCta) lbCta.style.display = 'none'
    signedInInfo.style.display = 'flex'
    if (signedInName) signedInName.textContent = name || 'Player'
  } else {
    nameInput.style.display = ''
    signInBtn.style.display = ''
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
    el.textContent = s > 0
      ? `W ${stats.wins}  ·  L ${stats.losses}  ·  🔥 ${s}`
      : `W ${stats.wins}  ·  L ${stats.losses}`
  } else {
    el.style.display = 'none'
  }
}

function escAch(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function showAchievementToast(items) {
  const container = document.getElementById('achievement-toasts')
  if (!container || !items?.length) return
  for (const it of items) {
    const el = document.createElement('div')
    el.className = 'achievement-toast'
    el.innerHTML =
      `${it.icon ? `<img src="${escAch(it.icon)}" alt="" class="ach-toast-icon">` : '<span class="ach-toast-icon">🏆</span>'}` +
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
      const footer = a.unlocked
        ? `<span class="ach-card-done">✓ Unlocked</span>` +
          `<button class="ach-share-btn" data-code="${escAch(a.code)}">📤 Share</button>` +
          `<div class="ach-share-slot"></div>`
        : `<div class="ach-progress"><div class="ach-progress-fill" style="width:${pct}%"></div></div>` +
          `<span class="ach-progress-text">${a.progress} / ${a.goalValue}</span>`
      return (
        `<div class="ach-card${a.unlocked ? ' unlocked' : ' locked'}">` +
          `${a.icon ? `<img src="${escAch(a.icon)}" alt="" class="ach-card-icon">` : '<span class="ach-card-icon">🏆</span>'}` +
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

async function runFriendAction(action, successMessage) {
  setFriendsMessage('Updating friends...')
  const result = await action()
  if (!result.ok) {
    setFriendsMessage(result.error, 'error')
    return false
  }
  setFriendsMessage(successMessage, 'success')
  await refreshFriendsUI(false)
  return true
}

async function refreshFriendsUI(showLoading = true) {
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
  setFriendsMessage('')
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

function showInviteJoinToast({ fromUserId, fromName }) {
  const toast = document.getElementById('invite-join-toast')
  if (!toast) return
  const nameEl = document.getElementById('invite-join-name')
  if (nameEl) {
    nameEl.textContent = fromName
      ? `${fromName} just signed up via your invite!`
      : 'Someone just signed up via your invite!'
  }
  toast.classList.add('show')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.remove('show'), 10000)
  sendEvent('invite_join_notif_shown', { hasName: !!fromName })
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

const SPECTATOR_SYMBOLS = {
  white: { king:'♔', queen:'♕', rook:'♖', bishop:'♗', knight:'♘', pawn:'♙' },
  black: { king:'♚', queen:'♛', rook:'♜', bishop:'♝', knight:'♞', pawn:'♟' },
}

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
        p.textContent = SPECTATOR_SYMBOLS[piece.color][piece.type]
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

initAuth()

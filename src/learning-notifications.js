// Lazy orchestrator for the chess-improvement notification system (notification
// dev-plan N1/N2: §11, §12, §13.1, §13.11, §15). Loaded only behind
// VITE_LEARNING_NOTIFICATIONS_V1 via src/main.js's learningNotificationsFeature
// loader — never statically imported, so a player with the flag off never
// pays for this chunk.
//
// This module reaches Journal/Review data the same way the rest of the
// learning loop already crosses lazy-module boundaries: through the narrow
// window seams src/main.js exposes (window.agsLoadLearningNotificationInputs,
// window.agsLoadLearningIndex, window.agsLoadReviewBadge) rather than a
// static import of journal.js/review.js, so this chunk doesn't pull in
// Journal's or Review's own dependency graph a second time.
//
// The "Remind me on this device" / category / preferred-time / quiet-hours
// controls only render when VITE_LEARNING_NATIVE_REMINDERS_V1 is on — that
// flag defaults false until N3 actually builds a native adapter to consume
// these preferences, so in production today this settings panel only ever
// shows the in-app toggle and the pause button, both of which are fully
// functional without any native plugin.

import { deriveLearningCandidates, formatLearningCopy, resolveLearningIntent } from './learning-notification-data.mjs'
import { selectInAppCandidate, planNativeReminder, isWithinQuietHours, isLive } from './learning-notification-policy.mjs'
import { subscribeLearningStateChanged } from './learning-events.mjs'
import { loadLearningPreferences, saveLearningPreferences } from './learning-notification-preferences.mjs'
import {
  loadLearningLedger, recordDismissedForToday, recordExternalDelivery, recordPendingReminder, clearPendingReminder,
} from './learning-notification-ledger.mjs'
import {
  isNativePlatformAvailable, checkLearningReminderPermission, requestLearningReminderPermission,
  scheduleLearningReminder, cancelLearningReminder, cancelAllLearningReminders, subscribeLearningReminderAction,
  NATIVE_ID_FOR_KIND,
} from './native-learning-notifications.mjs'
import { sendEvent } from './telemetry.js'

const CARD_ID = 'learning-next-step'
const SOFT_PROMPT_ID = 'learning-reminder-soft-prompt'
const SETTINGS_ID = 'learning-notification-settings'
const RECONCILE_DEBOUNCE_MS = 250
const COPY_VERSION = 'v1'
const CATEGORY_LABELS = { practice: 'Personal practice', review: 'Quick Review reminders' }
const PENDING_INTENT_TTL_MS = 24 * 3600000 // dev-plan §13.11: "Expire a pending intent after 24 hours"

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

let state = {
  userId: null,
  isChild: false,
  // Rollout-resolved once at init (notification dev-plan §17 N4) — this
  // module's mere existence being loaded+init'd already implies
  // notificationsV1 passed the rollout check in src/main.js, so only the
  // native-specific flag needs to be threaded through as state.
  nativeRemindersEnabled: false,
  unsubscribe: null,
  reconcileToken: 0,
  reconcileTimer: null,
  pendingReason: '',
  activeGoalLabel: '',
  lastRenderedKey: '',
  permissionStatus: '',
}
// Native action listener is process-lifetime, not per-account — subscribed
// once ever, independent of sign-in/out (dev-plan §13.11: cold-start taps
// must be caught before auth is even established).
let nativeActionListenerStarted = false
// Cold-start tap payload, held only in memory until auth is ready to route
// it (dev-plan §13.11 "defer routing until authentication is ready").
let pendingNativeIntent = null

async function safeCall(fn, fallback) {
  try {
    const result = await fn?.()
    return result == null ? fallback : result
  } catch (error) {
    console.warn('[learning-notifications] snapshot source unavailable:', error?.message || error)
    return fallback
  }
}

// computeReviewSnapshot: cross-checks each 'ready' review against the actual
// match (fingerprint + replayable) via the SAME reviewBadge() History already
// trusts (dev-plan §7.3 "a matching History game exists... fingerprint still
// matches... remains replayable") — never a looser count than History itself
// would show as "Lesson ready".
async function computeReviewSnapshot(userId, matchHistory) {
  const flags = window.agsLearningFlags?.() || {}
  if (!flags.indexV1 || !flags.reviewV2) return { unfinishedCount: 0, oldestReadyAt: null }
  if (typeof window.agsLoadLearningIndex !== 'function' || typeof window.agsLoadReviewBadge !== 'function') {
    return { unfinishedCount: 0, oldestReadyAt: null }
  }
  try {
    const record = await window.agsLoadLearningIndex(userId)
    let unfinishedCount = 0
    let oldestReadyAt = null
    for (const match of matchHistory || []) {
      const badge = await window.agsLoadReviewBadge(record, match)
      if (badge?.label !== 'Lesson ready') continue
      unfinishedCount++
      const review = record?.reviews?.find(r => r.matchId === match.id)
      if (review?.analyzedAt && (!oldestReadyAt || review.analyzedAt < oldestReadyAt)) oldestReadyAt = review.analyzedAt
    }
    return { unfinishedCount, oldestReadyAt }
  } catch (error) {
    console.warn('[learning-notifications] review snapshot unavailable:', error?.message || error)
    return { unfinishedCount: 0, oldestReadyAt: null }
  }
}

// buildSnapshot: composes the learning snapshot (dev-plan §13.4) from two
// independent sources — a failure in one never zeroes out the other's
// candidates (N1 acceptance: "a source failure removes only its dependent
// candidate").
async function buildSnapshot(userId) {
  const inputs = await safeCall(
    () => window.agsLoadLearningNotificationInputs?.(userId),
    { playableDueCount: 0, nextPlayableDueAt: null, activeGoal: null, replayableNewMatchCount: 0, oldestNewMatchAt: null, matchHistory: [] },
  )
  const review = await computeReviewSnapshot(userId, inputs.matchHistory)
  const goal = inputs.activeGoal && Number.isFinite(inputs.activeGoal.target)
    ? {
        kind: inputs.activeGoal.kind,
        status: inputs.activeGoal.status,
        target: inputs.activeGoal.target,
        applicable: inputs.activeGoal.applicable,
        completed: inputs.activeGoal.completed,
        completedAt: inputs.activeGoal.completedAt || '',
      }
    : null
  const snapshot = {
    generatedAt: new Date().toISOString(),
    accountScope: userId,
    isChild: state.isChild,
    practice: { playableDueCount: inputs.playableDueCount || 0, nextPlayableDueAt: inputs.nextPlayableDueAt || null },
    review,
    goal,
    recap: { replayableNewMatchCount: inputs.replayableNewMatchCount || 0, oldestNewMatchAt: inputs.oldestNewMatchAt || null },
    activity: { lastLearningActionAt: '' },
  }
  return { snapshot, activeGoalLabel: inputs.activeGoal?.label || '' }
}

// ─── In-app home card ─────────────────────────────────────────────────────

function onDismiss(candidate) {
  recordDismissedForToday(state.userId, candidate.kind)
  sendEvent('learning_nudge_dismissed', { kind: candidate.kind, surface: 'home_card' })
  render(null)
}

// routeToIntent: the shared destination-mapping path (dev-plan §12.4,
// §13.11) for both an in-app CTA tap and a native cold-start/foreground tap.
function routeToIntent(intent) {
  const route = resolveLearningIntent({ target: { intent } })
  if (!route) return
  if (typeof window.agsOpenMyProfile === 'function') window.agsOpenMyProfile()
  if (route.tab && typeof window.agsShowProfileTab === 'function') window.agsShowProfileTab(route.tab)
  if (route.anchor) {
    // The tab panel needs a paint before its anchor has real layout to scroll to.
    requestAnimationFrame(() => {
      document.getElementById(route.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
}

// Stale destination (dev-plan §12.5): a tap never carries stale data INTO
// the destination — it only points at a screen/anchor, and both Journal
// and History already re-render live from current CloudSave state on open
// (src/journal.js's renderNextAction/renderPracticeQueue, called every time
// the tab shows), with Journal's own "You're all caught up" copy already
// covering "resolved elsewhere." scheduleReconcile() here additionally
// refreshes THIS module's own state promptly rather than waiting for the
// next unrelated event.

function onOpen(candidate) {
  sendEvent('learning_nudge_opened', { kind: candidate.kind, channel: 'in_app' })
  routeToIntent(candidate.target?.intent)
  scheduleReconcile()
}

// handleNativeReminderAction: a tap on a delivered native reminder. Routes
// immediately if a user is already signed in (foreground tap); otherwise
// holds the intent in memory until initLearningNotifications() runs after
// sign-in/session-restore (cold start), matching §13.11's processing order.
function handleNativeReminderAction({ kind, intent }) {
  sendEvent('learning_nudge_opened', { kind, channel: 'native_local' })
  if (state.userId) {
    clearPendingReminder(state.userId)
    routeToIntent(intent)
    scheduleReconcile()
  } else {
    pendingNativeIntent = { intent, receivedAt: new Date().toISOString() }
  }
}

// consumePendingNativeIntent: called once auth is ready (dev-plan §13.11
// step 4→5) so a cold-start tap that arrived before sign-in still routes.
function consumePendingNativeIntent() {
  if (!pendingNativeIntent || !state.userId) return
  const { intent, receivedAt } = pendingNativeIntent
  pendingNativeIntent = null
  clearPendingReminder(state.userId)
  if (Date.now() - Date.parse(receivedAt) > PENDING_INTENT_TTL_MS) return // stale — dev-plan §13.11
  routeToIntent(intent)
}

// render: DOM ID `learning-next-step` (dev-plan §12.1) — reserves no space
// and shows nothing until a real candidate exists, so it never shifts the
// signed-in home layout on the way to its async state.
function render(candidate) {
  const container = document.getElementById(CARD_ID)
  if (!container) return
  const copy = candidate ? formatLearningCopy(candidate, 'in_app') : null
  if (!candidate || !copy) {
    container.style.display = 'none'
    container.innerHTML = ''
    state.lastRenderedKey = ''
    return
  }
  if (candidate.key !== state.lastRenderedKey) {
    state.lastRenderedKey = candidate.key
    sendEvent('learning_nudge_rendered', { kind: candidate.kind, surface: 'home_card', copy_version: COPY_VERSION })
  }
  // goal_focus_default has no title of its own (learning-notification-data.mjs)
  // — reuse the goal's own label, matching src/journal.js's existing
  // renderNextActionCard presentation for kind 'goal' (dev-plan §7.5).
  const title = copy.title || (candidate.kind === 'goal_focus' ? state.activeGoalLabel : '')
  container.style.display = ''
  container.setAttribute('role', 'status')
  container.setAttribute('aria-live', 'polite')
  container.innerHTML = `
    <div class="learning-next-step-head">
      <span class="learning-next-step-eyebrow">${esc(copy.eyebrow || 'Your next chess step')}</span>
      <button type="button" class="learning-next-step-dismiss">Not now</button>
    </div>
    <p class="learning-next-step-title">${esc(title)}</p>
    <p class="learning-next-step-body">${esc(copy.body)}</p>
    ${copy.cta ? `<button type="button" class="btn-mini success learning-next-step-cta">${esc(copy.cta)}</button>` : ''}
  `
  container.querySelector('.learning-next-step-dismiss')?.addEventListener('click', () => onDismiss(candidate))
  container.querySelector('.learning-next-step-cta')?.addEventListener('click', () => onOpen(candidate))
}

// ─── Contextual soft prompt (dev-plan §11.3) ───────────────────────────────
// Shown at most once ever per account (productOptInAt, once stamped either
// way, permanently suppresses it — the only way to satisfy "denial is
// respected without reprompt loops" using just the documented preference
// contract, which has no separate declined flag). Only reachable once N3
// ships a native adapter and flips VITE_LEARNING_NATIVE_REMINDERS_V1 on.

function renderSoftPrompt(reason) {
  const container = document.getElementById(SOFT_PROMPT_ID)
  if (!container) return
  const eligible = state.nativeRemindersEnabled && !state.isChild
    && !state.preferences.productOptInAt
    && (reason === 'review_finished' || reason === 'practice_attempted')
  if (!eligible) {
    container.style.display = 'none'
    container.innerHTML = ''
    return
  }
  container.style.display = ''
  container.innerHTML = `
    <p class="learning-soft-prompt-copy">Want a gentle reminder when another position is ready?</p>
    <div class="learning-soft-prompt-actions">
      <button type="button" class="btn-mini success" data-soft-prompt="accept">Turn on reminders</button>
      <button type="button" class="btn-mini" data-soft-prompt="decline">Not now</button>
    </div>
  `
  sendEvent('learning_reminder_soft_prompt_shown', { source_action: reason })
  container.querySelector('[data-soft-prompt="accept"]')?.addEventListener('click', () => resolveSoftPrompt(true))
  container.querySelector('[data-soft-prompt="decline"]')?.addEventListener('click', () => resolveSoftPrompt(false))
}

function resolveSoftPrompt(accepted) {
  updatePreferences(prev => ({ ...prev, nativeEnabled: accepted, productOptInAt: new Date().toISOString() }), 'native', accepted)
  const container = document.getElementById(SOFT_PROMPT_ID)
  if (container) { container.style.display = 'none'; container.innerHTML = '' }
  // Only "Turn on reminders" invokes the platform permission request — never
  // at launch, never merely because system permission is still default
  // (dev-plan §11.3).
  if (accepted && isNativePlatformAvailable()) {
    void requestLearningReminderPermission().then(display => {
      state.permissionStatus = display
      sendEvent('learning_reminder_permission_result', { platform: 'ios', result: display })
      renderSettingsPanel()
      scheduleReconcile()
    })
  }
}

// ─── Account settings panel (dev-plan §12.3) ───────────────────────────────

function updatePreferences(mutator, category, enabled) {
  const next = mutator(state.preferences)
  state.preferences = saveLearningPreferences(state.userId, next)
  if (category) sendEvent('learning_reminder_preference_changed', { category, enabled: !!enabled, channel: 'in_app' })
  renderSettingsPanel()
  scheduleReconcile()
}

// permissionStatusText: dev-plan §11.3 "If system permission is denied: show
// 'Notifications are off in device settings'... do not repeatedly invoke the
// system prompt."
function permissionStatusText(status) {
  if (status === 'granted') return 'Reminders are set up on this device.'
  if (status === 'denied') return 'Notifications are off in device settings.'
  return 'Requesting device permission…'
}

function quietHoursSummary(quietHours) {
  const fmt = hhmm => {
    const [h, m] = hhmm.split(':').map(Number)
    const period = h >= 12 ? 'PM' : 'AM'
    const hour12 = h % 12 === 0 ? 12 : h % 12
    return `${hour12}:${String(m).padStart(2, '0')} ${period}`
  }
  return `${fmt(quietHours.start)}–${fmt(quietHours.end)}`
}

export function renderSettingsPanel() {
  const container = document.getElementById(SETTINGS_ID)
  if (!container || !state.userId) return
  const prefs = state.preferences
  const paused = prefs.pausedUntil && Date.parse(prefs.pausedUntil) > Date.now()

  // Refresh a possibly-stale permission status once (e.g. the player granted
  // it from device Settings after previously denying) — never re-prompts,
  // only reads the current OS state (dev-plan §11.3).
  if (prefs.nativeEnabled && !state.permissionStatus && isNativePlatformAvailable()) {
    void checkLearningReminderPermission().then(display => {
      state.permissionStatus = display
      renderSettingsPanel()
    })
  }

  const nativeSection = state.isChild
    ? `<p class="learning-settings-note">Device reminders are not available on family accounts.</p>`
    : !state.nativeRemindersEnabled
      ? ''
      : `
    <label class="learning-settings-row">
      <input type="checkbox" data-setting="nativeEnabled" ${prefs.nativeEnabled ? 'checked' : ''} />
      <span>Remind me on this device</span>
    </label>
    ${prefs.nativeEnabled ? `<p class="learning-settings-note">${esc(permissionStatusText(state.permissionStatus))}</p>` : ''}
    <div class="learning-settings-categories" ${prefs.nativeEnabled ? '' : 'style="display:none"'}>
      ${['practice', 'review'].map(category => `
        <label class="learning-settings-row learning-settings-row-sub">
          <input type="checkbox" data-setting-category="${category}" ${prefs.categories[category] ? 'checked' : ''} />
          <span>${esc(CATEGORY_LABELS[category])}</span>
        </label>
      `).join('')}
      <label class="learning-settings-row learning-settings-row-sub">
        <span>Preferred reminder time</span>
        <input type="time" data-setting="preferredLocalTime" value="${esc(prefs.preferredLocalTime)}" />
      </label>
      <p class="learning-settings-note">Quiet hours: ${esc(quietHoursSummary(prefs.quietHours))}</p>
      <p id="learning-settings-time-error" class="learning-settings-error" aria-live="polite"></p>
    </div>
  `

  container.innerHTML = `
    <h3>Chess improvement reminders</h3>
    <label class="learning-settings-row">
      <input type="checkbox" data-setting="inAppEnabled" ${prefs.inAppEnabled ? 'checked' : ''} />
      <span>Show my next chess step in the app</span>
    </label>
    ${nativeSection}
    <button type="button" class="btn-mini" data-action="pause">
      ${paused ? `Reminders paused — Resume` : 'Pause for 14 days'}
    </button>
  `

  container.querySelector('[data-setting="inAppEnabled"]')?.addEventListener('change', event => {
    updatePreferences(prev => ({ ...prev, inAppEnabled: event.target.checked }), 'in_app', event.target.checked)
  })
  container.querySelector('[data-setting="nativeEnabled"]')?.addEventListener('change', event => {
    updatePreferences(prev => ({ ...prev, nativeEnabled: event.target.checked }), 'native', event.target.checked)
  })
  for (const category of ['practice', 'review']) {
    container.querySelector(`[data-setting-category="${category}"]`)?.addEventListener('change', event => {
      updatePreferences(prev => ({ ...prev, categories: { ...prev.categories, [category]: event.target.checked } }), `native_${category}`, event.target.checked)
    })
  }
  container.querySelector('[data-setting="preferredLocalTime"]')?.addEventListener('change', event => {
    const value = event.target.value
    const errorEl = document.getElementById('learning-settings-time-error')
    if (isWithinQuietHours(value, prefs.quietHours)) {
      if (errorEl) errorEl.textContent = 'Pick a time outside your quiet hours.'
      event.target.value = prefs.preferredLocalTime
      return
    }
    if (errorEl) errorEl.textContent = ''
    updatePreferences(prev => ({ ...prev, preferredLocalTime: value }), 'native_time', true)
  })
  container.querySelector('[data-action="pause"]')?.addEventListener('click', () => {
    if (paused) {
      updatePreferences(prev => ({ ...prev, pausedUntil: '' }), 'pause', false)
    } else {
      const until = new Date(Date.now() + 14 * 86400000).toISOString()
      updatePreferences(prev => ({ ...prev, pausedUntil: until }), 'pause', true)
    }
  })
}

// ─── Native reminder reconciliation (dev-plan §10.3, §10.7, N3) ────────────

function delayBucket(deliverAtIso, now) {
  return (Date.parse(deliverAtIso) - now.getTime()) < 20 * 3600000 ? 'same_day' : 'next_day'
}

// reconcileNativePlan: cancels a pending reminder whose candidate is no
// longer eligible (dev-plan §10.7 stale-state cancellation), then plans and
// schedules at most one new one. For a protected child this only ever
// cancels, never schedules (dev-plan §11.4) — a failure anywhere here must
// not affect the in-app card, so every step is independently guarded.
async function reconcileNativePlan(userId, candidates, context, now) {
  if (!isNativePlatformAvailable()) return
  let ledger = loadLearningLedger(userId)
  // Absolute invariant regardless of flags/timing (dev-plan §11.4): a
  // protected child must never have a pending external reminder, including
  // one scheduled before a late-resolving family-role signal flipped
  // isChild true.
  if (state.isChild) {
    if (ledger.pending) {
      const kind = ledger.pending.kind
      await cancelLearningReminder(kind)
      clearPendingReminder(userId)
      sendEvent('learning_reminder_cancelled', { kind, reason: 'protected_child' })
    }
    return
  }
  // Not gated by an early return — a previously-scheduled reminder must
  // still be cancelled below if the rollout flag or the player's own
  // preference turns off, not just if the candidate itself expires.
  const nativeAllowed = state.nativeRemindersEnabled && state.preferences.nativeEnabled
  if (ledger.pending) {
    const stillEligible = nativeAllowed
      && candidates.some(c => c.kind === ledger.pending.kind && isLive(c, now))
    if (!stillEligible) {
      const cancelledKind = ledger.pending.kind
      await cancelLearningReminder(cancelledKind)
      ledger = clearPendingReminder(userId)
      sendEvent('learning_reminder_cancelled', {
        kind: cancelledKind,
        reason: nativeAllowed ? 'no_longer_eligible' : 'not_enabled',
      })
    }
  }
  if (!nativeAllowed) return
  const plan = planNativeReminder(candidates, state.preferences, ledger, context, now)
  if (!plan) return
  const copy = formatLearningCopy(plan.candidate, 'external')
  const route = resolveLearningIntent(plan.candidate)
  if (!copy || !route) return
  const scheduled = await scheduleLearningReminder({
    kind: plan.candidate.kind, title: copy.title, body: copy.body, at: plan.deliverAt, intent: route.intent,
  })
  if (!scheduled) return
  recordExternalDelivery(userId, plan.candidate.kind, now)
  recordPendingReminder(userId, { nativeId: NATIVE_ID_FOR_KIND[plan.candidate.kind], kind: plan.candidate.kind, deliverAt: plan.deliverAt })
  sendEvent('learning_reminder_scheduled', { kind: plan.candidate.kind, delay_bucket: delayBucket(plan.deliverAt, now) })
}

// cancelPendingNativeReminder: called from src/main.js the moment a game
// starts (dev-plan §10.6/§14.1 "Game starts: Cancel pending native learning
// reminder"). A stale reminder opening into an active game would be exactly
// the "reminder opens stale work" risk the plan's risk register flags.
export async function cancelPendingNativeReminder() {
  if (!state.userId) return
  const ledger = loadLearningLedger(state.userId)
  if (!ledger.pending) return
  const kind = ledger.pending.kind
  await cancelLearningReminder(kind)
  clearPendingReminder(state.userId)
  sendEvent('learning_reminder_cancelled', { kind, reason: 'game_started' })
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

export async function reconcile() {
  // No separate notificationsV1/rollout re-check here: initLearningNotifications
  // (the only place state.userId is set) already required it, and resetLearningNotifications
  // (the only place it's cleared) unsubscribes this same reconcile from further events.
  if (!state.userId) return
  const userId = state.userId
  const token = ++state.reconcileToken
  const reason = state.pendingReason
  state.pendingReason = ''
  const { snapshot, activeGoalLabel } = await buildSnapshot(userId)
  if (token !== state.reconcileToken || state.userId !== userId) return // superseded, or logged out mid-fetch
  state.activeGoalLabel = activeGoalLabel
  const now = new Date()
  const candidates = deriveLearningCandidates(snapshot, now)
  const context = { isActiveExperience: !!window.agsIsActiveExperience?.(), isChild: state.isChild }
  const ledger = loadLearningLedger(userId)
  const picked = selectInAppCandidate(candidates, state.preferences, ledger, context, now)
  render(picked)
  renderSoftPrompt(reason)
  await reconcileNativePlan(userId, candidates, context, now)
}

export function scheduleReconcile(reason = '') {
  if (!state.userId) return
  if (reason) state.pendingReason = reason
  clearTimeout(state.reconcileTimer)
  state.reconcileTimer = setTimeout(() => { void reconcile() }, RECONCILE_DEBOUNCE_MS)
}

export async function initLearningNotifications({ userId, isChild = false, nativeRemindersEnabled = false } = {}) {
  if (!userId) return
  state.userId = userId
  state.isChild = isChild
  state.nativeRemindersEnabled = nativeRemindersEnabled
  state.preferences = loadLearningPreferences(userId)
  state.permissionStatus = ''
  if (!state.unsubscribe) {
    state.unsubscribe = subscribeLearningStateChanged(reason => scheduleReconcile(reason))
  }
  // Cold-start action listener is process-lifetime (dev-plan §13.11) —
  // started once regardless of how many times a user signs in this session.
  if (!nativeActionListenerStarted && nativeRemindersEnabled && isNativePlatformAvailable()) {
    nativeActionListenerStarted = true
    void subscribeLearningReminderAction(handleNativeReminderAction)
  }
  consumePendingNativeIntent()
  await reconcile()
}

export function resetLearningNotifications() {
  const loggedOutUserId = state.userId
  // Logout cancels every reserved learning-notification ID (dev-plan §10.8)
  // — fire-and-forget so logout itself is never blocked on the native
  // bridge; the account-scoped ledger is cleared synchronously regardless.
  if (loggedOutUserId && isNativePlatformAvailable()) {
    void cancelAllLearningReminders().catch(() => {})
  }
  if (loggedOutUserId) clearPendingReminder(loggedOutUserId)
  state.unsubscribe?.()
  clearTimeout(state.reconcileTimer)
  state = {
    userId: null, isChild: false, unsubscribe: null, reconcileToken: state.reconcileToken,
    reconcileTimer: null, pendingReason: '', activeGoalLabel: '', lastRenderedKey: '', preferences: null,
    permissionStatus: '',
  }
  const card = document.getElementById(CARD_ID)
  if (card) { card.style.display = 'none'; card.innerHTML = '' }
  const softPrompt = document.getElementById(SOFT_PROMPT_ID)
  if (softPrompt) { softPrompt.style.display = 'none'; softPrompt.innerHTML = '' }
  const settings = document.getElementById(SETTINGS_ID)
  if (settings) settings.innerHTML = ''
}

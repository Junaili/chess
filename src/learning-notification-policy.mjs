// Pure fatigue policy for the chess-improvement notification system: caps,
// cooldowns, quiet-hours/preferred-time scheduling, ignored-reminder backoff,
// and in-app/native selection (notification dev-plan §10, §13.5, §13.6,
// §13.7). No DOM, no storage, no clock reads — every decision function takes
// `now` explicitly. src/learning-notification-preferences.mjs and
// src/learning-notification-ledger.mjs (a later milestone) own the actual
// account-scoped localStorage read/write around the normalizers below; this
// module only decides, it never persists.

const DAY_MS = 86400000
const HOUR_MS = 3600000
const EXTERNAL_DELIVERY_HISTORY_CAP = 30
const EXTERNAL_DELIVERY_HISTORY_MAX_DAYS = 45

// categoryForKind: which settings-screen category (dev-plan §11.2, §12.3)
// governs a candidate's external delivery. goal_achieved/goal_focus share
// 'goal' even though goal_achieved never reaches native in N3 — the category
// check is harmless dead weight for it since allowedChannels already excludes
// native_local.
const CATEGORY_FOR_KIND = {
  practice_due: 'practice',
  review_unfinished: 'review',
  goal_achieved: 'goal',
  goal_focus: 'goal',
  recap_ready: 'recap',
}

// Same-kind external cooldown, hours (dev-plan §10.3). Kinds absent here
// (the goal_* kinds) never reach native planning at all in this release.
const COOLDOWN_HOURS_FOR_KIND = {
  practice_due: 24,
  review_unfinished: 72,
  recap_ready: 168,
}

const IGNORED_SUPPRESSION_DAYS = 14
const IGNORED_WINDOW_HOURS = 48 // "ignored" = delivered with no open/completion within 48h (dev-plan §10.4)

function isIsoString(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isValidLocalTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value)
}

// ─── Preference / ledger normalization (dev-plan §13.6, §13.7) ──────────────
// Tolerant of missing, corrupt, or legacy-shaped input — always returns a
// well-shaped value with safe defaults, the same tolerant-normalizer pattern
// as normalizePuzzleScheduling/normalizeLearningRecord elsewhere in this repo.

export function normalizeLearningPreferences(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const categories = v.categories && typeof v.categories === 'object' ? v.categories : {}
  const quietHours = v.quietHours && typeof v.quietHours === 'object' ? v.quietHours : {}
  return {
    schemaVersion: 1,
    inAppEnabled: v.inAppEnabled !== false, // default true
    nativeEnabled: v.nativeEnabled === true, // default false
    categories: {
      practice: categories.practice !== false,
      review: categories.review !== false,
      goal: categories.goal === true,
      recap: categories.recap === true,
    },
    preferredLocalTime: isValidLocalTime(v.preferredLocalTime) ? v.preferredLocalTime : '19:00',
    quietHours: {
      start: isValidLocalTime(quietHours.start) ? quietHours.start : '20:30',
      end: isValidLocalTime(quietHours.end) ? quietHours.end : '08:00',
    },
    pausedUntil: isIsoString(v.pausedUntil) ? v.pausedUntil : '',
    productOptInAt: isIsoString(v.productOptInAt) ? v.productOptInAt : '',
    updatedAt: isIsoString(v.updatedAt) ? v.updatedAt : '',
  }
}

function normalizeByKindEntry(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  return {
    lastShownAt: isIsoString(v.lastShownAt) ? v.lastShownAt : '',
    dismissedUntil: isIsoString(v.dismissedUntil) ? v.dismissedUntil : '',
    consecutiveIgnored: Number.isFinite(v.consecutiveIgnored) && v.consecutiveIgnored >= 0 ? v.consecutiveIgnored : 0,
    suppressedUntil: isIsoString(v.suppressedUntil) ? v.suppressedUntil : '',
  }
}

function normalizePending(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!Number.isFinite(raw.nativeId) || typeof raw.kind !== 'string' || !isIsoString(raw.deliverAt)) return null
  return { nativeId: raw.nativeId, kind: raw.kind, deliverAt: raw.deliverAt }
}

export function normalizeLearningLedger(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const byKindRaw = v.byKind && typeof v.byKind === 'object' ? v.byKind : {}
  const byKind = {}
  for (const kind of Object.keys(byKindRaw)) byKind[kind] = normalizeByKindEntry(byKindRaw[kind])
  const deliveries = Array.isArray(v.externalDeliveries) ? v.externalDeliveries : []
  return {
    schemaVersion: 1,
    lastEvaluatedAt: isIsoString(v.lastEvaluatedAt) ? v.lastEvaluatedAt : '',
    lastExternalDeliveredAt: isIsoString(v.lastExternalDeliveredAt) ? v.lastExternalDeliveredAt : '',
    externalDeliveries: deliveries
      .filter(d => d && typeof d === 'object' && typeof d.kind === 'string' && isIsoString(d.deliveredAt))
      .map(d => ({
        kind: d.kind,
        deliveredAt: d.deliveredAt,
        openedAt: isIsoString(d.openedAt) ? d.openedAt : '',
        completedAt: isIsoString(d.completedAt) ? d.completedAt : '',
      })),
    byKind,
    pending: normalizePending(v.pending),
  }
}

function byKindEntry(ledger, kind) {
  return normalizeByKindEntry(ledger?.byKind?.[kind])
}

// appendExternalDelivery: pure ledger update after an external reminder is
// actually delivered — caps history at 30 entries or 45 days, whichever is
// smaller (dev-plan §13.7).
export function appendExternalDelivery(ledger, kind, now) {
  const base = normalizeLearningLedger(ledger)
  const deliveredAt = now.toISOString()
  const cutoff = now.getTime() - EXTERNAL_DELIVERY_HISTORY_MAX_DAYS * DAY_MS
  const kept = base.externalDeliveries.filter(d => Date.parse(d.deliveredAt) >= cutoff)
  const externalDeliveries = [...kept, { kind, deliveredAt, openedAt: '', completedAt: '' }].slice(-EXTERNAL_DELIVERY_HISTORY_CAP)
  return {
    ...base,
    lastExternalDeliveredAt: deliveredAt,
    externalDeliveries,
    byKind: { ...base.byKind, [kind]: { ...byKindEntry(base, kind), lastShownAt: deliveredAt } },
  }
}

// applyIgnoredOutcome: a delivered reminder with no open/completion inside
// IGNORED_WINDOW_HOURS. Second consecutive ignored reminder for a kind
// suppresses that kind for 14 days (dev-plan §10.4).
export function applyIgnoredOutcome(ledger, kind, now) {
  const base = normalizeLearningLedger(ledger)
  const entry = byKindEntry(base, kind)
  const consecutiveIgnored = entry.consecutiveIgnored + 1
  const suppressedUntil = consecutiveIgnored >= 2
    ? new Date(now.getTime() + IGNORED_SUPPRESSION_DAYS * DAY_MS).toISOString()
    : entry.suppressedUntil
  return { ...base, byKind: { ...base.byKind, [kind]: { ...entry, consecutiveIgnored, suppressedUntil } } }
}

// applyCompletedOutcome: any completed matching action resets the ignored
// count for its kind (dev-plan §10.4) — it does not clear an already-active
// suppression window, since that's a separate 14-day quiet period the player
// earned back, not one that a single completion should cut short.
export function applyCompletedOutcome(ledger, kind) {
  const base = normalizeLearningLedger(ledger)
  const entry = byKindEntry(base, kind)
  return { ...base, byKind: { ...base.byKind, [kind]: { ...entry, consecutiveIgnored: 0 } } }
}

// isReminderIgnored: whether a delivered-but-unresolved reminder has crossed
// the ignored threshold as of `now` (dev-plan §10.4's definition). Exposed so
// the orchestrator (not built in this milestone) can decide when to call
// applyIgnoredOutcome instead of re-deriving the 48h rule itself.
export function isReminderIgnored(delivery, now) {
  if (!delivery || delivery.openedAt || delivery.completedAt) return false
  const deliveredAt = Date.parse(delivery.deliveredAt)
  if (!Number.isFinite(deliveredAt)) return false
  return (now.getTime() - deliveredAt) / HOUR_MS >= IGNORED_WINDOW_HOURS
}

// ─── Quiet hours / preferred time (dev-plan §10.5) ───────────────────────────

function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// isWithinQuietHours: handles the overnight wrap (start > end, e.g.
// 20:30-08:00) the same way as a same-day window (e.g. 13:00-14:00).
export function isWithinQuietHours(localTime, quietHours) {
  const t = minutesOfDay(localTime)
  const start = minutesOfDay(quietHours.start)
  const end = minutesOfDay(quietHours.end)
  if (start === end) return false // a zero-width window blocks nothing
  if (start < end) return t >= start && t < end
  return t >= start || t < end // wraps midnight
}

// computeNextDeliverySlot: local wall-clock scheduling per dev-plan §10.5 —
// "if a candidate becomes eligible at least two hours before today's
// preferred time, schedule today; otherwise schedule the next valid
// preferred-time slot." Uses `now`'s own local getters throughout so the
// result is correct under whatever timezone the process/device is actually
// running in — no dependency on a machine-specific wall-clock offset beyond
// that.
export function computeNextDeliverySlot(now, preferredLocalTime) {
  const [h, m] = preferredLocalTime.split(':').map(Number)
  const todaySlot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
  if (todaySlot.getTime() - now.getTime() >= 2 * HOUR_MS) return todaySlot
  return new Date(todaySlot.getTime() + DAY_MS)
}

// ─── Candidate filtering shared by both selectors ────────────────────────────

// isLive: exported so the orchestrator can also ask "is the candidate behind
// an already-scheduled native reminder still eligible" without re-deriving
// this window itself (dev-plan §10.7 stale-state cancellation).
export function isLive(candidate, now) {
  const nowMs = now.getTime()
  const eligibleAt = Date.parse(candidate.eligibleAt)
  const expiresAt = Date.parse(candidate.expiresAt)
  return Number.isFinite(eligibleAt) && Number.isFinite(expiresAt) && eligibleAt <= nowMs && nowMs < expiresAt
}

function byPriorityDesc(a, b) {
  return b.priority - a.priority
}

// ─── Selectors (dev-plan §13.5) ──────────────────────────────────────────────

// selectInAppCandidate: the single highest-priority live candidate allowed to
// present right now, or null. In-app guidance has no cooldown/cap — only
// feature-off, an active blocking experience, and a same-day dismissal
// suppress it (dev-plan §11.1).
export function selectInAppCandidate(candidates, preferences, ledger, context, now = new Date()) {
  const prefs = normalizeLearningPreferences(preferences)
  const led = normalizeLearningLedger(ledger)
  if (context?.isActiveExperience) return null
  if (!prefs.inAppEnabled) return null
  const nowMs = now.getTime()
  if (prefs.pausedUntil && Date.parse(prefs.pausedUntil) > nowMs) return null // "Pause for 14 days" (dev-plan §12.3)
  const live = (candidates || [])
    .filter(c => isLive(c, now))
    .filter(c => {
      const dismissedUntil = byKindEntry(led, c.kind).dismissedUntil
      return !(dismissedUntil && Date.parse(dismissedUntil) > nowMs)
    })
    .sort(byPriorityDesc)
  return live[0] || null
}

// planNativeReminder: the single candidate + deliverAt to schedule as one
// non-repeating native local notification, or null when nothing should be
// (re)scheduled (dev-plan §10.3, §10.5, §11.4, §13.5). Does not itself check
// `context.isActiveExperience` — cancelling an already-pending reminder when
// a game starts is a separate reconciliation action (dev-plan §10.6/§14.1),
// not a reason to refuse planning a *future* one.
export function planNativeReminder(candidates, preferences, ledger, context, now = new Date()) {
  if (context?.isChild) return null // dev-plan §11.4: no external delivery for protected children, no exceptions
  const prefs = normalizeLearningPreferences(preferences)
  if (!prefs.nativeEnabled) return null
  if (prefs.pausedUntil && Date.parse(prefs.pausedUntil) > now.getTime()) return null // "Pause for 14 days" (dev-plan §12.3)
  const led = normalizeLearningLedger(ledger)
  if (led.pending) return null // only one pending native learning reminder at a time (dev-plan §10.3)

  const deliveredLast24h = led.externalDeliveries.filter(d => now.getTime() - Date.parse(d.deliveredAt) < DAY_MS).length
  if (deliveredLast24h >= 1) return null
  const deliveredLast7d = led.externalDeliveries.filter(d => now.getTime() - Date.parse(d.deliveredAt) < 7 * DAY_MS).length
  if (deliveredLast7d >= 3) return null

  const nowMs = now.getTime()
  const eligible = (candidates || [])
    .filter(c => c.allowedChannels?.includes('native_local'))
    .filter(c => isLive(c, now))
    .filter(c => prefs.categories[CATEGORY_FOR_KIND[c.kind]] === true)
    .filter(c => {
      const entry = byKindEntry(led, c.kind)
      if (entry.suppressedUntil && Date.parse(entry.suppressedUntil) > nowMs) return false
      const cooldownHours = COOLDOWN_HOURS_FOR_KIND[c.kind] ?? 24
      if (entry.lastShownAt && (nowMs - Date.parse(entry.lastShownAt)) / HOUR_MS < cooldownHours) return false
      return true
    })
    .sort(byPriorityDesc)

  const candidate = eligible[0]
  if (!candidate) return null

  const deliverAt = computeNextDeliverySlot(now, prefs.preferredLocalTime)
  if (deliverAt.getTime() >= Date.parse(candidate.expiresAt)) return null // would fire after the candidate is already stale

  return { candidate, deliverAt: deliverAt.toISOString() }
}

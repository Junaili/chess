const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const policyPromise = import(pathToFileURL(
  path.join(__dirname, '..', '..', 'src', 'learning-notification-policy.mjs')
))

const NOW = new Date('2026-07-17T19:00:00.000Z') // 19:00 local, matches the default preferred time

function candidate(kind, priority, overrides = {}) {
  return {
    schemaVersion: 1,
    key: `${kind}:k`,
    kind,
    priority,
    createdAt: NOW.toISOString(),
    eligibleAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 2 * 86400000).toISOString(),
    target: { intent: 'practice' },
    copyKey: kind,
    safeVariables: {},
    reasonCode: 'test',
    allowedChannels: ['in_app', 'native_local'],
    ...overrides,
  }
}

// ─── selectInAppCandidate ─────────────────────────────────────────────────

test('selectInAppCandidate: highest-priority live candidate wins', async () => {
  const { selectInAppCandidate } = await policyPromise
  const candidates = [candidate('recap_ready', 60), candidate('practice_due', 100), candidate('review_unfinished', 90)]
  const picked = selectInAppCandidate(candidates, {}, {}, {}, NOW)
  assert.equal(picked.kind, 'practice_due')
})

test('selectInAppCandidate: expired/not-yet-eligible candidates are excluded', async () => {
  const { selectInAppCandidate } = await policyPromise
  const expired = candidate('practice_due', 100, { expiresAt: new Date(NOW.getTime() - 1000).toISOString() })
  const notYet = candidate('review_unfinished', 90, { eligibleAt: new Date(NOW.getTime() + 3600000).toISOString() })
  assert.equal(selectInAppCandidate([expired, notYet], {}, {}, {}, NOW), null)
})

test('selectInAppCandidate: "Pause for 14 days" suppresses every candidate until it lapses', async () => {
  const { selectInAppCandidate } = await policyPromise
  const paused = { pausedUntil: new Date(NOW.getTime() + 3600000).toISOString() }
  assert.equal(selectInAppCandidate([candidate('practice_due', 100)], paused, {}, {}, NOW), null)
  const lapsed = { pausedUntil: new Date(NOW.getTime() - 3600000).toISOString() }
  assert.equal(selectInAppCandidate([candidate('practice_due', 100)], lapsed, {}, {}, NOW).kind, 'practice_due')
})

test('selectInAppCandidate: an active experience suppresses every candidate', async () => {
  const { selectInAppCandidate } = await policyPromise
  const picked = selectInAppCandidate([candidate('practice_due', 100)], {}, {}, { isActiveExperience: true }, NOW)
  assert.equal(picked, null)
})

test('selectInAppCandidate: feature-off (inAppEnabled=false) returns no presentation', async () => {
  const { selectInAppCandidate } = await policyPromise
  const picked = selectInAppCandidate([candidate('practice_due', 100)], { inAppEnabled: false }, {}, {}, NOW)
  assert.equal(picked, null)
})

test('selectInAppCandidate: protected-child context still gets in-app guidance', async () => {
  const { selectInAppCandidate } = await policyPromise
  const picked = selectInAppCandidate([candidate('practice_due', 100)], {}, {}, { isChild: true }, NOW)
  assert.equal(picked.kind, 'practice_due')
})

test('selectInAppCandidate: dismissed-for-today kind is hidden until dismissedUntil passes', async () => {
  const { selectInAppCandidate } = await policyPromise
  const ledger = { byKind: { practice_due: { dismissedUntil: new Date(NOW.getTime() + 3600000).toISOString() } } }
  assert.equal(selectInAppCandidate([candidate('practice_due', 100)], {}, ledger, {}, NOW), null)

  const pastLedger = { byKind: { practice_due: { dismissedUntil: new Date(NOW.getTime() - 3600000).toISOString() } } }
  assert.equal(selectInAppCandidate([candidate('practice_due', 100)], {}, pastLedger, {}, NOW).kind, 'practice_due')
})

// ─── planNativeReminder ───────────────────────────────────────────────────

const nativePrefs = { nativeEnabled: true, categories: { practice: true, review: true, goal: true, recap: true } }

test('planNativeReminder: "Pause for 14 days" blocks planning until it lapses', async () => {
  const { planNativeReminder } = await policyPromise
  const paused = { ...nativePrefs, pausedUntil: new Date(NOW.getTime() + 3600000).toISOString() }
  assert.equal(planNativeReminder([candidate('practice_due', 100)], paused, {}, {}, NOW), null)
  const lapsed = { ...nativePrefs, pausedUntil: new Date(NOW.getTime() - 3600000).toISOString() }
  assert.ok(planNativeReminder([candidate('practice_due', 100)], lapsed, {}, {}, NOW))
})

test('planNativeReminder: protected child rejects every external plan', async () => {
  const { planNativeReminder } = await policyPromise
  const plan = planNativeReminder([candidate('practice_due', 100)], nativePrefs, {}, { isChild: true }, NOW)
  assert.equal(plan, null)
})

test('planNativeReminder: feature-off (nativeEnabled=false) returns no schedule', async () => {
  const { planNativeReminder } = await policyPromise
  const plan = planNativeReminder([candidate('practice_due', 100)], { nativeEnabled: false }, {}, {}, NOW)
  assert.equal(plan, null)
})

test('planNativeReminder: one pending native reminder already exists refuses a new plan', async () => {
  const { planNativeReminder } = await policyPromise
  const ledger = { pending: { nativeId: 41001, kind: 'practice_due', deliverAt: NOW.toISOString() } }
  const plan = planNativeReminder([candidate('practice_due', 100)], nativePrefs, ledger, {}, NOW)
  assert.equal(plan, null)
})

test('planNativeReminder: max one external delivery per rolling 24 hours', async () => {
  const { planNativeReminder } = await policyPromise
  const ledger = { externalDeliveries: [{ kind: 'review_unfinished', deliveredAt: new Date(NOW.getTime() - 3600000).toISOString() }] }
  const plan = planNativeReminder([candidate('practice_due', 100)], nativePrefs, ledger, {}, NOW)
  assert.equal(plan, null)
})

test('planNativeReminder: max three external deliveries per rolling 7 days', async () => {
  const { planNativeReminder } = await policyPromise
  const ledger = {
    externalDeliveries: [
      { kind: 'practice_due', deliveredAt: new Date(NOW.getTime() - 6 * 86400000).toISOString() },
      { kind: 'practice_due', deliveredAt: new Date(NOW.getTime() - 5 * 86400000).toISOString() },
      { kind: 'practice_due', deliveredAt: new Date(NOW.getTime() - 4 * 86400000).toISOString() },
    ],
  }
  const plan = planNativeReminder([candidate('practice_due', 100)], nativePrefs, ledger, {}, NOW)
  assert.equal(plan, null)
})

test('planNativeReminder: same-kind cooldown blocks re-planning inside its window', async () => {
  const { planNativeReminder } = await policyPromise
  const ledger = { byKind: { practice_due: { lastShownAt: new Date(NOW.getTime() - 12 * 3600000).toISOString() } } }
  assert.equal(planNativeReminder([candidate('practice_due', 100)], nativePrefs, ledger, {}, NOW), null)

  const pastCooldown = { byKind: { practice_due: { lastShownAt: new Date(NOW.getTime() - 25 * 3600000).toISOString() } } }
  assert.ok(planNativeReminder([candidate('practice_due', 100)], nativePrefs, pastCooldown, {}, NOW))
})

test('planNativeReminder: category preference gates the candidate kind', async () => {
  const { planNativeReminder } = await policyPromise
  const prefsOff = { nativeEnabled: true, categories: { practice: false } }
  assert.equal(planNativeReminder([candidate('practice_due', 100)], prefsOff, {}, {}, NOW), null)
})

test('planNativeReminder: a candidate not allowing native_local is never planned', async () => {
  const { planNativeReminder } = await policyPromise
  const goalCandidate = candidate('goal_focus', 70, { allowedChannels: ['in_app'] })
  assert.equal(planNativeReminder([goalCandidate], nativePrefs, {}, {}, NOW), null)
})

test('planNativeReminder: schedules today when 2+ hours before preferred time, else tomorrow', async () => {
  const { planNativeReminder } = await policyPromise
  // Local wall-clock times (not UTC) — deliverAt is likewise read back with
  // local getters, so this holds regardless of the machine's timezone.
  const morning = new Date(2026, 6, 17, 10, 0, 0) // local: Jul 17, 10:00 — well before 19:00 preferred
  const planToday = planNativeReminder([candidate('practice_due', 100, { eligibleAt: morning.toISOString() })], nativePrefs, {}, {}, morning)
  const deliverAtToday = new Date(planToday.deliverAt)
  assert.equal(deliverAtToday.getDate(), 17)
  assert.equal(deliverAtToday.getHours(), 19)

  const lateEvening = new Date(2026, 6, 17, 18, 30, 0) // local: Jul 17, 18:30 — only 30 min before 19:00
  const planTomorrow = planNativeReminder([candidate('practice_due', 100, { eligibleAt: lateEvening.toISOString() })], nativePrefs, {}, {}, lateEvening)
  const deliverAtTomorrow = new Date(planTomorrow.deliverAt)
  assert.equal(deliverAtTomorrow.getDate(), 18)
  assert.equal(deliverAtTomorrow.getHours(), 19)
})

// ─── computeNextDeliverySlot / isWithinQuietHours ─────────────────────────

test('computeNextDeliverySlot: uses now\'s own local date so it is timezone-consistent', async () => {
  const { computeNextDeliverySlot } = await policyPromise
  const now = new Date(2026, 6, 17, 10, 0, 0) // local: Jul 17 2026, 10:00
  const slot = computeNextDeliverySlot(now, '19:00')
  assert.equal(slot.getFullYear(), now.getFullYear())
  assert.equal(slot.getMonth(), now.getMonth())
  assert.equal(slot.getDate(), now.getDate())
  assert.equal(slot.getHours(), 19)
})

test('computeNextDeliverySlot: preferred time already passed today rolls to tomorrow', async () => {
  const { computeNextDeliverySlot } = await policyPromise
  const now = new Date(2026, 6, 17, 20, 0, 0) // local: Jul 17 2026, 20:00 — past the 19:00 preferred slot
  const slot = computeNextDeliverySlot(now, '19:00')
  assert.equal(slot.getDate(), 18)
  assert.equal(slot.getHours(), 19)
})

test('isWithinQuietHours: handles an overnight window that wraps midnight', async () => {
  const { isWithinQuietHours } = await policyPromise
  const quietHours = { start: '20:30', end: '08:00' }
  assert.equal(isWithinQuietHours('23:00', quietHours), true)
  assert.equal(isWithinQuietHours('02:00', quietHours), true)
  assert.equal(isWithinQuietHours('07:59', quietHours), true)
  assert.equal(isWithinQuietHours('08:00', quietHours), false)
  assert.equal(isWithinQuietHours('19:00', quietHours), false)
  assert.equal(isWithinQuietHours('20:30', quietHours), true)
})

test('isWithinQuietHours: handles a same-day (non-wrapping) window', async () => {
  const { isWithinQuietHours } = await policyPromise
  const quietHours = { start: '13:00', end: '14:00' }
  assert.equal(isWithinQuietHours('13:30', quietHours), true)
  assert.equal(isWithinQuietHours('12:59', quietHours), false)
  assert.equal(isWithinQuietHours('14:00', quietHours), false)
})

// ─── Ignored-reminder backoff (dev-plan §10.4) ────────────────────────────

test('applyIgnoredOutcome: second consecutive ignored reminder suppresses the kind for 14 days', async () => {
  const { applyIgnoredOutcome } = await policyPromise
  const afterFirst = applyIgnoredOutcome({}, 'practice_due', NOW)
  assert.equal(afterFirst.byKind.practice_due.consecutiveIgnored, 1)
  assert.equal(afterFirst.byKind.practice_due.suppressedUntil, '')

  const afterSecond = applyIgnoredOutcome(afterFirst, 'practice_due', NOW)
  assert.equal(afterSecond.byKind.practice_due.consecutiveIgnored, 2)
  const suppressedUntil = Date.parse(afterSecond.byKind.practice_due.suppressedUntil)
  assert.ok(suppressedUntil > NOW.getTime())
  assert.equal(Math.round((suppressedUntil - NOW.getTime()) / 86400000), 14)
})

test('applyCompletedOutcome: a completed matching action resets the ignored count', async () => {
  const { applyIgnoredOutcome, applyCompletedOutcome } = await policyPromise
  const ignoredOnce = applyIgnoredOutcome({}, 'review_unfinished', NOW)
  const reset = applyCompletedOutcome(ignoredOnce, 'review_unfinished')
  assert.equal(reset.byKind.review_unfinished.consecutiveIgnored, 0)
})

test('isReminderIgnored: true only once 48h pass with no open/completion', async () => {
  const { isReminderIgnored } = await policyPromise
  const delivered = { deliveredAt: new Date(NOW.getTime() - 47 * 3600000).toISOString() }
  assert.equal(isReminderIgnored(delivered, NOW), false)
  const stale = { deliveredAt: new Date(NOW.getTime() - 49 * 3600000).toISOString() }
  assert.equal(isReminderIgnored(stale, NOW), true)
  const opened = { deliveredAt: new Date(NOW.getTime() - 49 * 3600000).toISOString(), openedAt: NOW.toISOString() }
  assert.equal(isReminderIgnored(opened, NOW), false)
})

// ─── Corrupt-data safety (dev-plan §16.1 case 20) ─────────────────────────

test('normalizeLearningPreferences: corrupt/garbage input normalizes to safe defaults', async () => {
  const { normalizeLearningPreferences } = await policyPromise
  const normalized = normalizeLearningPreferences({ inAppEnabled: 'yes', categories: 'nope', preferredLocalTime: 42, quietHours: null })
  assert.equal(normalized.inAppEnabled, true) // only literal false disables
  assert.equal(normalized.nativeEnabled, false)
  assert.deepEqual(normalized.categories, { practice: true, review: true, goal: false, recap: false })
  assert.equal(normalized.preferredLocalTime, '19:00')
  assert.deepEqual(normalized.quietHours, { start: '20:30', end: '08:00' })
})

test('normalizeLearningLedger: corrupt/garbage input normalizes safely and never throws', async () => {
  const { normalizeLearningLedger } = await policyPromise
  const normalized = normalizeLearningLedger({
    externalDeliveries: 'not-an-array',
    byKind: 'nope',
    pending: { nativeId: 'not-a-number', kind: 'practice_due', deliverAt: 'garbage' },
  })
  assert.deepEqual(normalized.externalDeliveries, [])
  assert.deepEqual(normalized.byKind, {})
  assert.equal(normalized.pending, null)
})

test('planNativeReminder and selectInAppCandidate never throw on garbage preferences/ledger', async () => {
  const { planNativeReminder, selectInAppCandidate } = await policyPromise
  const candidates = [candidate('practice_due', 100)]
  assert.doesNotThrow(() => selectInAppCandidate(candidates, 'garbage', 'garbage', null, NOW))
  assert.doesNotThrow(() => planNativeReminder(candidates, 'garbage', 'garbage', null, NOW))
})

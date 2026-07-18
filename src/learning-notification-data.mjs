// Pure candidate derivation, expiry, and copy for the chess-improvement
// notification system (notification dev-plan §7, §9, §12.4, §13.3, §13.5).
// No DOM, no network, no clock reads — every function takes `now` explicitly
// so tests never depend on the machine clock. src/learning-notifications.js
// (a later milestone) owns snapshot loading and presentation; this module
// only turns a snapshot into candidates and candidates into copy/routing.
//
// A Candidate never carries opponent names, match/account IDs, moves,
// reflections, or takeaways (dev-plan §13.3, §15.1) — only the fields in the
// contract below.

const DAY_MS = 86400000
const HOUR_MS = 3600000

function toIso(date) {
  return date instanceof Date ? date.toISOString() : new Date(date).toISOString()
}

function addDays(now, days) {
  return new Date(now.getTime() + days * DAY_MS)
}

function hoursSince(iso, now) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return -Infinity // unparseable timestamp never satisfies an "at least N hours" gate
  return (now.getTime() - t) / HOUR_MS
}

function dayBucket(now) {
  return now.toISOString().slice(0, 10)
}

// countBucket: the only externally-safe quantity signal (dev-plan §9.3) —
// exact counts are in-app only and travel separately in safeVariables.exactCount.
export function countBucket(count) {
  if (count >= 5) return 'several'
  if (count >= 2) return 'few'
  return 'one'
}

// ─── Candidate derivation ────────────────────────────────────────────────────

// deriveLearningCandidates: every eligible candidate for this snapshot+time,
// unranked selection (dev-plan §10.2's priority ordering happens in
// learning-notification-policy.mjs). Missing/malformed snapshot data simply
// yields no candidate for that kind — never a thrown error and never a guess
// (N0 acceptance: "no notification can be derived from an unavailable action").
export function deriveLearningCandidates(snapshot, now = new Date()) {
  const candidates = []
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {}

  // practice_due (dev-plan §7.2) — keys off playableDueCount, never the
  // broader dueCount, so an unplayable retained puzzle can never be the
  // subject of a reminder.
  const playableDueCount = s.practice?.playableDueCount || 0
  if (playableDueCount > 0) {
    candidates.push({
      schemaVersion: 1,
      key: `practice_due:${dayBucket(now)}`,
      kind: 'practice_due',
      priority: 100,
      createdAt: toIso(now),
      eligibleAt: toIso(now),
      expiresAt: addDays(now, 2).toISOString(),
      target: { intent: 'practice' },
      copyKey: 'practice_due',
      safeVariables: { countBucket: countBucket(playableDueCount), exactCount: playableDueCount },
      reasonCode: 'playable_practice_due',
      allowedChannels: ['in_app', 'native_local'],
    })
  }

  // review_unfinished (dev-plan §7.3) — a 'ready' review needs 12h to pass
  // since it entered that state, and oldestReadyAt must actually be a valid
  // timestamp; a snapshot that can't prove the wait has elapsed never
  // qualifies rather than defaulting open.
  const unfinishedCount = s.review?.unfinishedCount || 0
  if (unfinishedCount > 0 && hoursSince(s.review?.oldestReadyAt, now) >= 12) {
    candidates.push({
      schemaVersion: 1,
      key: `review_unfinished:${s.review.oldestReadyAt}`,
      kind: 'review_unfinished',
      priority: 90,
      createdAt: toIso(now),
      eligibleAt: toIso(now),
      expiresAt: addDays(now, 7).toISOString(),
      target: { intent: 'review' },
      copyKey: 'review_unfinished',
      safeVariables: {},
      reasonCode: 'unfinished_quick_review',
      allowedChannels: ['in_app', 'native_local'],
    })
  }

  // goal_achieved (dev-plan §7.4) — keyed by completedAt so the "once per
  // goal" cadence in the policy layer can dedupe on the specific completion
  // event rather than a day bucket.
  if (s.goal?.status === 'achieved' && typeof s.goal.completedAt === 'string' && s.goal.completedAt) {
    candidates.push({
      schemaVersion: 1,
      key: `goal_achieved:${s.goal.completedAt}`,
      kind: 'goal_achieved',
      priority: 85,
      createdAt: toIso(now),
      eligibleAt: toIso(now),
      expiresAt: addDays(now, 3).toISOString(),
      target: { intent: 'goal' },
      copyKey: 'goal_achieved',
      safeVariables: {},
      reasonCode: 'goal_achieved',
      allowedChannels: ['in_app'], // no external delivery for goals in N3 (dev-plan §7.1)
    })
  }

  // goal_focus (dev-plan §7.5) — only meaningful with a positive target;
  // milestone copy (>=50% for the first time, or one away from target) is
  // computed fresh each call — the policy/ledger layer is responsible for
  // "only once" dedupe, this module just reports the current crossing state.
  if (s.goal?.status === 'active' && Number.isFinite(s.goal.target) && s.goal.target > 0) {
    const completed = Number.isFinite(s.goal.completed) ? s.goal.completed : 0
    const milestone = completed / s.goal.target >= 0.5 || completed === s.goal.target - 1
    candidates.push({
      schemaVersion: 1,
      key: `goal_focus:${dayBucket(now)}`,
      kind: 'goal_focus',
      priority: 70,
      createdAt: toIso(now),
      eligibleAt: toIso(now),
      expiresAt: addDays(now, 1).toISOString(),
      target: { intent: 'goal' },
      copyKey: milestone ? 'goal_focus_milestone' : 'goal_focus_default',
      safeVariables: { completed, target: s.goal.target },
      reasonCode: 'active_goal_focus',
      allowedChannels: ['in_app'],
    })
  }

  // recap_ready (dev-plan §7.6) — two+ new replayable games any time, or one
  // that's sat unreviewed for 48h+.
  const replayableNewMatchCount = s.recap?.replayableNewMatchCount || 0
  const oneStale = replayableNewMatchCount === 1 && hoursSince(s.recap?.oldestNewMatchAt, now) >= 48
  if (replayableNewMatchCount >= 2 || oneStale) {
    candidates.push({
      schemaVersion: 1,
      key: `recap_ready:${dayBucket(now)}`,
      kind: 'recap_ready',
      priority: 60,
      createdAt: toIso(now),
      eligibleAt: toIso(now),
      expiresAt: addDays(now, 7).toISOString(),
      target: { intent: 'recap' },
      copyKey: 'recap_ready',
      safeVariables: { countBucket: countBucket(replayableNewMatchCount), exactCount: replayableNewMatchCount },
      reasonCode: 'recap_ready',
      allowedChannels: ['in_app'],
    })
  }

  return candidates
}

// ─── Copy catalog (dev-plan §9.2) ────────────────────────────────────────────
// Only the approved initial copy. Anything not listed here has no external
// or in-app text yet and must not ship a candidate kind without it.

const COPY_CATALOG = {
  practice_due: {
    external: {
      title: 'A position is ready to practice',
      body: 'Replay a moment from one of your games and find the better move.',
    },
    externalChild: {
      title: 'Your chess puzzle is ready',
      body: 'Try a position from one of your games again.',
    },
    inApp: {
      eyebrow: 'Your next chess step',
      title: vars => `Practice due: ${vars.exactCount}`,
      body: 'These positions came from your own games and are ready for another try.',
      cta: 'Practice now',
    },
  },
  review_unfinished: {
    external: {
      title: 'Finish your Quick Review',
      body: 'One useful moment from a recent game is waiting for your takeaway.',
    },
    externalChild: {
      title: 'Finish looking back',
      body: 'One moment from your game is ready to review.',
    },
    inApp: {
      eyebrow: 'Continue learning',
      title: 'You have a Quick Review to finish',
      body: 'Revisit the key moments, then save one idea for your next game.',
      cta: 'Finish review',
    },
  },
  // goal_focus_default: deliberately no title text here — dev-plan §7.5 says
  // the non-milestone case is "a quiet focus reminder, matching the Journal's
  // existing priority rather than inventing a different next action," so the
  // caller fills the title from the goal's own label exactly as
  // renderNextActionCard already does for kind 'goal' in src/journal.js.
  goal_focus_default: {
    inApp: {
      eyebrow: 'Your chess goal',
      title: '',
      body: 'Keep the same focus in your next applicable game.',
      cta: 'View goal',
    },
  },
  goal_focus_milestone: {
    inApp: {
      eyebrow: 'Your chess goal',
      title: 'One step closer',
      body: vars => `${vars.completed} of ${vars.target} completed. Keep the same focus in your next applicable game.`,
      cta: 'View goal',
    },
  },
  goal_achieved: {
    inApp: {
      eyebrow: 'Goal complete',
      title: 'Nice work—that habit is taking shape',
      body: 'The progress came from completed games or practice, not just a streak.',
      cta: 'Choose next goal',
    },
  },
  recap_ready: {
    inApp: {
      eyebrow: 'Turn games into lessons',
      title: vars => `${vars.exactCount} recent game${vars.exactCount === 1 ? '' : 's'} to look back on`,
      body: 'Review what went well, choose one lesson, and set your next focus.',
      cta: 'Review recent games',
    },
  },
}

function resolveField(field, vars) {
  return typeof field === 'function' ? field(vars) : field
}

// formatLearningCopy: channel is 'in_app' | 'external' | 'external_child'.
// Returns null when the candidate's kind has no copy for that channel
// (e.g. any external channel for a goal/recap candidate, which are
// allowedChannels: ['in_app'] only) rather than guessing at text.
export function formatLearningCopy(candidate, channel) {
  const entry = COPY_CATALOG[candidate?.copyKey]
  if (!entry) return null
  const vars = candidate.safeVariables || {}
  if (channel === 'in_app') {
    if (!entry.inApp) return null
    return {
      eyebrow: entry.inApp.eyebrow || '',
      title: resolveField(entry.inApp.title, vars),
      body: resolveField(entry.inApp.body, vars),
      cta: entry.inApp.cta || '',
    }
  }
  const source = channel === 'external_child' ? (entry.externalChild || entry.external) : entry.external
  if (!source) return null
  return { title: resolveField(source.title, vars), body: resolveField(source.body, vars), cta: '' }
}

// ─── Destination mapping (dev-plan §12.4) ────────────────────────────────────

const INTENT_ROUTES = {
  practice: { screen: 'profile', tab: 'journal', anchor: 'journal-practice-queue' },
  review: { screen: 'profile', tab: 'history', anchor: null },
  goal: { screen: 'profile', tab: 'journal', anchor: 'journal-active-goal' },
  recap: { screen: 'profile', tab: 'journal', anchor: 'journal-next-action' },
}

export function resolveLearningIntent(candidate) {
  const intent = candidate?.target?.intent
  return INTENT_ROUTES[intent] || null
}

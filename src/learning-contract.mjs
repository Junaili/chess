// Pure data contract for the private "chess-learning-index" CloudSave record
// (dev-plan §6.2, §6.3, §11). No DOM, no network — src/learning-store.js owns
// the actual CloudSave calls; src/review.js is the only caller. Never import
// this from src/main.js directly — it must stay behind the lazy reviewFeature
// loader so an owner who never opens Review/History-with-badges never pays
// for it.

export const LEARNING_INDEX_SCHEMA_VERSION = 1
export const LEARNING_INDEX_CAP = 50
export const TAKEAWAY_MAX_LENGTH = 120
export const ANALYSIS_VERSION = 'quick-v1'
// Initially 'general' only (dev-plan §10.5) — the other values are reserved
// for a future, verified tactical-theme detector; nothing computes them yet.
export const PRIMARY_THEMES = ['general', 'missed-chance', 'king-safety', 'resignation']

// 32-bit FNV-1a — not a security hash, just cheap corruption/edit detection
// for matchFingerprint (dev-plan §6.2). No crypto dependency needed.
function fnv1a(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// computeMatchFingerprint: v1:<moveCount>:<fnv1a hex> over the compact
// ordered move list. A changed or corrupted replay produces a different
// fingerprint, which is what makes a stored review "stale" (dev-plan §6.2).
export function computeMatchFingerprint(moves) {
  const list = Array.isArray(moves) ? moves : []
  const compact = list.map(m => `${m.fr},${m.fc},${m.toR},${m.toC},${m.promType || 'queen'}`).join(';')
  return `v1:${list.length}:${fnv1a(compact)}`
}

export function trimTakeaway(text) {
  return String(text || '').trim().slice(0, TAKEAWAY_MAX_LENGTH)
}

function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.matchId !== 'string' || !raw.matchId) return null
  const status = raw.status === 'ready' || raw.status === 'reviewed' ? raw.status : undefined
  return {
    // Unknown fields are preserved by the current version's normalizer
    // (dev-plan §6.2) — spread first, then overwrite every field this
    // version actually understands with a sanitized value.
    ...raw,
    matchId: raw.matchId,
    matchFingerprint: typeof raw.matchFingerprint === 'string' ? raw.matchFingerprint : '',
    status,
    analysisVersion: typeof raw.analysisVersion === 'string' ? raw.analysisVersion : '',
    analyzedAt: typeof raw.analyzedAt === 'string' ? raw.analyzedAt : '',
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    movesGraded: Number.isFinite(raw.movesGraded) ? raw.movesGraded : 0,
    lessonCount: Number.isFinite(raw.lessonCount) ? raw.lessonCount : 0,
    positiveCount: Number.isFinite(raw.positiveCount) ? raw.positiveCount : 0,
    firstLessonPly: Number.isFinite(raw.firstLessonPly) ? raw.firstLessonPly : -1,
    primaryTheme: PRIMARY_THEMES.includes(raw.primaryTheme) ? raw.primaryTheme : 'general',
    takeaway: trimTakeaway(raw.takeaway),
  }
}

// normalizeLearningRecord: tolerant of junk/legacy/missing input — always
// returns a well-shaped, cap-enforced record.
export function normalizeLearningRecord(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const reviews = Array.isArray(value.reviews)
    ? value.reviews.map(normalizeReview).filter(Boolean).slice(0, LEARNING_INDEX_CAP)
    : []
  return {
    schemaVersion: LEARNING_INDEX_SCHEMA_VERSION,
    reviews,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

// buildLearningRecordValue: exactly what gets written to CloudSave. Always
// private (dev-plan §11.4) — this writer must never be shared with the
// public match-history writer. Caps to the 50 most recently updated reviews.
export function buildLearningRecordValue(record) {
  const reviews = (record?.reviews || [])
    .slice()
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, LEARNING_INDEX_CAP)
  return {
    __META: { is_public: false },
    schemaVersion: LEARNING_INDEX_SCHEMA_VERSION,
    reviews,
    updatedAt: new Date().toISOString(),
  }
}

// mergeReviewIntoRecord: pure upsert-by-matchId. Newest valid updatedAt wins
// (dev-plan §6.3 step 3) — an out-of-order write (e.g. a slow retry landing
// after a newer one already saved) must not clobber the newer data.
export function mergeReviewIntoRecord(record, review) {
  if (!review || !review.matchId) return record
  const reviews = record?.reviews || []
  const existing = reviews.find(r => r.matchId === review.matchId)
  if (existing?.updatedAt && review.updatedAt && existing.updatedAt > review.updatedAt) {
    return record
  }
  const others = reviews.filter(r => r.matchId !== review.matchId)
  return {
    ...record,
    reviews: [review, ...others].slice(0, LEARNING_INDEX_CAP),
    updatedAt: new Date().toISOString(),
  }
}

// reviewBadge: what an owner's History row should show for `match`, given
// the current learning-index record (dev-plan §11.3). A fingerprint mismatch
// means the review no longer matches this match's actual moves — a
// completed review downgrades to "review it again" rather than vanishing
// outright; an unfinished 'ready' summary just clears (nothing was ever
// confirmed, so there's nothing worth flagging as stale).
export function reviewBadge(record, match) {
  const empty = { label: null, takeaway: '' }
  if (!match?.id) return empty
  const review = (record?.reviews || []).find(r => r.matchId === match.id)
  if (!review || !review.status) return empty

  const fingerprintMatches = review.matchFingerprint === computeMatchFingerprint(match.moves)
  if (!fingerprintMatches) {
    return review.status === 'reviewed' ? { label: 'Review again', takeaway: '' } : empty
  }
  if (review.status === 'reviewed') return { label: 'Reviewed', takeaway: review.takeaway || '' }
  if (review.status === 'ready') return { label: 'Lesson ready', takeaway: '' }
  return empty
}

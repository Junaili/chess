// COPPA helpers for the family feature — pure, no network, no DOM, so every
// age decision is unit-testable. Two deliberate conservatisms, both erring
// toward treating a player as a child:
//
//  1. The age gate asks for birth YEAR only (data minimization — a full date
//     of birth is more personal information than the decision needs). With
//     year-only precision someone born N years ago may not have had this
//     year's birthday yet, so a player is only *definitely* 13 when the year
//     difference is >= 14.
//  2. A child account's stored dateOfBirth is Dec 31 of the birth year — the
//     latest date it could be — so age computed from it reaches 13 only after
//     the real 13th birthday has certainly passed. Restrictions lift late,
//     never early.

export const CHILD_AGE_LIMIT = 13

export function validateBirthYear(value, now = new Date()) {
  const year = Number.parseInt(String(value ?? '').trim(), 10)
  const currentYear = now.getFullYear()
  if (!Number.isInteger(year) || String(year) !== String(value ?? '').trim()) {
    return { ok: false, error: 'Enter the year you were born (for example, 2001).' }
  }
  if (year > currentYear || year < currentYear - 120) {
    return { ok: false, error: 'Enter a real birth year.' }
  }
  return { ok: true, year }
}

// True when a player born in birthYear could still be under 13 (see note 1).
export function isBirthYearUnder13(birthYear, now = new Date()) {
  return now.getFullYear() - birthYear < CHILD_AGE_LIMIT + 1
}

// Stored DOB for parent-created child accounts (see note 2).
export function childDateOfBirth(birthYear) {
  return `${birthYear}-12-31`
}

// Age in whole years from an IAM dateOfBirth (YYYY-MM-DD); null if absent or
// unparseable.
export function ageFromDateOfBirth(dateOfBirth, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateOfBirth || ''))
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  let age = now.getFullYear() - year
  const birthdayPassed =
    now.getMonth() + 1 > month || (now.getMonth() + 1 === month && now.getDate() >= day)
  if (!birthdayPassed) age -= 1
  return age
}

// Whether this session belongs to a protected child account. Two signals:
//  - the IAM profile's dateOfBirth says under 13 (authoritative for accounts
//    created through the parent-managed flow), or
//  - the player holds the 'child' role in their family (fallback for accounts
//    that predate DOB collection, and a deliberate parental control: a
//    guardian marking a member as child opts them into the protections).
export function isChildSession({ profile = null, familyRole = '' } = {}, now = new Date()) {
  const age = ageFromDateOfBirth(profile?.dateOfBirth, now)
  if (age != null && age < CHILD_AGE_LIMIT) return true
  return familyRole === 'child'
}

// Sign-in address for a parent-created child account: the parent's own
// mailbox with a plus-tag, so password resets and account mail always reach
// the parent (their consent + oversight channel). Random suffix avoids
// collisions between same-nickname siblings.
export function buildChildEmailAlias(parentEmail, nickname, randomBytes = null) {
  const email = String(parentEmail || '').trim()
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return null
  const local = email.slice(0, at).split('+')[0]
  const domain = email.slice(at + 1)
  let slug = String(nickname || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12)
  if (!slug) slug = 'child'
  const bytes = randomBytes || globalThis.crypto.getRandomValues(new Uint8Array(3))
  const suffix = Array.from(bytes, byte => byte.toString(36).padStart(2, '0')).join('').slice(0, 4)
  return `${local}+chess-${slug}-${suffix}@${domain}`
}

// The verifiable-parental-consent record kept on the PARENT's private cloud
// record: who consented, for which child, when, and to what. The parent
// creating the account (with their own signed-in session and their own email
// on the child account) is the consent act; this record is its durable trace.
export function buildConsentRecord({ parentUserId, childUserId, childName, birthYear }, now = new Date()) {
  return {
    childUserId: String(childUserId || ''),
    childName: String(childName || ''),
    birthYear: Number(birthYear) || 0,
    parentUserId: String(parentUserId || ''),
    consentAt: now.toISOString(),
    scope: ['account-creation', 'family-membership', 'gameplay-records', 'family-chat'],
  }
}

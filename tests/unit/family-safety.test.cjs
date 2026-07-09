const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.resolve(__dirname, '../../src/family-safety.mjs'),
))

const NOW = new Date('2026-07-09T12:00:00Z')

test('validateBirthYear accepts plausible years and rejects junk', async () => {
  const { validateBirthYear } = await modulePromise
  assert.equal(validateBirthYear('2013', NOW).ok, true)
  assert.equal(validateBirthYear('2013', NOW).year, 2013)
  assert.equal(validateBirthYear('', NOW).ok, false)
  assert.equal(validateBirthYear('13', NOW).ok, false)
  assert.equal(validateBirthYear('2027', NOW).ok, false)
  assert.equal(validateBirthYear('1899', NOW).ok, false)
  assert.equal(validateBirthYear('20O5', NOW).ok, false)
})

test('year-only under-13 check is conservative at the boundary', async () => {
  const { isBirthYearUnder13 } = await modulePromise
  // Born 2013 → turns 13 sometime during 2026, may not have yet: treat as under.
  assert.equal(isBirthYearUnder13(2013, NOW), true)
  // Born 2012 → turned 13 during 2025 at the latest: definitely 13+.
  assert.equal(isBirthYearUnder13(2012, NOW), false)
  assert.equal(isBirthYearUnder13(2020, NOW), true)
  assert.equal(isBirthYearUnder13(1990, NOW), false)
})

test('child dateOfBirth is the latest date in the birth year', async () => {
  const { childDateOfBirth, ageFromDateOfBirth, CHILD_AGE_LIMIT } = await modulePromise
  assert.equal(childDateOfBirth(2015), '2015-12-31')
  // A child born early in 2013 is really 13 by July 2026, but the stored
  // Dec-31 DOB keeps the computed age at 12 — restrictions lift late, never early.
  assert.equal(ageFromDateOfBirth(childDateOfBirth(2013), NOW), 12)
  assert.ok(ageFromDateOfBirth(childDateOfBirth(2013), NOW) < CHILD_AGE_LIMIT)
})

test('ageFromDateOfBirth handles real dates and rejects junk', async () => {
  const { ageFromDateOfBirth } = await modulePromise
  assert.equal(ageFromDateOfBirth('2013-07-01', NOW), 13) // birthday passed
  assert.equal(ageFromDateOfBirth('2013-08-01', NOW), 12) // birthday ahead
  assert.equal(ageFromDateOfBirth('', NOW), null)
  assert.equal(ageFromDateOfBirth('not-a-date', NOW), null)
  assert.equal(ageFromDateOfBirth('2013-99-99', NOW), null)
})

test('isChildSession triggers on under-13 DOB or child family role', async () => {
  const { isChildSession } = await modulePromise
  assert.equal(isChildSession({ profile: { dateOfBirth: '2015-12-31' } }, NOW), true)
  assert.equal(isChildSession({ profile: { dateOfBirth: '1990-01-01' } }, NOW), false)
  // Legacy accounts without DOB: the guardian-assigned child role opts in.
  assert.equal(isChildSession({ profile: {}, familyRole: 'child' }, NOW), true)
  assert.equal(isChildSession({ profile: {}, familyRole: 'guardian' }, NOW), false)
  assert.equal(isChildSession({}, NOW), false)
  // An adult DOB with a child role still gets the protections (parental control).
  assert.equal(isChildSession({ profile: { dateOfBirth: '1990-01-01' }, familyRole: 'child' }, NOW), true)
})

test('child email alias tags the parent mailbox', async () => {
  const { buildChildEmailAlias } = await modulePromise
  const alias = buildChildEmailAlias('jun@example.com', 'Ethan!', Uint8Array.from([1, 2, 3]))
  assert.match(alias, /^jun\+chess-ethan-[a-z0-9]{4}@example\.com$/)
  // Parent address already tagged → tag is replaced, not stacked.
  const retag = buildChildEmailAlias('jun+foo@example.com', 'Mia', Uint8Array.from([9, 9, 9]))
  assert.match(retag, /^jun\+chess-mia-[a-z0-9]{4}@example\.com$/)
  // Nickname with no usable characters falls back, invalid parent email → null.
  assert.match(buildChildEmailAlias('a@b.co', '♞♞', Uint8Array.from([1, 1, 1])), /\+chess-child-/)
  assert.equal(buildChildEmailAlias('not-an-email', 'Kid'), null)
  assert.equal(buildChildEmailAlias('@nolocal.com', 'Kid'), null)
})

test('consent record captures parent, child, and scope', async () => {
  const { buildConsentRecord } = await modulePromise
  const record = buildConsentRecord(
    { parentUserId: 'p1', childUserId: 'c1', childName: 'Ethan', birthYear: 2016 },
    NOW,
  )
  assert.equal(record.parentUserId, 'p1')
  assert.equal(record.childUserId, 'c1')
  assert.equal(record.birthYear, 2016)
  assert.equal(record.consentAt, NOW.toISOString())
  assert.ok(record.scope.includes('account-creation'))
  assert.ok(record.scope.includes('family-chat'))
})

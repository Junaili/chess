const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePromise = import(pathToFileURL(
  path.resolve(__dirname, '../../src/family-feedback.mjs'),
))

test('normalizeFamilyError: session expiry maps to an authentication reason', async () => {
  const { normalizeFamilyError } = await modulePromise
  const result = normalizeFamilyError(401, {})
  assert.equal(result.reason, 'authentication')
  assert.match(result.error, /sign in/i)
})

test('normalizeFamilyError: 73036 (insufficient member role) says only a guardian can do that', async () => {
  const { normalizeFamilyError } = await modulePromise
  const result = normalizeFamilyError(403, { errorCode: 73036 })
  assert.equal(result.reason, 'not_allowed')
  assert.match(result.error, /guardian/i)
})

test('normalizeFamilyError: 73342 (already joined) explains the player is already in a family', async () => {
  const { normalizeFamilyError } = await modulePromise
  const result = normalizeFamilyError(409, { errorCode: 73342 })
  assert.equal(result.reason, 'already_in_family')
  assert.match(result.error, /already in a family/i)
})

test('normalizeFamilyError: server errors map to unavailable with a retry message', async () => {
  const { normalizeFamilyError } = await modulePromise
  const result = normalizeFamilyError(503, {})
  assert.equal(result.reason, 'unavailable')
  assert.match(result.error, /try again/i)
})

test('normalizeFamilyError: unknown failures fall back to the caller-provided message', async () => {
  const { normalizeFamilyError } = await modulePromise
  const result = normalizeFamilyError(418, {}, 'Custom fallback.')
  assert.equal(result.reason, 'unknown')
  assert.equal(result.error, 'Custom fallback.')
})

test('isNotInGroupResponse: 73034 on 404 or 403 is the normal empty state, anything else is not', async () => {
  const { isNotInGroupResponse } = await modulePromise
  assert.equal(isNotInGroupResponse(404, { errorCode: 73034 }), true)
  assert.equal(isNotInGroupResponse(403, { errorCode: 73034 }), true)
  assert.equal(isNotInGroupResponse(404, { errorCode: 99999 }), false)
  assert.equal(isNotInGroupResponse(200, { errorCode: 73034 }), false)
})

test('resolveMemberRole: maps role IDs via the catalog, guardian wins, unknown falls back to child', async () => {
  const { resolveMemberRole } = await modulePromise
  const rolesById = { 'id-g': 'guardian', 'id-c': 'child' }
  assert.equal(resolveMemberRole(['id-g'], rolesById), 'guardian')
  assert.equal(resolveMemberRole(['id-c'], rolesById), 'child')
  assert.equal(resolveMemberRole(['id-c', 'id-g'], rolesById), 'guardian')
  assert.equal(resolveMemberRole(['mystery-id'], rolesById), 'child')
  assert.equal(resolveMemberRole([], rolesById), 'child')
  assert.equal(resolveMemberRole(undefined, rolesById), 'child')
})

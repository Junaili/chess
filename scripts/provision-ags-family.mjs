// Provisions the AGS Group service config for the Family feature:
// two member roles (guardian, child) and the "chess-family" group
// configuration wiring them as admin/member defaults. Idempotent — safe to
// re-run; reasserts guardian/child permissions if they've drifted.
//
// Usage (dry-run by default, --apply to mutate):
//   AGS_ACCESS_TOKEN=<admin user token> node scripts/provision-ags-family.mjs [--apply]
//
// The token must be an admin USER token for the publisher subdomain
// (https://seal.prod.gamingservices.accelbyte.io) with GROUP admin
// permissions — same token workflow as scripts/provision-ags-legal.mjs.
// Verified live 2026-07-07: full create→invite→accept→role-check→disband
// smoke test passed against this exact configuration.

const NAMESPACE = process.env.AGS_NAMESPACE || 'seal-chessags'
const BASE = process.env.AGS_BASE_URL || 'https://seal.prod.gamingservices.accelbyte.io'
const TOKEN = process.env.AGS_ACCESS_TOKEN
const apply = process.argv.includes('--apply')

const CONFIGURATION_CODE = 'chess-family'
// AGS member-role permission action bits: CREATE=1, READ=2, UPDATE=4, DELETE=8.
const ROLES = {
  guardian: [
    { resourceName: 'GROUP', action: 12 },        // update group info, disband family
    { resourceName: 'GROUP:INVITE', action: 9 },  // invite + cancel invitation
    { resourceName: 'GROUP:JOIN', action: 1 },    // accept/reject join requests
    { resourceName: 'GROUP:KICK', action: 1 },    // remove a member
    { resourceName: 'GROUP:ROLE', action: 1 },    // promote a second parent to guardian
  ],
  child: [], // no invite/kick/role powers — a child cannot add strangers to the family
}

if (!TOKEN) {
  console.error('AGS_ACCESS_TOKEN is required (admin user token, publisher subdomain).')
  process.exit(2)
}

async function call(method, path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await resp.json() } catch {}
  if (!resp.ok) {
    throw new Error(`${method} ${path} -> ${resp.status}: ${JSON.stringify(data)}`)
  }
  return data
}

function samePermissions(a, b) {
  const key = list => [...list].map(p => `${p.resourceName}:${p.action}`).sort().join(',')
  return key(a) === key(b)
}

async function ensureRole(name, permissions) {
  const listing = await call('GET', `/group/v1/admin/namespaces/${NAMESPACE}/roles?limit=100`)
  const existing = (listing.data || []).find(role => role.memberRoleName === name)
  if (!existing) {
    if (!apply) {
      console.log(`[plan] create member role "${name}" with ${permissions.length} permission(s)`)
      return null
    }
    const created = await call('POST', `/group/v1/admin/namespaces/${NAMESPACE}/roles`, {
      memberRoleName: name,
      memberRolePermissions: permissions,
    })
    console.log(`created role "${name}" -> ${created.memberRoleId}`)
    return created.memberRoleId
  }
  if (!samePermissions(existing.memberRolePermissions || [], permissions)) {
    if (!apply) {
      console.log(`[plan] reassert permissions on role "${name}" (${existing.memberRoleId}) — drifted`)
    } else {
      await call('PUT', `/group/v1/admin/namespaces/${NAMESPACE}/roles/${existing.memberRoleId}/permissions`, {
        memberRolePermissions: permissions,
      })
      console.log(`reasserted permissions on role "${name}" (${existing.memberRoleId})`)
    }
  } else {
    console.log(`role "${name}" ok (${existing.memberRoleId})`)
  }
  return existing.memberRoleId
}

async function ensureConfiguration(guardianRoleId, childRoleId) {
  const listing = await call('GET', `/group/v1/admin/namespaces/${NAMESPACE}/configuration?limit=100`)
  const existing = (listing.data || []).find(c => c.configurationCode === CONFIGURATION_CODE)
  if (existing) {
    // groupAdminRoleId/groupMemberRoleId are immutable after creation — if
    // they don't match, that's a re-provisioning problem a human must resolve
    // (delete + recreate loses nothing while no real families exist yet).
    const ok = existing.groupAdminRoleId === guardianRoleId && existing.groupMemberRoleId === childRoleId
    console.log(`configuration "${CONFIGURATION_CODE}" ${ok ? 'ok' : 'EXISTS WITH MISMATCHED ROLE IDS — manual fix needed'}`)
    return
  }
  if (!apply) {
    console.log(`[plan] create configuration "${CONFIGURATION_CODE}" (admin=guardian, member=child, max 8)`)
    return
  }
  if (!guardianRoleId || !childRoleId) {
    throw new Error('roles must exist before the configuration can be created — re-run with --apply')
  }
  await call('POST', `/group/v1/admin/namespaces/${NAMESPACE}/configuration`, {
    configurationCode: CONFIGURATION_CODE,
    name: 'Chess Family',
    description: 'Private family groups: guardians and children playing chess together. Invite-only.',
    groupMaxMember: 8,
    groupAdminRoleId: guardianRoleId,
    groupMemberRoleId: childRoleId,
    globalRules: [],
  })
  console.log(`created configuration "${CONFIGURATION_CODE}"`)
}

const guardianId = await ensureRole('guardian', ROLES.guardian)
const childId = await ensureRole('child', ROLES.child)
await ensureConfiguration(guardianId, childId)
console.log(apply ? 'done.' : 'dry run complete — re-run with --apply to mutate.')

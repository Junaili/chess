// Family feature: one private, invite-only AGS Group per family, with
// guardian/child member roles (provisioned by scripts/provision-ags-family.mjs).
// No @accelbyte/sdk-group package exists, so this talks to the Group v2 REST
// endpoints directly with the SDK's token — same raw-fetch pattern legal.js
// uses for the Agreement service. All endpoints verified live against the
// seal shared-cloud tier 2026-07-07 (create → invite → accept → role checks →
// child-invite rejected 403 → disband).
import { UsersV4Api } from '@accelbyte/sdk-iam'
import { PublicPlayerRecordApi } from '@accelbyte/sdk-cloudsave'
import { sdk } from './ags-client.js'
import { extendFetch } from './extend-client.js'
import { resolveDisplayNames, cacheDisplayName } from './leaderboard.js'
import { fetchPresenceMap } from './presence.js'
import { moderateIncomingDisplayName } from './content-moderation.mjs'
import { normalizeFamilyError, isNotInGroupResponse, resolveMemberRole } from './family-feedback.mjs'

const CONFIGURATION_CODE = 'chess-family'

// The AGS Group service handles the CORS *preflight* (OPTIONS returns
// Access-Control-Allow-Origin) but its actual API responses omit that header
// entirely — verified against production — so a browser can never read a
// Group response cross-origin, unlike Leaderboard/Cloudsave whose real
// responses do include it. Two transports work around that:
//  - dev/e2e: the Vite proxy makes /group same-origin (direct calls below);
//  - production: Group calls go through the Extend service's whitelisted
//    /family/group proxy (cmd/family_group_proxy.go — server-to-server, no
//    browser CORS, same fix the CloudFront legal attachments needed), reached
//    at VITE_EXTEND_EMAIL_URL like every other Extend endpoint.
// A production-style build without that URL (e.g. a local `vite build`) has
// neither transport, so the Family panel stays hidden there.
export function familyTransportAvailable() {
  return !!import.meta.env.DEV || !!import.meta.env.VITE_EXTEND_EMAIL_URL
}

function getConfig() {
  const { coreConfig } = sdk.assembly()
  return { baseURL: coreConfig.baseURL, namespace: coreConfig.namespace }
}

async function groupFetch(method, path, body) {
  const { baseURL, namespace } = getConfig()
  const resolvedPath = path.replace('{ns}', encodeURIComponent(namespace))
  let resp
  if (import.meta.env.DEV) {
    // Same-origin via the Vite /group proxy — keeps dev/e2e independent of a
    // locally running Extend service.
    const accessToken = sdk.getToken()?.accessToken
    if (!accessToken) return { status: 401, data: null }
    resp = await fetch(`${baseURL}/group/${resolvedPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } else {
    // extendFetch attaches the token (with the cookie fallback the deployed
    // service boundary needs) and refresh-retries an expired session once.
    resp = await extendFetch(`/family/group/${resolvedPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
  }
  let data = null
  try { data = await resp.json() } catch {}
  return { status: resp.status, data }
}

// Role IDs are environment-specific (assigned at provisioning time); the
// public v2 roles catalog resolves them to names at runtime so nothing is
// hardcoded. Cached for the session — roles only change via re-provisioning.
let rolesByIdCache = null
async function fetchRolesById() {
  if (rolesByIdCache) return rolesByIdCache
  const res = await groupFetch('GET', 'v2/public/namespaces/{ns}/roles?limit=100')
  if (res.status !== 200) return {}
  rolesByIdCache = Object.fromEntries(
    (res.data?.data || []).map(role => [role.memberRoleId, role.memberRoleName]),
  )
  return rolesByIdCache
}

async function withNames(members) {
  if (!members.length) return members
  let nameMap = resolveDisplayNames(members.map(m => ({ userId: m.userId })))
  const missing = members.filter(m => !nameMap[m.userId])
  if (missing.length) {
    const { coreConfig } = sdk.assembly()
    const v4 = UsersV4Api(sdk, { coreConfig: { ...coreConfig, useSchemaValidation: false } })
    const results = await Promise.allSettled(missing.map(m => v4.getUser_ByUserId_v4(m.userId)))
    for (const outcome of results) {
      if (outcome.status !== 'fulfilled') continue
      const user = outcome.value?.data
      const rawName = user?.displayName || user?.uniqueDisplayName
      if (rawName && user?.userId) cacheDisplayName(user.userId, rawName)
    }
    nameMap = resolveDisplayNames(members.map(m => ({ userId: m.userId })))
  }
  return members.map(m => ({
    ...m,
    displayName: moderateIncomingDisplayName(nameMap[m.userId] || '', 'Family member'),
  }))
}

async function withPresence(members) {
  if (!members.length) return members
  try {
    const presenceMap = await fetchPresenceMap(members.map(m => m.userId))
    return members.map(m => ({
      ...m,
      presence: presenceMap[m.userId] || { status: 'offline', label: 'Offline', activity: '' },
    }))
  } catch {
    return members.map(m => ({
      ...m,
      presence: { status: 'offline', label: 'Offline', activity: '' },
    }))
  }
}

// -> { ok, group: {groupId, groupName} | null, members: [{userId, displayName,
//      role, presence}], incomingInvites: [{groupId, groupName}] }
// Same {ok, ...} result convention as fetchFriendState so main.js can treat
// the two identically.
export async function fetchFamilyState() {
  // Skip the network entirely where the browser can't read Group responses
  // (see familyTransportAvailable) — an empty, ok state so the panel simply
  // stays hidden with no console noise, rather than a doomed cross-origin
  // fetch on every refresh.
  if (!familyTransportAvailable()) {
    return { ok: true, group: null, members: [], incomingInvites: [] }
  }
  try {
    const [mine, invites, rolesById] = await Promise.all([
      groupFetch('GET', 'v2/public/namespaces/{ns}/users/me/groups?limit=10'),
      groupFetch('GET', 'v1/public/namespaces/{ns}/users/me/invite/request?limit=10'),
      fetchRolesById(),
    ])

    const incomingInvites = []
    if (invites.status === 200) {
      for (const invite of invites.data?.data || []) {
        if (invite.requestType !== 'INVITE' || !invite.groupId) continue
        // Group detail may 403 for a private group we're not in yet — a
        // generic label is fine in that case.
        const detail = await groupFetch('GET', `v1/public/namespaces/{ns}/groups/${encodeURIComponent(invite.groupId)}`)
        incomingInvites.push({
          groupId: invite.groupId,
          groupName: detail.status === 200
            ? moderateIncomingDisplayName(detail.data?.groupName || '', 'A family')
            : 'A family',
        })
      }
    }

    // A 404 with no AGS errorCode is the deployed Extend service's generic
    // Not Found — the running image predates the /family/group proxy. Report
    // an empty state flagged transportMissing so the panel hides quietly
    // instead of showing a spurious error; self-heals once the proxy ships.
    if (mine.status === 404 && !mine.data?.errorCode) {
      return { ok: true, group: null, members: [], incomingInvites: [], transportMissing: true }
    }
    if (isNotInGroupResponse(mine.status, mine.data)) {
      return { ok: true, group: null, members: [], incomingInvites }
    }
    if (mine.status !== 200) {
      console.warn('[AGS family] fetchFamilyState:', mine.status, mine.data)
      return { ok: false, ...normalizeFamilyError(mine.status, mine.data, 'Could not load your family. Please try again.') }
    }

    const membership = (mine.data?.data || []).find(entry => entry.status === 'JOINED')
    if (!membership?.groupId) {
      return { ok: true, group: null, members: [], incomingInvites }
    }

    const detail = await groupFetch('GET', `v1/public/namespaces/{ns}/groups/${encodeURIComponent(membership.groupId)}`)
    if (detail.status !== 200) {
      console.warn('[AGS family] group detail:', detail.status, detail.data)
      return { ok: false, ...normalizeFamilyError(detail.status, detail.data, 'Could not load your family. Please try again.') }
    }
    // Only surface groups of our configuration — a future non-family group
    // type must not render in the Family panel.
    if (detail.data?.configurationCode !== CONFIGURATION_CODE) {
      return { ok: true, group: null, members: [], incomingInvites }
    }

    let members = (detail.data?.groupMembers || []).map(member => ({
      userId: member.userId,
      role: resolveMemberRole(member.memberRoleId, rolesById),
    }))
    members = await withPresence(await withNames(members))

    return {
      ok: true,
      group: {
        groupId: detail.data.groupId,
        groupName: moderateIncomingDisplayName(detail.data.groupName || '', 'My family'),
      },
      members,
      incomingInvites,
    }
  } catch (e) {
    console.warn('[AGS family] fetchFamilyState:', e?.message || e)
    return { ok: false, reason: 'unavailable', error: 'Could not load your family. Please try again.' }
  }
}

export async function createFamilyGroup(groupName) {
  const res = await groupFetch('POST', 'v2/public/namespaces/{ns}/groups', {
    groupName: String(groupName || 'My Family').slice(0, 48),
    groupRegion: 'us',
    groupType: 'PRIVATE',
    configurationCode: CONFIGURATION_CODE,
    groupMaxMember: 8,
  })
  if (res.status !== 201) {
    console.warn('[AGS family] createFamilyGroup:', res.status, res.data)
    return { ok: false, ...normalizeFamilyError(res.status, res.data, 'Could not create the family. Please try again.') }
  }
  return { ok: true, groupId: res.data.groupId }
}

// Guardian-only — the group service rejects this server-side (403, code
// 73036) for child-role members, so the UI gate is cosmetic, not the guard.
export async function inviteToFamily(userId, groupId) {
  const res = await groupFetch('POST', `v2/public/namespaces/{ns}/users/${encodeURIComponent(userId)}/groups/${encodeURIComponent(groupId)}/invite`)
  if (res.status >= 300) {
    console.warn('[AGS family] inviteToFamily:', res.status, res.data)
    return { ok: false, ...normalizeFamilyError(res.status, res.data, 'Could not send the family invite. Please try again.') }
  }
  return { ok: true }
}

export async function acceptFamilyInvite(groupId) {
  const res = await groupFetch('POST', `v2/public/namespaces/{ns}/groups/${encodeURIComponent(groupId)}/invite/accept`)
  if (res.status >= 300) {
    console.warn('[AGS family] acceptFamilyInvite:', res.status, res.data)
    return { ok: false, ...normalizeFamilyError(res.status, res.data, 'Could not accept the family invite. Please try again.') }
  }
  return { ok: true }
}

export async function rejectFamilyInvite(groupId) {
  const res = await groupFetch('POST', `v1/public/namespaces/{ns}/groups/${encodeURIComponent(groupId)}/invite/reject`)
  if (res.status >= 300) {
    console.warn('[AGS family] rejectFamilyInvite:', res.status, res.data)
    return { ok: false, ...normalizeFamilyError(res.status, res.data, 'Could not decline the family invite. Please try again.') }
  }
  return { ok: true }
}

export async function removeFamilyMember(userId, groupId) {
  const res = await groupFetch('POST', `v2/public/namespaces/{ns}/users/${encodeURIComponent(userId)}/groups/${encodeURIComponent(groupId)}/kick`)
  if (res.status >= 300) {
    console.warn('[AGS family] removeFamilyMember:', res.status, res.data)
    return { ok: false, ...normalizeFamilyError(res.status, res.data, 'Could not remove this family member. Please try again.') }
  }
  return { ok: true }
}

export async function leaveFamily(groupId) {
  const res = await groupFetch('POST', `v2/public/namespaces/{ns}/groups/${encodeURIComponent(groupId)}/leave`)
  if (res.status >= 300) {
    console.warn('[AGS family] leaveFamily:', res.status, res.data)
    return { ok: false, ...normalizeFamilyError(res.status, res.data, 'Could not leave the family. Please try again.') }
  }
  return { ok: true }
}

// Guardian-only disband. AGS auto-deletes an empty group when the last
// member leaves, so this is only needed for an explicit "disband family"
// action while members remain.
export async function disbandFamily(groupId) {
  const res = await groupFetch('DELETE', `v1/public/namespaces/{ns}/groups/${encodeURIComponent(groupId)}`)
  if (res.status >= 300) {
    console.warn('[AGS family] disbandFamily:', res.status, res.data)
    return { ok: false, ...normalizeFamilyError(res.status, res.data, 'Could not disband the family. Please try again.') }
  }
  return { ok: true }
}

// ── Parental consent records (COPPA) ────────────────────────────────────────
// Kept on the PARENT's own CloudSave record — private (no is_public META),
// written from the parent's session at the moment they create the child
// account. One entry per child; re-consent for the same child replaces the
// earlier entry.

const CONSENT_RECORD_KEY = 'chess-family-consents'

function consentApi() {
  const { coreConfig } = sdk.assembly()
  return PublicPlayerRecordApi(sdk, {
    coreConfig: { ...coreConfig, useSchemaValidation: false },
  })
}

export async function recordParentalConsent(parentUserId, consent) {
  try {
    const api = consentApi()
    let existing = []
    try {
      const res = await api.getRecord_ByUserId_ByKey(parentUserId, CONSENT_RECORD_KEY)
      existing = Array.isArray(res.data?.value?.consents) ? res.data.value.consents : []
    } catch (e) {
      if (e?.response?.status !== 404) throw e
    }
    const record = {
      consents: [...existing.filter(entry => entry.childUserId !== consent.childUserId), consent],
      updatedAt: new Date().toISOString(),
    }
    try {
      await api.updateRecord_ByUserId_ByKey(parentUserId, CONSENT_RECORD_KEY, record)
    } catch (e) {
      if (e?.response?.status !== 404) throw e
      await api.createRecord_ByUserId_ByKey(parentUserId, CONSENT_RECORD_KEY, record)
    }
    return { ok: true }
  } catch (e) {
    console.warn('[AGS family] recordParentalConsent:', e?.response?.status || '', e?.response?.data || e?.message || e)
    return { ok: false, error: 'The account was created but the consent note could not be saved.' }
  }
}

export async function fetchParentalConsents(parentUserId) {
  try {
    const res = await consentApi().getRecord_ByUserId_ByKey(parentUserId, CONSENT_RECORD_KEY)
    return { ok: true, consents: Array.isArray(res.data?.value?.consents) ? res.data.value.consents : [] }
  } catch (e) {
    if (e?.response?.status === 404) return { ok: true, consents: [] }
    return { ok: false, consents: [] }
  }
}

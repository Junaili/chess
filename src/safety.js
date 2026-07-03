import { PublicReasonsApi, PublicReportsApi } from '@accelbyte/sdk-reporting'
import { PlayerApi } from '@accelbyte/sdk-lobby'
import { sdk } from './ags-client.js'
import {
  buildChatReport,
  buildUserReport,
  normalizeBlockedPlayers,
} from './safety-payloads.mjs'

export { buildChatReport, buildUserReport, normalizeBlockedPlayers }

export const PLAYER_SAFETY_REASON_GROUP = 'Player Safety'

function required(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

export async function fetchPlayerSafetyReasons() {
  const response = await PublicReasonsApi(sdk).getReasons({
    group: PLAYER_SAFETY_REASON_GROUP,
    limit: 100,
    offset: 0,
  })
  return (response?.data?.data || [])
    .map(reason => ({
      title: String(reason?.title || '').trim(),
      description: String(reason?.description || '').trim(),
    }))
    .filter(reason => reason.title)
}

export async function reportChatMessage(input) {
  const payload = buildChatReport(input)
  const response = await PublicReportsApi(sdk).createReport(payload)
  return response.data
}

export async function reportPlayer(input) {
  const payload = buildUserReport(input)
  const response = await PublicReportsApi(sdk).createReport(payload)
  return response.data
}

export async function listBlockedPlayers() {
  const response = await PlayerApi(sdk).getPlayerUsersMeBlocked()
  return normalizeBlockedPlayers(response?.data)
}

export async function blockPlayer(userId) {
  const blockedUserId = required(userId, 'Player ID')
  await PlayerApi(sdk).createPlayerUserMeBlock({ blockedUserId })
  return { userId: blockedUserId }
}

export async function unblockPlayer(userId) {
  const normalizedUserId = required(userId, 'Player ID')
  await PlayerApi(sdk).createPlayerUserMeUnblock({ userId: normalizedUserId })
  return { userId: normalizedUserId }
}

export function getSafetyError(error, fallback = 'The safety action could not be completed.') {
  const status = error?.response?.status
  const data = error?.response?.data
  if (status === 409) return 'You already reported this item.'
  if (status === 429) return 'Too many reports. Please wait and try again.'
  return data?.errorMessage || data?.message || error?.message || fallback
}

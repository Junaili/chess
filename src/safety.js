import { PlayerApi } from '@accelbyte/sdk-lobby'
import { sdk } from './ags-client.js'
import { extendFetch } from './extend-client.js'
import {
  buildChatReport,
  buildUserReport,
  getReportTicketId,
  getSafetyError,
  normalizeBlockedPlayers,
} from './safety-payloads.mjs'

export { buildChatReport, buildUserReport, getReportTicketId, getSafetyError, normalizeBlockedPlayers }

export const PLAYER_SAFETY_REASON_GROUP = 'Player Safety'

function required(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

async function readSafetyResponse(response, fallback) {
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text }
    }
  }
  if (!response.ok) {
    const error = new Error(
      data?.errorMessage || data?.message || data?.error || fallback
    )
    error.response = { status: response.status, data }
    throw error
  }
  return data
}

export async function fetchPlayerSafetyReasons() {
  const response = await extendFetch('/safety/reasons')
  const data = await readSafetyResponse(response, 'Could not load report reasons.')
  return (data?.data || [])
    .map(reason => ({
      title: String(reason?.title || '').trim(),
      description: String(reason?.description || '').trim(),
    }))
    .filter(reason => reason.title)
}

export async function reportChatMessage(input) {
  const payload = buildChatReport(input)
  const response = await extendFetch('/safety/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return readSafetyResponse(response, 'Could not report this message.')
}

export async function reportPlayer(input) {
  const payload = buildUserReport(input)
  const response = await extendFetch('/safety/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return readSafetyResponse(response, 'Could not report this player.')
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

import { GameSessionApi } from '@accelbyte/sdk-session'
import { sdk } from './ags-client.js'
import { connectToFiona } from './fiona-signal.mjs'

// AGS adapter for Fiona's session-scoped WebRTC signaling. The Session API
// authorizes these calls with the signed-in player's token; storage updates are
// always scoped to the matched game session passed in by matchmaking.
export function connectToFionaViaAgs(sessionId, rtcConfig) {
  const sessions = GameSessionApi(sdk)
  return connectToFiona({
    sessionId,
    rtcConfig,
    writeStorage: async storage => {
      await sessions.patchGamesession_BySessionId(sessionId, { storage })
    },
    readStorage: async () => {
      const response = await sessions.getGamesession_BySessionId(sessionId)
      return response.data?.storage || {}
    },
  })
}

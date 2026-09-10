/**
 * postMessage contract between the two YouTube content-script worlds
 * (MAIN-world `youtube-player-bridge.content.ts` answers, isolated
 * `youtube-subtitles.content.ts` asks via `player-bridge.ts`). Single source
 * of truth for the message type literals and payload shapes — both worlds
 * import from here, so a drift is a compile error, not a silent timeout.
 *
 * All payloads are plain JSON (postMessage structured-clones them). Optional
 * data that YouTube's player may not expose is `null` (JSON-preservable),
 * never a masked empty string.
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */

export const PLAYER_DATA_REQUEST_TYPE = "LINGO_TR_GET_PLAYER_DATA"
export const PLAYER_DATA_RESPONSE_TYPE = "LINGO_TR_PLAYER_DATA"
export const WAIT_TIMEDTEXT_REQUEST_TYPE = "LINGO_TR_WAIT_TIMEDTEXT"
export const WAIT_TIMEDTEXT_RESPONSE_TYPE = "LINGO_TR_TIMEDTEXT_READY"
export const ENSURE_SUBTITLES_REQUEST_TYPE = "LINGO_TR_ENSURE_SUBTITLES"
export const ENSURE_SUBTITLES_RESPONSE_TYPE = "LINGO_TR_ENSURE_SUBTITLES_DONE"

/** How long the isolated side waits for a bridge reply before treating the bridge as absent. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 6_000
/** How long the MAIN world waits for YouTube to issue a signed timedtext request (fallback pot path). */
export const TIMEDTEXT_WAIT_TIMEOUT_MS = 5_000

/** One caption track from `player.getPlayerResponse().captions.playerCaptionsTracklistRenderer.captionTracks`. */
export type BridgeCaptionTrack = {
  baseUrl: string
  languageCode: string
  /** `"asr"` = auto-generated. Absent for human tracks. */
  kind?: string
  vssId: string
  /** Present when the track has a display name (often a translated/labelled track). */
  hasName: boolean
}

/** One audio caption track — its URL carries the `pot`/`potc` params the timedtext endpoint requires. */
export type BridgeAudioCaptionTrack = {
  url: string
  vssId: string | null
  kind: string | null
  languageCode: string | null
}

export type BridgePlayerData = {
  videoId: string
  captionTracks: BridgeCaptionTrack[]
  audioCaptionTracks: BridgeAudioCaptionTrack[]
  /** `ytcfg.get("DEVICE")` query-string blob (cbrand/cbr/...), or null when unavailable. */
  device: string | null
  /** innertube client version for the `cver` param, or null. */
  cver: string | null
  /** `player.getPlayerState()`; -1 when the API is unavailable. >=1 means media loaded. */
  playerState: number
  selectedTrackLanguageCode: string | null
  selectedTrackVssId: string | null
  /** Signed timedtext URL captured from YouTube's own XHR, or null if none seen yet. */
  cachedTimedtextBody?: string
  cachedTimedtextBodyLanguage?: string
  cachedTimedtextUrl: string | null
}

export type PlayerDataRequest = {
  type: typeof PLAYER_DATA_REQUEST_TYPE
  requestId: string
  expectedVideoId: string
}

export type PlayerDataResponse = {
  type: typeof PLAYER_DATA_RESPONSE_TYPE
  requestId: string
} & ({ success: true; data: BridgePlayerData } | { success: false; error: string })

export type WaitTimedtextRequest = {
  type: typeof WAIT_TIMEDTEXT_REQUEST_TYPE
  requestId: string
  videoId: string
}

export type WaitTimedtextResponse = {
  type: typeof WAIT_TIMEDTEXT_RESPONSE_TYPE
  requestId: string
  url: string | null
}

export type EnsureSubtitlesRequest = {
  type: typeof ENSURE_SUBTITLES_REQUEST_TYPE
  requestId: string
}

export type EnsureSubtitlesResponse = {
  type: typeof ENSURE_SUBTITLES_RESPONSE_TYPE
  requestId: string
}

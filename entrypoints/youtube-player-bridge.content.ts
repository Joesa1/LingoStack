/**
 * MAIN-world YouTube player bridge (D17). The caption track list, the signed
 * `pot` token, and the player state live only in the page's JS context —
 * unreachable from an isolated content script — so this script runs in
 * `world: "main"` at `document_start` and answers the isolated subtitle
 * script's postMessage requests (contract in `src/subtitles/bridge-messages.ts`).
 *
 * It also patches `XMLHttpRequest` open/send to capture YouTube's own signed
 * `api/timedtext` request URLs per videoId — the fallback `pot` source when
 * the player data doesn't carry one.
 *
 * This script holds NO chrome.* access (MAIN world) and initiates nothing on
 * its own: it only answers requests and observes XHRs the page already makes.
 *
 * Based on: docs/packages/web-translate/README.md §7.9.
 */
import type {
  BridgeAudioCaptionTrack,
  BridgeCaptionTrack,
  PlayerDataRequest,
  PlayerDataResponse,
} from "../src/subtitles/bridge-messages"

import {
  ENSURE_SUBTITLES_REQUEST_TYPE,
  ENSURE_SUBTITLES_RESPONSE_TYPE,
  PLAYER_DATA_REQUEST_TYPE,
  PLAYER_DATA_RESPONSE_TYPE,
  TIMEDTEXT_WAIT_TIMEOUT_MS,
  WAIT_TIMEDTEXT_REQUEST_TYPE,
  WAIT_TIMEDTEXT_RESPONSE_TYPE,
} from "../src/subtitles/bridge-messages"

type YoutubePlayerElement = HTMLElement & {
  getPlayerResponse?: () => unknown
  getAudioTrack?: () => unknown
  getPlayerState?: () => number
  getWebPlayerContextConfig?: () => unknown
  getOption?: (module: string, option: string) => unknown
  toggleSubtitles?: () => void
}

const INJECTED_FLAG = "__LINGO_TR_PLAYER_BRIDGE_INJECTED__"

// --- timedtext URL capture (XHR patch) --------------------------------------

const timedtextUrlCache = new Map<string, string>()
const timedtextBodies = new Map<string, { body: string; language: string }>()
function cacheBody(url: string, body: string) {
  try {
    const u = new URL(url, location.origin)
    if (!u.pathname.endsWith("/api/timedtext") || !body.trim().startsWith("{") || body.length > 8_000_000) return
    const videoId = u.searchParams.get("v")
    if (!videoId || !Array.isArray(JSON.parse(body).events)) return
    timedtextBodies.set(videoId, { body, language: u.searchParams.get("lang") ?? "en" })
    if (timedtextBodies.size > 3) timedtextBodies.delete(timedtextBodies.keys().next().value!)
  } catch { /* Only JSON3 subtitle responses are reusable. */ }
}
const timedtextUrlWaiters = new Map<string, ((url: string) => void)[]>()

function cacheTimedtextUrl(url: string): void {
  if (!url.includes("api/timedtext")) return
  let videoId: string | null
  let pot: string | null
  try {
    const parsed = new URL(url, window.location.origin)
    videoId = parsed.searchParams.get("v")
    pot = parsed.searchParams.get("pot")
  } catch {
    return // not a parseable URL — nothing to cache
  }
  if (videoId === null) return
  timedtextUrlCache.set(videoId, url)
  if (timedtextUrlCache.size > 10) timedtextUrlCache.delete(timedtextUrlCache.keys().next().value!)
  const waiters = timedtextUrlWaiters.get(videoId)
  if (waiters !== undefined) {
    for (const resolve of waiters) resolve(url)
    timedtextUrlWaiters.delete(videoId)
  }
}

function waitForTimedtextUrl(videoId: string, timeoutMs: number): Promise<string | null> {
  const cached = timedtextUrlCache.get(videoId)
  if (cached !== undefined) return Promise.resolve(cached)

  return new Promise((resolve) => {
    const waiters = timedtextUrlWaiters.get(videoId) ?? []
    const waiter = (url: string): void => resolve(url)
    waiters.push(waiter)
    timedtextUrlWaiters.set(videoId, waiters)

    setTimeout(() => {
      const current = timedtextUrlWaiters.get(videoId)
      const index = current?.indexOf(waiter) ?? -1
      if (current !== undefined && index !== -1) {
        current.splice(index, 1)
        resolve(timedtextUrlCache.get(videoId) ?? null)
      }
    }, timeoutMs)
  })
}

function setupTimedtextObserver(): void {
  const originalFetch = window.fetch
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args)
    if (response.url.includes("/api/timedtext")) {
      cacheTimedtextUrl(response.url)
      void response.clone().text().then(body => cacheBody(response.url, body)).catch(() => {})
    }
    return response
  }
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { _lingoTrUrl?: string }, ...args: unknown[]) {
    const url = args[1]
    this._lingoTrUrl = typeof url === "string" ? url : String(url)
    return (originalOpen as (...a: unknown[]) => unknown).apply(this, args) as void
  } as typeof XMLHttpRequest.prototype.open

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { _lingoTrUrl?: string }, ...args: unknown[]) {
    this.addEventListener("load", function (this: XMLHttpRequest & { _lingoTrUrl?: string }) {
      const url = this.responseURL !== "" ? this.responseURL : (this._lingoTrUrl ?? "")
      cacheTimedtextUrl(url)
      if (url.includes("/api/timedtext")) { try { cacheBody(url, this.responseType === "json" ? JSON.stringify(this.response) : this.responseText) } catch { /* Binary responses are not subtitle JSON. */ } }
    })
    return (originalSend as (...a: unknown[]) => unknown).apply(this, args) as void
  } as typeof XMLHttpRequest.prototype.send
}

// --- player data -------------------------------------------------------------

function findYoutubePlayer(): YoutubePlayerElement | null {
  return (
    document.querySelector<YoutubePlayerElement>(".html5-video-player.playing-mode, .html5-video-player.paused-mode") ??
    document.querySelector<YoutubePlayerElement>(".html5-video-player")
  )
}

function normalizeCaptionTracks(raw: unknown): BridgeCaptionTrack[] {
  if (!Array.isArray(raw)) return []
  const tracks: BridgeCaptionTrack[] = []
  for (const entry of raw) {
    const track = entry as Record<string, unknown> | null
    if (track === null || typeof track !== "object") continue
    if (typeof track.baseUrl !== "string" || typeof track.languageCode !== "string" || typeof track.vssId !== "string") continue
    tracks.push({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      ...(typeof track.kind === "string" ? { kind: track.kind } : {}),
      vssId: track.vssId,
      hasName: track.name !== undefined && track.name !== null,
    })
  }
  return tracks
}

function normalizeAudioTracks(raw: unknown): BridgeAudioCaptionTrack[] {
  if (!Array.isArray(raw)) return []
  const tracks: BridgeAudioCaptionTrack[] = []
  for (const entry of raw) {
    const track = entry as Record<string, unknown> | null
    if (track === null || typeof track !== "object") continue
    const url = typeof track.url === "string" ? track.url : typeof track.baseUrl === "string" ? track.baseUrl : null
    if (url === null) continue
    tracks.push({
      url,
      vssId: typeof track.vssId === "string" ? track.vssId : null,
      kind: typeof track.kind === "string" ? track.kind : null,
      languageCode: typeof track.languageCode === "string" ? track.languageCode : null,
    })
  }
  return tracks
}

type SelectedTrackSnapshot = { languageCode: string | null; vssId: string | null }

function getSelectedTrackSnapshot(player: YoutubePlayerElement): SelectedTrackSnapshot {
  const selected = player.getOption?.("captions", "track") as Record<string, unknown> | null | undefined
  const languageCode = typeof selected?.languageCode === "string" ? selected.languageCode : null
  let vssId = typeof selected?.vssId === "string" && selected.vssId.length > 0 ? selected.vssId : null
  if (vssId === null && typeof selected?.baseUrl === "string" && selected.baseUrl.length > 0) {
    try {
      vssId = new URL(selected.baseUrl, window.location.origin).searchParams.get("vssId")
    } catch {
      vssId = null
    }
  }
  return { languageCode, vssId }
}

function getPlayerData(request: PlayerDataRequest): PlayerDataResponse {
  const { requestId, expectedVideoId } = request
  try {
    const player = findYoutubePlayer()
    if (player === null) return { type: PLAYER_DATA_RESPONSE_TYPE, requestId, success: false, error: "PLAYER_NOT_FOUND" }

    const playerResponse = player.getPlayerResponse?.() as Record<string, unknown> | undefined
    const videoDetails = playerResponse?.videoDetails as Record<string, unknown> | undefined
    const videoId = typeof videoDetails?.videoId === "string" ? videoDetails.videoId : null
    const captions = playerResponse?.captions as Record<string, unknown> | undefined
    const renderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined
    const captionTracks = normalizeCaptionTracks(renderer?.captionTracks)
    const audioTrack = player.getAudioTrack?.() as Record<string, unknown> | undefined
    const selected = getSelectedTrackSnapshot(player)

    if (videoId === null || videoId !== expectedVideoId) {
      return { type: PLAYER_DATA_RESPONSE_TYPE, requestId, success: false, error: "VIDEO_ID_MISMATCH" }
    }

    const contextConfig = player.getWebPlayerContextConfig?.() as Record<string, unknown> | undefined
    const ytcfg = (window as unknown as { ytcfg?: { get?: (key: string) => unknown } }).ytcfg

    return {
      type: PLAYER_DATA_RESPONSE_TYPE,
      requestId,
      success: true,
      data: {
        videoId,
        captionTracks,
        audioCaptionTracks: normalizeAudioTracks(audioTrack?.captionTracks),
        device: typeof ytcfg?.get?.("DEVICE") === "string" ? (ytcfg.get("DEVICE") as string) : null,
        cver:
          typeof contextConfig?.innertubeContextClientVersion === "string"
            ? contextConfig.innertubeContextClientVersion
            : null,
        playerState: player.getPlayerState?.() ?? -1,
        selectedTrackLanguageCode: selected.languageCode,
        selectedTrackVssId: selected.vssId,
        cachedTimedtextUrl: timedtextUrlCache.get(videoId) ?? null,
        cachedTimedtextBody: timedtextBodies.get(videoId)?.body,
        cachedTimedtextBodyLanguage: timedtextBodies.get(videoId)?.language,
      },
    }
  } catch (error) {
    return { type: PLAYER_DATA_RESPONSE_TYPE, requestId, success: false, error: String(error) }
  }
}

/** Turn YouTube's own captions on if they're off — forces the page to issue a signed timedtext request we can capture. */
function ensureSubtitlesEnabled(): void {
  const button = document.querySelector(".ytp-subtitles-button")
  if (button === null || button.getAttribute("aria-pressed") === "true") return
  const player = findYoutubePlayer()
  if (player?.toggleSubtitles !== undefined) {
    player.toggleSubtitles()
  } else if (button instanceof HTMLElement) {
    button.click()
  }
}

// --- wiring ------------------------------------------------------------------

function handleMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin || event.source !== window) return
  const data = event.data as { type?: unknown; requestId?: unknown; videoId?: unknown } | null
  if (data === null || typeof data !== "object" || typeof data.requestId !== "string") return

  if (data.type === PLAYER_DATA_REQUEST_TYPE) {
    window.postMessage(getPlayerData(event.data as PlayerDataRequest), window.location.origin)
    return
  }

  if (data.type === WAIT_TIMEDTEXT_REQUEST_TYPE && typeof data.videoId === "string") {
    const { requestId, videoId } = data as { requestId: string; videoId: string }
    void waitForTimedtextUrl(videoId, TIMEDTEXT_WAIT_TIMEOUT_MS).then((url) => {
      window.postMessage({ type: WAIT_TIMEDTEXT_RESPONSE_TYPE, requestId, url }, window.location.origin)
    })
    return
  }

  if (data.type === ENSURE_SUBTITLES_REQUEST_TYPE) {
    ensureSubtitlesEnabled()
    window.postMessage({ type: ENSURE_SUBTITLES_RESPONSE_TYPE, requestId: data.requestId }, window.location.origin)
  }
}

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    const flagged = window as unknown as Record<string, unknown>
    if (flagged[INJECTED_FLAG] === true) return
    flagged[INJECTED_FLAG] = true
    setupTimedtextObserver()
    window.addEventListener("message", handleMessage)
  },
})

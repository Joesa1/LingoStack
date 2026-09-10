/**
 * Caption acquisition for one YouTube watch page: pick the best track from
 * the player snapshot, build the signed `timedtext?fmt=json3` URL, fetch
 * with bounded retries, and parse into sentence-ready cues.
 *
 * Fast path: one player-data round trip + one fetch. Fallback (pot missing /
 * fetch failed): wait for playback state, force YouTube's own captions on so
 * the page issues a signed timedtext request the MAIN-world observer can
 * capture, then retry with that URL's pot.
 *
 * Errors are thrown as `SubtitleFetchError` with a human-readable message —
 * the controller renders them on the overlay status pill (§7.9 error model:
 * acquisition failures never become per-cue errors).
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */
import type { BridgeCaptionTrack, BridgePlayerData } from "./bridge-messages"
import type { PlayerBridge } from "./player-bridge"
import type { SubtitleCue } from "./types"

import type { TimedTextEvent } from "./json3-parser"

import { parseEventsToCues, parseTimedTextResponse } from "./json3-parser"

export const MAX_FETCH_RETRIES = 2
export const FETCH_RETRY_DELAY_MS = 1_000
export const MAX_STATE_WAIT_ATTEMPTS = 20
export const STATE_WAIT_INTERVAL_MS = 300
export const MAX_POT_WAIT_ATTEMPTS = 30
export const POT_WAIT_INTERVAL_MS = 200

/** Acquisition failure surfaced on the overlay pill (never per-cue). */
export class SubtitleFetchError extends Error {}

const FIXED_TIMEDTEXT_PARAMS = {
  fmt: "json3",
  xorb: "2",
  xobt: "3",
  xovt: "3",
  c: "WEB",
  cplayer: "UNIPLAYER",
} as const

const DEVICE_PARAM_KEYS = ["cbrand", "cbr", "cbrver", "cos", "cosver", "cplatform"] as const

export type PotToken = { pot: string | null; potc: string | null }

/**
 * Best track selection: the user's selected track, then unnamed human subs
 * (creator originals), then any human track, then ASR, then whatever is
 * first.
 */
export function selectTrack(playerData: BridgePlayerData): BridgeCaptionTrack | undefined {
  const { captionTracks: tracks, selectedTrackLanguageCode, selectedTrackVssId } = playerData
  if (tracks.length === 0) return undefined

  if (selectedTrackVssId !== null) {
    const byVss = tracks.find((t) => t.vssId === selectedTrackVssId)
    if (byVss !== undefined) return byVss
  }
  if (selectedTrackLanguageCode !== null) {
    const byLang = tracks.find((t) => t.languageCode === selectedTrackLanguageCode)
    if (byLang !== undefined) return byLang
  }
  return (
    tracks.find((t) => t.kind !== "asr" && !t.hasName) ??
    tracks.find((t) => t.kind !== "asr") ??
    tracks.find((t) => t.kind === "asr") ??
    tracks[0]
  )
}

/** pot/potc from the matching audio caption track's URL, else the captured timedtext URL, else nulls. */
export function extractPotToken(track: BridgeCaptionTrack, playerData: BridgePlayerData): PotToken {
  const { audioCaptionTracks, cachedTimedtextUrl } = playerData

  const matched =
    audioCaptionTracks.find((t) => t.vssId === track.vssId) ??
    audioCaptionTracks.find((t) => t.languageCode === track.languageCode && t.kind === (track.kind ?? null)) ??
    audioCaptionTracks.find((t) => t.languageCode === track.languageCode) ??
    audioCaptionTracks[0]

  for (const source of [matched?.url, cachedTimedtextUrl ?? undefined]) {
    if (source === undefined) continue
    try {
      const url = new URL(source)
      const pot = url.searchParams.get("pot")
      if (pot !== null) return { pot, potc: url.searchParams.get("potc") }
    } catch {
      // unparseable source URL — try the next pot source
    }
  }
  return { pot: null, potc: null }
}

export function buildSubtitleUrl(track: BridgeCaptionTrack, playerData: BridgePlayerData, potToken: PotToken): string {
  const url = new URL(track.baseUrl)
  if (url.protocol !== "https:" || !(url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) || url.pathname !== "/api/timedtext") throw new SubtitleFetchError("字幕地址无效，请刷新 YouTube 视频。")

  for (const [key, value] of Object.entries(FIXED_TIMEDTEXT_PARAMS)) url.searchParams.set(key, value)

  if (playerData.device !== null) {
    const deviceParams = new URLSearchParams(playerData.device)
    for (const key of DEVICE_PARAM_KEYS) {
      const value = deviceParams.get(key)
      if (value !== null) url.searchParams.set(key, value)
    }
  }
  if (playerData.cver !== null) url.searchParams.set("cver", playerData.cver)
  if (potToken.pot !== null) url.searchParams.set("pot", potToken.pot)
  if (potToken.potc !== null) url.searchParams.set("potc", potToken.potc)

  return url.toString()
}

export type FetchedSubtitles = {
  cues: SubtitleCue[]
  /** The fetched track's language code (BCP-47-ish, e.g. "en", "zh-Hans"). */
  sourceLanguage: string
}

export type YoutubeFetcherDeps = {
  bridge: PlayerBridge
  fetchFn: typeof fetch
  sleep: (ms: number) => Promise<void>
}

function hasPotInAudioTracks(playerData: BridgePlayerData): boolean {
  return playerData.audioCaptionTracks.some((t) => {
    try {
      return new URL(t.url).searchParams.has("pot")
    } catch {
      return false
    }
  })
}

async function fetchEventsWithRetry(deps: YoutubeFetcherDeps, url: string): Promise<TimedTextEvent[]> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
    try {
      const response = await deps.fetchFn(url)
      if (!response.ok) {
        // 403/404/429 are permanent for this URL — retrying the same signature can't succeed.
        if (response.status === 403 || response.status === 404 || response.status === 429) {
          throw new SubtitleFetchError(`Subtitle request failed with HTTP ${response.status}.`)
        }
        throw new Error(`Subtitle request failed with HTTP ${response.status}.`)
      }
      return parseTimedTextResponse(await response.json())
    } catch (error) {
      if (error instanceof SubtitleFetchError) throw error
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < MAX_FETCH_RETRIES - 1) await deps.sleep(FETCH_RETRY_DELAY_MS)
    }
  }
  throw new SubtitleFetchError(lastError?.message ?? "Subtitle request kept failing.")
}

async function fetchTrackCues(
  deps: YoutubeFetcherDeps,
  track: BridgeCaptionTrack,
  playerData: BridgePlayerData,
): Promise<SubtitleCue[]> {
  const potToken = extractPotToken(track, playerData)
  const url = buildSubtitleUrl(track, playerData, potToken)
  const events = await fetchEventsWithRetry(deps, url)
  const cues = parseEventsToCues(events, track.languageCode)
  if (!cues.length) throw new SubtitleFetchError("字幕请求返回了空内容。")
  return cues
}

async function getPlayerDataWithPot(deps: YoutubeFetcherDeps, videoId: string): Promise<BridgePlayerData> {
  // Wait for the player to have media loaded (state >= 1) before the slower pot flow.
  for (let i = 0; i < MAX_STATE_WAIT_ATTEMPTS; i++) {
    const data = await deps.bridge.getPlayerData(videoId)
    if (data !== undefined && data.playerState >= 1) break
    await deps.sleep(STATE_WAIT_INTERVAL_MS)
  }

  let playerData = await deps.bridge.getPlayerData(videoId)
  if (playerData === undefined) throw new SubtitleFetchError("无法读取 YouTube 播放器，请刷新视频页面。")
  if (playerData.cachedTimedtextBody) return playerData
  if (playerData.captionTracks.length === 0) return playerData

  // Force YouTube's own captions on so the page issues a signed timedtext
  // request, then poll for the pot to show up.
  await deps.bridge.ensureSubtitlesEnabled()
  for (let i = 0; i < MAX_POT_WAIT_ATTEMPTS; i++) {
    await deps.sleep(POT_WAIT_INTERVAL_MS)
    const polled = await deps.bridge.getPlayerData(videoId)
    if (polled !== undefined) {
      playerData = polled
      if (playerData.cachedTimedtextBody) return playerData
    }
  }

  const timedtextUrl = await deps.bridge.waitTimedtextUrl(videoId)
  if (timedtextUrl !== undefined) return { ...playerData, cachedTimedtextUrl: timedtextUrl }
  return playerData
}

/**
 * Fetch and parse the current video's captions. Throws `SubtitleFetchError`
 * when the video has no caption tracks or every acquisition path failed.
 */
export async function fetchYoutubeSubtitles(deps: YoutubeFetcherDeps, videoId: string): Promise<FetchedSubtitles> {
  // Fast path: current snapshot, whatever pot it carries.
  const fastData = await deps.bridge.getPlayerData(videoId)
  function captured(data: BridgePlayerData | undefined): FetchedSubtitles | undefined {
    if (!data?.cachedTimedtextBody) return
    try {
      const lang = data.cachedTimedtextBodyLanguage ?? "en"
      const parsed = parseEventsToCues(parseTimedTextResponse(JSON.parse(data.cachedTimedtextBody)), lang)
      if (parsed.length) return { cues: parsed, sourceLanguage: lang }
    } catch { /* Continue with signed URL acquisition. */ }
  }
  const alreadyCaptured = captured(fastData)
  if (alreadyCaptured) return alreadyCaptured
  let track = fastData !== undefined ? selectTrack(fastData) : undefined
  let cues: SubtitleCue[] | undefined

  if (fastData !== undefined && track !== undefined) {
    try {
      cues = await fetchTrackCues(deps, track, fastData)
    } catch {
      cues = undefined // fall through to the pot fallback path
    }
  }

  if (cues === undefined) {
    const potData = await getPlayerDataWithPot(deps, videoId)
    const cached = captured(potData)
    if (cached) return cached
    const fallbackTrack = selectTrack(potData) ?? track
    if (fallbackTrack === undefined) throw new SubtitleFetchError("此视频没有可用字幕。请先打开 YouTube 的 CC 字幕；没有字幕的视频暂不支持。")
    track = fallbackTrack
    cues = await fetchTrackCues(deps, fallbackTrack, potData)
  }

  if (track === undefined) throw new SubtitleFetchError("此视频没有可用字幕。请先打开 YouTube 的 CC 字幕；没有字幕的视频暂不支持。")
  if (cues.length === 0) throw new SubtitleFetchError("此视频没有可用字幕。请先打开 YouTube 的 CC 字幕；没有字幕的视频暂不支持。")

  return { cues, sourceLanguage: track.languageCode }
}

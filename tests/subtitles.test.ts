import { describe, expect, it, vi } from "vitest"
import { fetchYoutubeSubtitles } from "../src/subtitles/youtube-fetcher"
import { parseEventsToCues, parseTimedTextResponse } from "../src/subtitles/json3-parser"
import { createSubtitleSession } from "../src/subtitles/subtitle-session"
import { DEFAULT_SETTINGS } from "../src/shared/settings-store"
import type { BridgePlayerData } from "../src/subtitles/bridge-messages"
const captionBody = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: "Hello world." }] }, { tStartMs: 5000, dDurationMs: 5000, segs: [{ utf8: "Welcome to the video." }] }] })
const data: BridgePlayerData = { videoId: "video", captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=video&lang=en", languageCode: "en", vssId: ".en", hasName: false }], audioCaptionTracks: [], device: null, cver: null, playerState: 1, selectedTrackLanguageCode: "en", selectedTrackVssId: ".en", cachedTimedtextUrl: null }
describe("YouTube acquisition and rendering", () => {
  it("uses player-captured captions after a signed request returns an empty track", async () => {
    let enabled = false
    const bridge = { getPlayerData: async () => enabled ? { ...data, cachedTimedtextBody: captionBody, cachedTimedtextBodyLanguage: "en" } : data, ensureSubtitlesEnabled: async () => { enabled = true }, waitTimedtextUrl: async () => undefined }
    const result = await fetchYoutubeSubtitles({ bridge, fetchFn: vi.fn(async () => new Response('{"events":[]}')), sleep: async () => {} }, "video")
    expect(enabled).toBe(true); expect(result.cues[0]?.text).toBe("Hello world.")
  })
  it("renders translated cues, restores native captions, and drops stopped sessions", async () => {
    document.body.innerHTML = '<div id="player"><video></video></div>'
    const video = document.querySelector("video")!
    const session = createSubtitleSession({
      video, playerContainer: document.querySelector("#player")!, videoId: "video", targetLang: "zh-CN", pageTitle: "Test", settings: DEFAULT_SETTINGS, speechEnabled: false,
      bridge: { getPlayerData: async () => ({ ...data, cachedTimedtextBody: captionBody, cachedTimedtextBodyLanguage: "en" }), ensureSubtitlesEnabled: async () => {}, waitTimedtextUrl: async () => undefined },
      client: { translate: async items => items.map(i => ({ id: i.id, text: "你好，世界。" })), bumpGeneration: vi.fn(), disconnect: vi.fn() },
      fetchFn: vi.fn(), sleep: async () => {},
    })
    await session.start(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(document.querySelector("#lingo-tr-subtitles-host")?.shadowRoot?.textContent).toContain("你好，世界。")
    expect(document.querySelector("#lingo-tr-hide-native-captions")).not.toBeNull()
    session.stop()
    expect(document.querySelector("#lingo-tr-subtitles-host")).toBeNull()
    expect(document.querySelector("#lingo-tr-hide-native-captions")).toBeNull()
  })
  it("keeps source timestamps through the caption parser", () => {
    const cues = parseEventsToCues(parseTimedTextResponse(JSON.parse(captionBody)), "en")
    expect(cues.map(c => [c.start, c.end])).toEqual([[0, 5000], [5000, 10000]])
  })
})

describe("displayed-caption fallback", () => {
  it("translates stable player text and drops results after captions change", async () => {
    const { watchDisplayedCaptions } = await import("../src/subtitles/live-captions")
    vi.useFakeTimers()
    const container = document.createElement("div")
    container.innerHTML = '<span class="ytp-caption-segment">First line</span>'
    const video = document.createElement("video")
    Object.defineProperty(video, "paused", { value: false })
    const onCue = vi.fn()
    let resolve: (s: string) => void = () => {}
    const live = watchDisplayedCaptions({ container, video, onCue, onError: vi.fn(), translate: () => new Promise(r => resolve = r) })
    await vi.advanceTimersByTimeAsync(500)
    container.querySelector("span")!.textContent = "Second line"
    await vi.advanceTimersByTimeAsync(150)
    resolve("过时译文")
    await Promise.resolve()
    expect(onCue).not.toHaveBeenCalled()
    live.stop(); vi.useRealTimers()
  })
})

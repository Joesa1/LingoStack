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

it("only translates new words in rolling captions, and resets on seeking", async () => {
  const { watchDisplayedCaptions } = await import("../src/subtitles/live-captions")
  vi.useFakeTimers()
  const container = document.createElement("div")
  container.innerHTML = '<span class="ytp-caption-segment">Welcome to this video.</span>'
  const video = document.createElement("video")
  Object.defineProperty(video, "paused", { value: false })
  const translate = vi.fn(async (text: string) => `Translated: ${text}`)
  const live = watchDisplayedCaptions({ container, video, translate, onCue: vi.fn(), onError: vi.fn() })
  try {
    await vi.advanceTimersByTimeAsync(500)
    video.currentTime = 1
    container.querySelector("span")!.textContent = 'Welcome to this video. Today we discuss science.'
    await vi.advanceTimersByTimeAsync(500)
    video.currentTime = 2
    container.querySelector("span")!.textContent = 'Today we discuss science. Let us begin.'
    await vi.advanceTimersByTimeAsync(500)
    expect(translate.mock.calls.map(call => call[0])).toEqual(['Welcome to this video.', 'Today we discuss science.', 'Let us begin.'])
    video.currentTime = 0
    video.dispatchEvent(new Event("seeking"))
    container.querySelector("span")!.textContent = 'Welcome to this video.'
    await vi.advanceTimersByTimeAsync(500)
    expect(translate.mock.calls.at(-1)?.[0]).toBe('Welcome to this video.')
    expect(translate).toHaveBeenCalledTimes(4)
  } finally { live.stop(); vi.useRealTimers() }
})

it("shows one line for a whitespace-only echo and opts the overlay out of page translation", async () => {
  const { mountSubtitleOverlay } = await import("../src/subtitles/overlay")
  const player = document.createElement("div")
  document.body.append(player)
  const overlay = mountSubtitleOverlay(player)
  try {
    overlay.setCue({ start: 0, end: 1000, text: 'Hello world', translation: ' Hello\nworld\u200b ' })
    const host = player.querySelector<HTMLElement>('#lingo-tr-subtitles-host')!
    expect(host.getAttribute('translate')).toBe('no')
    expect(host.classList.contains('notranslate')).toBe(true)
    expect([...host.shadowRoot!.querySelectorAll<HTMLElement>('.line')].filter(el => !el.hidden)).toHaveLength(1)
  } finally { overlay.destroy(); player.remove() }
})

it("accepts still-visible words during a slow request without retranslating its prefix", async () => {
  const { watchDisplayedCaptions } = await import("../src/subtitles/live-captions")
  vi.useFakeTimers()
  const container = document.createElement("div")
  container.innerHTML = '<span class="ytp-caption-segment">Welcome everyone.</span>'
  const video = document.createElement("video")
  Object.defineProperty(video, "paused", { value: false })
  let resolve = (_: string) => {}
  const translate = vi.fn(() => new Promise<string>(r => { resolve = r }))
  const onCue = vi.fn()
  const live = watchDisplayedCaptions({ container, video, translate, onCue, onError: vi.fn() })
  try {
    await vi.advanceTimersByTimeAsync(500)
    container.querySelector('span')!.textContent = 'Welcome everyone. Let us begin.'
    await vi.advanceTimersByTimeAsync(500)
    expect(translate).toHaveBeenCalledTimes(1)
    resolve('欢迎大家。')
    await vi.advanceTimersByTimeAsync(150)
    expect(onCue.mock.calls[0]?.[0].text).toBe('Welcome everyone.')
    expect(translate).toHaveBeenLastCalledWith('Let us begin.')
  } finally { live.stop(); resolve('done'); vi.useRealTimers() }
})

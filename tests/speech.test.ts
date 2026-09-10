import { afterEach, describe, expect, it, vi } from "vitest"
import { createSpeechReader } from "../src/subtitles/speech-reader"
import { DEFAULT_SETTINGS } from "../src/shared/settings-store"
function setup() {
  let listener: (m: any) => void = () => {}
  const messages: any[] = []
  const port = { postMessage: (m: any) => messages.push(m), disconnect: vi.fn(), onMessage: { addListener: (cb: any) => listener = cb }, onDisconnect: { addListener: vi.fn() } }
  vi.stubGlobal("chrome", { runtime: { connect: () => port } })
  const video = document.createElement("video")
  let paused = false
  Object.defineProperty(video, "paused", { get: () => paused })
  video.pause = vi.fn(() => { paused = true; video.dispatchEvent(new Event("pause")) })
  video.play = vi.fn(async () => { paused = false; video.dispatchEvent(new Event("play")) })
  const errors: string[] = []
  const reader = createSpeechReader(video, DEFAULT_SETTINGS, e => errors.push(e))
  return { reader, video, messages, errors, emit: (m: any) => listener(m) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe("subtitle speech playback", () => {
  it("speaks once, waits for a long line, then resumes and restores original audio", () => {
    const s = setup(); const cue = { start: 0, end: 4000, text: "Hello", translation: "你好" }
    s.reader.update(cue); s.reader.update(cue)
    const speaks = s.messages.filter(m => m.type === "speak")
    expect(speaks).toHaveLength(1)
    s.emit({ type: "start", id: speaks[0].id }); expect(s.video.muted).toBe(true)
    s.video.currentTime = 3.95; s.video.dispatchEvent(new Event("timeupdate"))
    expect(s.video.pause).toHaveBeenCalledOnce()
    expect(s.messages.filter(m => m.type === "pause")).toHaveLength(0)
    s.emit({ type: "end", id: speaks[0].id })
    expect(s.video.play).toHaveBeenCalledOnce(); expect(s.video.muted).toBe(false)
    s.reader.destroy()
  })
  it("clears old speech on seek and ignores stale completion", () => {
    const s = setup(); s.reader.update({ start: 0, end: 4000, text: "Hello", translation: "你好" })
    const old = s.messages.find(m => m.type === "speak")
    s.video.dispatchEvent(new Event("seeking"))
    s.emit({ type: "end", id: old.id })
    expect(s.video.play).not.toHaveBeenCalled()
    s.reader.update({ start: 8000, end: 12000, text: "World", translation: "世界" })
    expect(s.messages.filter(m => m.type === "speak")).toHaveLength(2)
    s.reader.destroy()
  })
  it("user pause pauses speech; missing voice never leaves video muted", () => {
    const s = setup(); s.reader.update({ start: 0, end: 4000, text: "Hello", translation: "你好" })
    const id = s.messages.find(m => m.type === "speak").id
    s.video.pause(); expect(s.messages.at(-1).type).toBe("pause")
    s.emit({ type: "error", id, error: "No local voice" })
    expect(s.errors).toEqual(["No local voice"]); expect(s.video.muted).toBe(false)
    s.reader.destroy()
  })
})

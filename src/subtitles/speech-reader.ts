import type { SubtitleCue } from "./types"
import { normalizeText } from "../shared/text-normalize"
import type { WebTranslateSettings } from "../shared/settings-store"

export function createSpeechReader(video: HTMLVideoElement, settings: WebTranslateSettings, onError: (message: string) => void) {
  const port = chrome.runtime.connect({ name: "lingo-speech" })
  const originalMuted = video.muted
  let active: SubtitleCue | undefined
  let speakingId: string | undefined
  let spokenCue: SubtitleCue | undefined
  let holding = false
  let ownPause = false
  let disposed = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let mutedByUs = false
  const queue: SubtitleCue[] = []
  function mute() { if (settings.muteOriginal) { video.muted = true; mutedByUs = true } }
  function restoreMute() { if (mutedByUs) { video.muted = originalMuted; mutedByUs = false } }
  function send(message: unknown) { if (!disposed) { try { port.postMessage(message) } catch { fail("朗读连接已断开，请重新开启译文朗读。") } } }
  function resumeVideo() {
    if (!holding) return
    holding = false
    if (!video.ended && !disposed) void video.play().catch(() => onError("请点击视频继续播放。"))
  }
  function fail(message: string) { speakingId = undefined; clearTimeout(watchdog); restoreMute(); resumeVideo(); onError(message) }
  function stop(clearQueue = true) { send({ type: "stop" }); speakingId = undefined; clearTimeout(watchdog); restoreMute(); if (clearQueue) queue.length = 0 }
  function speak(cue: SubtitleCue) {
    spokenCue = cue
    speakingId = `${cue.start}:${Date.now()}`
    const windowSeconds = Math.max(0.8, (cue.end - cue.start) / 1000)
    const words = cue.translation!.trim().split(/\s+/).filter(Boolean).length
    const chars = cue.translation!.replace(/\s/g, "").length
    const estimatedSeconds = words > 1 ? words * 0.34 : chars * 0.22
    const adaptive = settings.speechMode === "natural" ? Math.min(1.35, Math.max(0.75, estimatedSeconds / windowSeconds)) : 1
    send({ type: "speak", id: speakingId, text: cue.translation, playbackRate: video.playbackRate * adaptive })
    watchdog = setTimeout(() => { stop(); fail("朗读等待超时，请重新播放或更换声音。") }, 90_000)
  }
  function update(cue: SubtitleCue | undefined) {
    active = cue
    if (disposed || video.paused || video.seeking || !cue?.translation || spokenCue?.start === cue.start) return
    // Overlapping duplicate cues must not restart an utterance. A real later
    // occurrence or an explicit seek remains eligible to be read again.
    if (spokenCue && cue.start < spokenCue.end && normalizeText(cue.text) === normalizeText(spokenCue.text)
      && normalizeText(cue.translation) === normalizeText(spokenCue.translation ?? "")) return
    if (settings.speechMode === "natural" && speakingId) {
      if (!queue.some(item => item.start === cue.start)) queue.push(cue)
      return
    }
    stop()
    speak(cue)
  }
  function tick() {
    if (speakingId && settings.waitForSpeech && active && video.currentTime * 1000 >= active.end - 120 && !video.paused && !video.seeking) {
      holding = true; ownPause = true; video.pause()
    }
  }
  function pause() { if (ownPause) { ownPause = false; return }; if (speakingId) { clearTimeout(watchdog); send({ type: "pause" }) } }
  function play() { holding = false; if (speakingId) { send({ type: "resume" }); clearTimeout(watchdog); watchdog = setTimeout(() => { stop(); fail("朗读等待超时，请重试。") }, 90_000) }; update(active) }
  function seek() { holding = false; ownPause = false; stop(); spokenCue = undefined; active = undefined }
  function end() { holding = false; stop(); restoreMute() }
  function rateChange() { stop(); spokenCue = undefined; update(active) }
  port.onMessage.addListener(m => {
    if (disposed) return
    if (m.type === "interrupted" && !m.id) { fail("另一个视频正在朗读。重新开启此视频的朗读即可切回。"); return }
    if (m.id !== speakingId) return
    if (m.type === "start") mute()
    if (["end", "error", "interrupted", "cancelled"].includes(m.type)) {
      speakingId = undefined; clearTimeout(watchdog)
      if (m.type === "error") fail(m.error || "译文朗读失败。")
      else if (settings.speechMode === "natural" && queue.length > 0) speak(queue.shift()!)
      else { restoreMute(); resumeVideo() }
    }
  })
  port.onDisconnect.addListener(() => { if (!disposed) fail("朗读连接已断开，请重新开启译文朗读。") })
  video.addEventListener("timeupdate", tick)
  video.addEventListener("pause", pause)
  video.addEventListener("play", play)
  video.addEventListener("seeking", seek)
  video.addEventListener("ended", end)
  video.addEventListener("ratechange", rateChange)
  return {
    update,
    destroy() {
      if (disposed) return
      stop(); resumeVideo(); disposed = true; port.disconnect(); restoreMute()
      video.removeEventListener("timeupdate", tick); video.removeEventListener("pause", pause)
      video.removeEventListener("play", play); video.removeEventListener("seeking", seek)
      video.removeEventListener("ended", end); video.removeEventListener("ratechange", rateChange)
    },
  }
}

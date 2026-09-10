import type { SubtitleCue } from "./types"
import type { WebTranslateSettings } from "../shared/settings-store"

export function createSpeechReader(video: HTMLVideoElement, settings: WebTranslateSettings, onError: (message: string) => void) {
  const port = chrome.runtime.connect({ name: "lingo-speech" })
  const originalMuted = video.muted
  let active: SubtitleCue | undefined
  let speakingId: string | undefined
  let spokenStart: number | undefined
  let holding = false
  let ownPause = false
  let disposed = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let mutedByUs = false
  function mute() { if (settings.muteOriginal) { video.muted = true; mutedByUs = true } }
  function restoreMute() { if (mutedByUs) { video.muted = originalMuted; mutedByUs = false } }
  function send(message: unknown) { if (!disposed) { try { port.postMessage(message) } catch { fail("朗读连接已断开，请重新开启系统朗读。") } } }
  function resumeVideo() {
    if (!holding) return
    holding = false
    if (!video.ended && !disposed) void video.play().catch(() => onError("请点击视频继续播放。"))
  }
  function fail(message: string) { speakingId = undefined; clearTimeout(watchdog); restoreMute(); resumeVideo(); onError(message) }
  function stop() { send({ type: "stop" }); speakingId = undefined; clearTimeout(watchdog); restoreMute() }
  function update(cue: SubtitleCue | undefined) {
    active = cue
    if (disposed || video.paused || video.seeking || !cue?.translation || spokenStart === cue.start) return
    // One utterance at a time. With continuous playback, replace overdue speech rather than accumulate a queue.
    stop()
    spokenStart = cue.start
    speakingId = `${cue.start}:${Date.now()}`
    send({ type: "speak", id: speakingId, text: cue.translation, playbackRate: video.playbackRate })
    watchdog = setTimeout(() => { stop(); fail("朗读等待超时，请重新播放或更换声音。") }, 90_000)
  }
  function tick() {
    if (speakingId && settings.waitForSpeech && active && video.currentTime * 1000 >= active.end - 120 && !video.paused && !video.seeking) {
      holding = true; ownPause = true; video.pause()
    }
  }
  function pause() { if (ownPause) { ownPause = false; return }; if (speakingId) { clearTimeout(watchdog); send({ type: "pause" }) } }
  function play() { holding = false; if (speakingId) { send({ type: "resume" }); clearTimeout(watchdog); watchdog = setTimeout(() => { stop(); fail("朗读等待超时，请重试。") }, 90_000) }; update(active) }
  function seek() { holding = false; ownPause = false; stop(); spokenStart = undefined; active = undefined }
  function end() { holding = false; stop(); restoreMute() }
  function rateChange() { stop(); spokenStart = undefined; update(active) }
  port.onMessage.addListener(m => {
    if (disposed) return
    if (m.type === "interrupted" && !m.id) { fail("另一个视频正在朗读。重新开启此视频的朗读即可切回。"); return }
    if (m.id !== speakingId) return
    if (m.type === "start") mute()
    if (["end", "error", "interrupted", "cancelled"].includes(m.type)) {
      speakingId = undefined; clearTimeout(watchdog)
      if (m.type === "error") fail(m.error || "系统朗读失败。")
      else { restoreMute(); resumeVideo() }
    }
  })
  port.onDisconnect.addListener(() => { if (!disposed) fail("朗读连接已断开，请重新开启系统朗读。") })
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

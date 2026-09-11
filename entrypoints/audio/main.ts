let active: { id: string; audio: HTMLAudioElement; reply: (value: unknown) => void; url: string } | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined
function clear(result: unknown) {
  clearInterval(heartbeat); heartbeat = undefined
  const previous = active
  active = undefined
  if (!previous) return
  previous.audio.onended = null; previous.audio.onerror = null; previous.audio.onplaying = null
  previous.audio.pause(); previous.audio.removeAttribute("src"); previous.audio.load()
  URL.revokeObjectURL(previous.url)
  previous.reply(result)
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.type !== "LINGO_AUDIO" || sender.id !== chrome.runtime.id || sender.tab) return
  if (m.action !== "play") {
    if (active?.id === m.id) {
      if (m.action === "stop") clear({ cancelled: true })
      if (m.action === "pause") active?.audio.pause()
      if (m.action === "resume") void active?.audio.play().catch(() => clear({ error: "音频无法继续播放，请重新开启朗读。" }))
    }
    reply({ ok: true }); return
  }
  clear({ cancelled: true })
  if (typeof m.audio !== "string" || m.audio.length > 15_000_000 || !/^data:audio\/(mpeg|wav);base64,[A-Za-z0-9+/=]+$/.test(m.audio)) { reply({ error: "音频数据格式不正确。" }); return }
  const [header, base64] = m.audio.split(",")
  const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: header.slice(5, -7) }))
  const audio = new Audio(url)
  const item = { id: m.id, audio, reply, url }; active = item
  // Keep playback ownership alive across the service worker's idle timeout, including pauses.
  heartbeat = setInterval(() => { void chrome.runtime.sendMessage({ type: "LINGO_AUDIO_EVENT", id: item.id, event: "alive" }).catch(() => {}) }, 20_000)
  audio.playbackRate = Math.min(3, Math.max(0.25, Number(m.rate) || 1))
  audio.preservesPitch = true
  audio.onended = () => { if (active === item) clear({ ended: true }) }
  audio.onerror = () => { if (active === item) clear({ error: "无法解码或播放音频，请更换音色后重试。" }) }
  audio.onplaying = () => { if (active === item) void chrome.runtime.sendMessage({ type: "LINGO_AUDIO_EVENT", id: m.id, event: "start" }).catch(() => {}) }
  if (!m.paused) void audio.play().catch(() => { if (active === item) clear({ error: "浏览器无法播放音频，请重新点击试听或开启朗读。" }) })
  return true
})

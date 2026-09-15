import { readSettings } from "../shared/settings-store"
import { defaultTts, speechChunks, TTS_KEY, validateTts, type TtsConfig } from "../shared/tts-config"
import { synthesize } from "./tts-provider"

type SpeechEvent = { type: string; error?: string }
type Job = { id: string; owner?: chrome.runtime.Port; abort: AbortController; paused: boolean; started: boolean; emit: (event: SpeechEvent) => void; resolve: () => void; reject: (error: Error) => void }
let current: Job | undefined
let creating: Promise<void> | undefined
export async function localVoices(): Promise<chrome.tts.TtsVoice[]> {
  return (await chrome.tts.getVoices()).filter(v => !v.remote && !v.extensionId && Boolean(v.voiceName))
}
export async function savedTts(): Promise<TtsConfig> {
  const stored = (await chrome.storage.local.get(TTS_KEY))[TTS_KEY]
  if (!stored || stored.active === "system") return defaultTts()
  return validateTts(stored.profiles?.[stored.active])
}
async function ensureAudio() {
  if (creating) return creating
  creating = (async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({ url: "audio.html", reasons: [chrome.offscreen.Reason.BLOBS], justification: "Play translated subtitle audio with pause, resume and cancellation." })
  })()
  try { await creating } finally { creating = undefined }
}
async function audioCommand(action: string, job: Job, extra: Record<string, unknown> = {}) {
  if (action === "play") await ensureAudio()
  if (action !== "stop" && current !== job) return { cancelled: true }
  if (!await chrome.offscreen.hasDocument()) return { cancelled: true }
  if (action !== "stop" && current !== job) return { cancelled: true }
  return chrome.runtime.sendMessage({ type: "LINGO_AUDIO", action, id: job.id, ...extra, ...(action === "play" ? { paused: job.paused } : {}) })
}
export function stopSpeech() {
  const job = current
  current = undefined
  chrome.tts.stop()
  if (!job) return
  job.abort.abort()
  job.reject(new Error("试听已停止。"))
  job.emit({ type: "interrupted" })
  void audioCommand("stop", job).catch(() => {})
}
function fail(job: Job, error: unknown) {
  if (current !== job) return
  const message = error instanceof Error && !["AbortError", "TimeoutError"].includes(error.name) ? error.message : "语音生成超时，请检查网络后重试。"
  job.reject(new Error(message))
  job.emit({ type: "error", error: message })
  current = undefined
  job.abort.abort()
  chrome.tts.stop()
  void audioCommand("stop", job).catch(() => {})
}
function started(job: Job) {
  if (current !== job || job.started) return
  job.started = true; job.resolve(); job.emit({ type: "start" })
}
function ended(job: Job) { if (current === job) { current = undefined; job.emit({ type: "end" }) } }
async function voiceFor(name: string, lang: string) {
  const voices = await localVoices()
  const prefix = lang.toLowerCase().split("-")[0]
  const selected = voices.find(v => v.voiceName === name && v.lang?.toLowerCase().split("-")[0] === prefix)
    ?? voices.find(v => v.lang?.toLowerCase() === lang.toLowerCase())
    ?? voices.find(v => v.lang?.toLowerCase().split("-")[0] === prefix)
  if (!selected?.voiceName) throw new Error("没有找到该语言的本机声音，请在系统设置中下载，或选择云端朗读服务。")
  return selected
}
function begin(text: string, resolveConfig: () => Promise<{ config: TtsConfig; voiceName: string; lang: string; rate: number }>, emit: Job["emit"], owner?: chrome.runtime.Port): Promise<void> {
  stopSpeech()
  let resolve!: () => void; let reject!: (error: Error) => void
  const start = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const job: Job = { id: crypto.randomUUID(), owner, abort: new AbortController(), paused: false, started: false, emit, resolve, reject }
  current = job
  void (async () => {
    const { config, voiceName, lang, rate } = await resolveConfig()
    if (current !== job) return
    if (config.provider === "system") {
      const voice = await voiceFor(voiceName, lang)
      if (current !== job) return
      chrome.tts.speak(text, { voiceName: voice.voiceName, lang: voice.lang, rate, enqueue: false, onEvent: e => {
        if (current !== job) return
        if (e.type === "start") { started(job); if (job.paused) chrome.tts.pause() }
        else if (e.type === "end") ended(job)
        else if (["error", "cancelled", "interrupted"].includes(e.type)) fail(job, new Error("系统朗读中断或失败，请重试或更换声音。"))
      } }, () => { if (chrome.runtime.lastError) fail(job, new Error("无法启动系统朗读，请检查所选声音。")) })
      return
    }
    for (const chunk of speechChunks(text)) {
      const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(40_000)])
      const audio = await synthesize(config, chunk, lang, signal)
      if (current !== job) return
      await ensureAudio()
      if (current !== job) return
      const result = await audioCommand("play", job, { audio, rate, paused: job.paused })
      if (current !== job) return
      if (!result?.ended) throw new Error(result?.error || "云端音频播放中断，请重试。")
    }
    ended(job)
  })().catch(error => fail(job, error))
  return start
}
export async function previewSpeech(name: string, lang: string, rate: number, raw?: unknown) {
  const config = raw === undefined ? await savedTts() : validateTts(raw)
  const samples: Record<string, string> = { zh: "你好，我是译栈。现在可以一边看视频，一边听中文翻译。", en: "Hello. Listen to translated subtitles while watching your video.", ja: "こんにちは。翻訳した字幕を読み上げます。", ko: "안녕하세요. 번역된 자막을 읽어 드립니다.", fr: "Bonjour. Écoutez la traduction des sous-titres.", de: "Hallo. Hören Sie die übersetzten Untertitel.", es: "Hola. Escucha los subtítulos traducidos.", ru: "Здравствуйте. Слушайте перевод субтитров.", ar: "مرحباً. استمع إلى ترجمة النص.", pt: "Olá. Ouça as legendas traduzidas.", it: "Ciao. Ascolta i sottotitoli tradotti." }
  return begin(samples[lang.split("-")[0]!] ?? samples.en!, async () => ({ config, voiceName: name, lang, rate: Math.min(2, Math.max(0.5, Number(rate) || 1)) }), () => {})
}
export function registerSpeech(isEnabled: (tabId: number) => Promise<boolean>) {
  chrome.runtime.onMessage.addListener((m, sender) => {
    if (m?.type !== "LINGO_AUDIO_EVENT" || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("audio.html")) return
    if (current && current.id === m.id && m.event === "start") started(current)
  })
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== "lingo-speech" || port.sender?.tab?.id === undefined || port.sender.frameId !== 0) return
    const tabId = port.sender.tab.id
    let disconnected = false
    const post = (data: unknown) => { if (!disconnected) { try { port.postMessage(data) } catch { /* Port teardown won the race. */ } } }
    port.onDisconnect.addListener(() => { disconnected = true; if (current?.owner === port) stopSpeech() })
    port.onMessage.addListener(m => {
      const job = current?.owner === port ? current : undefined
      if (m?.type === "stop") { if (job) stopSpeech(); return }
      if (m?.type === "pause" || m?.type === "resume") {
        if (job) {
          job.paused = m.type === "pause"
          if (job.paused) chrome.tts.pause(); else chrome.tts.resume()
          void audioCommand(m.type, job).catch(e => fail(job, e))
        }
        return
      }
      if (m?.type !== "speak" || typeof m.text !== "string" || !m.text.trim() || m.text.length > 10_000 || typeof m.id !== "string" || m.id.length > 200) return
      void begin(m.text, async () => {
        if (!await isEnabled(tabId)) throw new Error("请先在当前视频中开启译文朗读。")
        const settings = await readSettings(chrome.storage.local)
        return { config: await savedTts(), voiceName: settings.voiceName, lang: settings.targetLang, rate: Math.min(3, settings.speechRate * Math.min(2, Math.max(0.25, Number(m.playbackRate) || 1))) }
      }, e => post({ ...e, id: m.id }), port).catch(() => { /* Errors also travel through the playback event channel. */ })
    })
  })
}

import { readSettings } from "../shared/settings-store"

let owner: chrome.runtime.Port | undefined
let token = 0
export async function localVoices(): Promise<chrome.tts.TtsVoice[]> {
  return (await chrome.tts.getVoices()).filter(v => !v.remote && !v.extensionId && Boolean(v.voiceName))
}
export function stopSpeech() {
  token++
  if (owner) { try { owner.postMessage({ type: "interrupted" }) } catch { /* Owner already disconnected. */ } }
  owner = undefined
  chrome.tts.stop()
}
async function voiceFor(name: string, lang: string) {
  const voices = await localVoices()
  const prefix = lang.toLowerCase().split("-")[0]
  const selected = voices.find(v => v.voiceName === name && v.lang?.toLowerCase().split("-")[0] === prefix)
    ?? voices.find(v => v.lang?.toLowerCase() === lang.toLowerCase())
    ?? voices.find(v => v.lang?.toLowerCase().split("-")[0] === prefix)
  if (!selected?.voiceName) throw new Error("没有找到该语言的本机声音，请在 macOS 系统设置中下载对应语言的朗读声音。")
  return selected
}
export async function previewSpeech(name: string, lang: string, rate: number) {
  stopSpeech()
  const expected = token
  const voice = await voiceFor(typeof name === "string" ? name : "", typeof lang === "string" ? lang : "zh-CN")
  if (expected !== token) return
  const samples: Record<string, string> = { zh: "你好，我是译伴。现在可以一边看视频，一边听中文翻译。", en: "Hello. Read the web and listen to translated subtitles.", ja: "こんにちは。翻訳した字幕を読み上げます。", ko: "안녕하세요. 번역된 자막을 읽어 드립니다.", fr: "Bonjour. Écoutez la traduction des sous-titres.", de: "Hallo. Hören Sie die übersetzten Untertitel.", es: "Hola. Escucha los subtítulos traducidos.", ru: "Здравствуйте. Слушайте перевод субтитров.", ar: "مرحباً. استمع إلى ترجمة النص.", pt: "Olá. Ouça as legendas traduzidas.", it: "Ciao. Ascolta i sottotitoli tradotti." }
  await chrome.tts.speak(samples[lang.split("-")[0]!] ?? samples.en!, { voiceName: voice.voiceName, lang: voice.lang, rate: Math.min(2, Math.max(0.5, Number(rate) || 1)), enqueue: false })
}
export function registerSpeech(isEnabled: (tabId: number) => Promise<boolean>) {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== "lingo-speech" || port.sender?.tab?.id === undefined || port.sender.frameId !== 0) return
    const tabId = port.sender.tab.id
    let disconnected = false
    let serial = 0
    function post(data: unknown) { if (!disconnected) { try { port.postMessage(data) } catch { /* Port teardown won the race. */ } } }
    port.onDisconnect.addListener(() => {
      disconnected = true; serial++
      if (owner === port) { owner = undefined; token++; chrome.tts.stop() }
    })
    port.onMessage.addListener(m => {
      if (m?.type === "stop") { serial++; if (owner === port) { owner = undefined; token++; chrome.tts.stop() }; return }
      if (m?.type === "pause") { if (owner === port) chrome.tts.pause(); return }
      if (m?.type === "resume") { if (owner === port) chrome.tts.resume(); return }
      if (m?.type !== "speak" || typeof m.text !== "string" || !m.text.trim() || m.text.length > 10_000 || typeof m.id !== "string") return
      const sequence = ++serial
      void (async () => {
        if (!await isEnabled(tabId)) throw new Error("请先在当前视频中开启系统朗读。")
        const settings = await readSettings(chrome.storage.local)
        const voice = await voiceFor(settings.voiceName, settings.targetLang)
        if (sequence !== serial || disconnected) return
        if (owner && owner !== port) { try { owner.postMessage({ type: "interrupted" }) } catch { /* Already closed. */ } }
        owner = port
        const current = ++token
        chrome.tts.stop()
        chrome.tts.speak(m.text, {
          voiceName: voice.voiceName, lang: voice.lang,
          rate: Math.min(3, settings.speechRate * Math.min(2, Math.max(0.25, Number(m.playbackRate) || 1))),
          enqueue: false,
          onEvent: event => {
            if (current !== token || owner !== port) return
            post({ type: event.type, id: m.id, error: event.type === "error" ? "系统朗读失败，请在设置页选择其他声音。" : undefined })
            if (["end", "error", "cancelled", "interrupted"].includes(event.type)) owner = undefined
          },
        }, () => {
          const error = chrome.runtime.lastError
          if (error && current === token) { owner = undefined; post({ type: "error", id: m.id, error: "无法启动系统朗读，请检查所选声音。" }) }
        })
      })().catch(e => { if (sequence === serial) post({ type: "error", id: m.id, error: e.message }) })
    })
  })
}

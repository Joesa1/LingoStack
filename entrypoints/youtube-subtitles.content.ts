import { TRANSLATE_PORT_NAME } from "../src/background/message-router"
import { createPlayerBridge } from "../src/subtitles/player-bridge"
import { createSubtitleSession, type SubtitleSession } from "../src/subtitles/subtitle-session"
import { createSubtitleTranslateClient } from "../src/subtitles/subtitle-translate-client"
import { DEFAULT_SETTINGS, parseSettings, SETTINGS_KEY } from "../src/shared/settings-store"

export default defineContentScript({
  matches: ["*://*.youtube.com/*"], runAt: "document_idle",
  main(ctx) {
    if (window.top !== window) return
    let enabled = false
    let speechEnabled = false
    let settings = { ...DEFAULT_SETTINGS }
    let session: SubtitleSession | undefined
    let identity = ""
    let generation = 0
    const bridge = createPlayerBridge(window)
    const client = createSubtitleTranslateClient({ connect: () => chrome.runtime.connect({ name: TRANSLATE_PORT_NAME }) })
    function stop() { generation++; session?.stop(); session = undefined; identity = "" }
    async function ensure(force = false) {
      const videoId = location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null
      if (!enabled || !videoId || ctx.isInvalid) { stop(); return }
      const key = JSON.stringify([videoId, settings.targetLang, speechEnabled, settings.voiceName, settings.speechRate, settings.muteOriginal, settings.waitForSpeech])
      if (!force && identity === key) return
      stop()
      identity = key
      const token = generation
      for (let i = 0; i < 50; i++) {
        if (token !== generation || ctx.isInvalid) return
        const playerContainer = document.querySelector<HTMLElement>("#movie_player")
        const video = playerContainer?.querySelector<HTMLVideoElement>("video.html5-main-video")
        if (playerContainer && video && !playerContainer.classList.contains("ad-showing")) {
          identity = key
          session = createSubtitleSession({ bridge, client, playerContainer, video, videoId, targetLang: settings.targetLang, pageTitle: document.title, fetchFn: (input, init) => fetch(input, init), sleep: ms => new Promise(r => setTimeout(r, ms)), settings, speechEnabled })
          await session.start()
          return
        }
        await new Promise(r => setTimeout(r, 100))
      }
    }
    chrome.runtime.sendMessage({ type: "TR_GET_SETTINGS" }).then(reply => {
      if (!reply || ctx.isInvalid) return
      settings = parseSettings(reply); enabled = reply.subtitlesEnabled; speechEnabled = reply.speechEnabled
      void ensure()
    }).catch(() => {})
    chrome.runtime.onMessage.addListener((m, _sender, reply) => {
      if (m?.type !== "LINGO_VIDEO_SETTINGS" || ctx.isInvalid) return
      enabled = m.subtitlesEnabled === true; speechEnabled = m.speechEnabled === true
      reply({ ok: true })
      void ensure(true)
    })
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session" || !changes[SETTINGS_KEY] || ctx.isInvalid) return
      settings = parseSettings(changes[SETTINGS_KEY].newValue); void ensure()
    })
    ctx.addEventListener(window, "yt-navigate-finish" as keyof WindowEventMap, () => { void ensure() })
    ctx.addEventListener(window, "pagehide", () => stop())
    ctx.addEventListener(window, "pageshow", () => { void ensure() })
    // YouTube swaps ads and media without navigation; stop speech while an ad is showing.
    const watcher = new MutationObserver(() => {
      if (ctx.isInvalid || !enabled) return
      if (document.querySelector("#movie_player.ad-showing")) stop()
      else if (!session) void ensure()
    })
    watcher.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] })
    ctx.onInvalidated(() => { watcher.disconnect(); stop(); client.disconnect() })
  },
})

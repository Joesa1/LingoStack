import { createIndexedDbCacheStore } from "../src/background/cache"
import { TranslateBatcher } from "../src/background/translate-batcher"
import { RateLimitedQueue } from "../src/background/rate-limited-queue"
import { registerTranslatePort, registerSelectionTranslateHandler } from "../src/background/message-router"
import { createPageModeController } from "../src/background/page-mode-controller"
import { ProviderError, complete, listModels, translate } from "../src/background/provider"
import { PROVIDER_KEY, EMPTY_PROVIDER, validateProvider, type ProviderConfig } from "../src/shared/provider-config"
import { readSettings, writeSettings, SETTINGS_KEY } from "../src/shared/settings-store"
import { registerSpeech, stopSpeech, previewSpeech, localVoices } from "../src/background/speech"
import * as limits from "../src/shared/translate-config"

type VideoState = { subtitlesEnabled: boolean; speechEnabled: boolean }
export default defineBackground(() => {
  const ready = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    await chrome.storage.session.set({ [SETTINGS_KEY]: await readSettings(chrome.storage.local) })
  })()
  let batcher: TranslateBatcher
  async function provider(): Promise<ProviderConfig> {
    await ready
    try { return validateProvider((await chrome.storage.local.get(PROVIDER_KEY))[PROVIDER_KEY]) }
    catch (e) { throw new ProviderError("provider_not_ready", e instanceof Error ? e.message : "请先配置模型。") }
  }
  batcher = new TranslateBatcher({
    cache: createIndexedDbCacheStore(), queue: new RateLimitedQueue(limits.MAX_INFLIGHT),
    requestTranslate: async params => translate(await provider(), params),
    promptVersion: limits.PROMPT_VERSION, now: Date.now,
    batchWindowMs: limits.BATCH_WINDOW_MS, batchMaxUnits: limits.BATCH_MAX_UNITS, batchMaxChars: limits.BATCH_MAX_CHARS,
    retryMaxRetries: limits.RETRY_MAX_RETRIES, retryBaseDelayMs: limits.RETRY_BASE_DELAY_MS,
  })
  // Scope caches to a hash of protocol, endpoint, model and credentials, never to raw secrets.
  async function refreshNamespace() {
    await ready
    const stored = await chrome.storage.local.get([PROVIDER_KEY, "configEpoch"])
    const c = [stored[PROVIDER_KEY] ?? {}, stored.configEpoch ?? "initial"]
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(c)))
    batcher.setCacheNamespace(Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join(""))
  }
  const initialized = refreshNamespace()
  registerTranslatePort(chrome.runtime, batcher)
  registerSelectionTranslateHandler(chrome.runtime, batcher)
  const page = createPageModeController({ storage: chrome.storage.local, tabs: chrome.tabs })
  async function videoState(tabId?: number): Promise<VideoState> {
    const states = (await chrome.storage.session.get("videoTabs")).videoTabs ?? {}
    return states[String(tabId)] ?? { subtitlesEnabled: false, speechEnabled: false }
  }
  registerSpeech(async tabId => (await videoState(tabId)).speechEnabled)

  async function settingsReply(tabId?: number) {
    await initialized
    const settings = await readSettings(chrome.storage.local)
    let providerReady = false
    let model
    try { const c = await provider(); providerReady = true; model = { provider: c.preset, model: c.model } } catch { /* An unconfigured installation is a normal initial state. */ }
    return { ...settings, ...await videoState(tabId), providerReady, model }
  }
  function isAdmin(sender: chrome.runtime.MessageSender) {
    return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL("")) === true
  }
  async function handle(m: any, sender: chrome.runtime.MessageSender) {
    await initialized
    if (m.type === "TR_GET_SETTINGS") return settingsReply(sender.tab?.id ?? (isAdmin(sender) ? await page.getActiveTabId() : undefined))
    if (!isAdmin(sender)) throw new Error("此操作仅允许在扩展界面中使用。")
    if (m.type === "GET_CONFIG") return (await chrome.storage.local.get(PROVIDER_KEY))[PROVIDER_KEY] ?? EMPTY_PROVIDER
    if (m.type === "SAVE_CONFIG") {
      const c = validateProvider(m.config)
      await chrome.storage.local.set({ [PROVIDER_KEY]: c, configEpoch: crypto.randomUUID() })
      await refreshNamespace()
      return { saved: true }
    }
    if (m.type === "DELETE_CONFIG") { await chrome.storage.local.remove(PROVIDER_KEY); await refreshNamespace(); return { deleted: true } }
    if (m.type === "TEST_CONFIG") return { text: await complete(validateProvider(m.config), "Translate the user's text to Simplified Chinese. Return only the translation.", "Translation is ready.") }
    if (m.type === "LIST_MODELS") return { models: await listModels(m.config) }
    if (m.type === "GET_VOICES") return { voices: await localVoices() }
    if (m.type === "PREVIEW_VOICE") { await previewSpeech(m.voiceName, m.lang, m.rate); return { playing: true } }
    if (m.type === "STOP_VOICE") { stopSpeech(); return { stopped: true } }
    if (m.type === "TR_UPDATE_SETTINGS") {
      const settings = await writeSettings(chrome.storage.local, m.patch ?? {})
      await chrome.storage.session.set({ [SETTINGS_KEY]: settings })
      const tabId = await page.getActiveTabId()
      if (tabId !== undefined && (m.patch?.mode || m.patch?.targetLang) && await page.getPageMode(tabId) !== "off") await page.action(tabId, "retranslate")
      return settingsReply(tabId)
    }
    const tabId = await page.getActiveTabId()
    if (tabId === undefined) throw new Error("没有找到当前标签页。")
    if (m.type === "TR_PAGE_ACTION") {
      if (!["get", "restore", "toggle", "retranslate"].includes(m.action)) throw new Error("未知操作。")
      if (m.action !== "get" && m.action !== "restore" && await page.getPageMode(tabId) === "off") await provider()
      return { mode: await page.action(tabId, m.action) }
    }
    if (m.type === "VIDEO_TOGGLE") {
      const tab = await chrome.tabs.get(tabId)
      const u = new URL(tab.url ?? "about:blank")
      if (!(u.hostname === "www.youtube.com" || u.hostname === "youtube.com") || u.pathname !== "/watch") throw new Error("请先打开 YouTube 普通视频页面。")
      const previous = await videoState(tabId)
      const next = { subtitlesEnabled: typeof m.subtitlesEnabled === "boolean" ? m.subtitlesEnabled : previous.subtitlesEnabled, speechEnabled: typeof m.speechEnabled === "boolean" ? m.speechEnabled : previous.speechEnabled }
      if (m.speechEnabled === true) next.subtitlesEnabled = true
      if (!next.subtitlesEnabled) next.speechEnabled = false
      if (next.subtitlesEnabled) await provider()
      const states = (await chrome.storage.session.get("videoTabs")).videoTabs ?? {}
      states[String(tabId)] = next
      await chrome.storage.session.set({ videoTabs: states })
      try { await chrome.tabs.sendMessage(tabId, { type: "LINGO_VIDEO_SETTINGS", ...next }, { frameId: 0 }) }
      catch { states[String(tabId)] = previous; await chrome.storage.session.set({ videoTabs: states }); throw new Error("请刷新视频页面后重新开启字幕。") }
      return settingsReply(tabId)
    }
    throw new Error("未知操作。")
  }
  const handled = new Set(["TR_GET_SETTINGS", "GET_CONFIG", "SAVE_CONFIG", "DELETE_CONFIG", "TEST_CONFIG", "LIST_MODELS", "GET_VOICES", "PREVIEW_VOICE", "STOP_VOICE", "TR_UPDATE_SETTINGS", "TR_PAGE_ACTION", "VIDEO_TOGGLE"])
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || !handled.has(m.type)) return
    void handle(m, sender).then(reply).catch(error => reply({ error: error instanceof Error ? error.message : "操作失败，请重试。" }))
    return true
  })
  chrome.tabs.onRemoved.addListener(tabId => { void (async () => {
    const states = (await chrome.storage.session.get("videoTabs")).videoTabs ?? {}
    delete states[String(tabId)]
    await chrome.storage.session.set({ videoTabs: states })
  })() })
  async function toggle(tabId?: number) {
    try {
      await initialized
      tabId ??= await page.getActiveTabId()
      if (tabId === undefined) return
      if (await page.getPageMode(tabId) === "off") await provider()
      await page.action(tabId, "toggle")
    } catch { await chrome.runtime.openOptionsPage() }
  }
  chrome.commands.onCommand.addListener(command => { if (command === "toggle-translate") void toggle() })
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: "translate-page", title: "译伴：翻译网页 / 恢复原文", contexts: ["page", "selection"] }))
  })
  chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === "translate-page") void toggle(tab?.id) })
})

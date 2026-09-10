import type { TrPageMode } from "../shared/types"
import { readSettings, type StorageArea } from "../shared/settings-store"
export function createPageModeController(deps: { storage: StorageArea; tabs: typeof chrome.tabs }) {
  async function getActiveTabId() { return (await deps.tabs.query({ active: true, currentWindow: true }))[0]?.id }
  async function getPageMode(tabId: number): Promise<TrPageMode> {
    try { return (await deps.tabs.sendMessage(tabId, { type: "TR_GET_PAGE_STATE" }, { frameId: 0 }))?.mode ?? "off" } catch { return "off" }
  }
  async function setMode(tabId: number, mode: TrPageMode, skipCache = false) {
    const settings = await readSettings(deps.storage)
    try { await deps.tabs.sendMessage(tabId, { type: "TR_SET_MODE", mode, targetLang: settings.targetLang, generation: 0, skipCache }) }
    catch { throw new Error("此页面无法翻译。请刷新普通网页后重试；Chrome 设置页和扩展商店不能注入扩展。") }
    return mode
  }
  return {
    getActiveTabId, getPageMode,
    async action(tabId: number, action: string) {
      if (action === "get") return getPageMode(tabId)
      if (action === "restore") return setMode(tabId, "off")
      if (action === "retranslate") await setMode(tabId, "off")
      if (action === "toggle" && await getPageMode(tabId) !== "off") return setMode(tabId, "off")
      return setMode(tabId, (await readSettings(deps.storage)).mode, action === "retranslate")
    },
  }
}

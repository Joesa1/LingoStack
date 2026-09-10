import { $, rpc, languages, status, busy } from "../../src/shared/ui"
const language = $<HTMLSelectElement>("targetLang")
languages(language)
async function refresh() {
  const settings = await rpc("TR_GET_SETTINGS")
  language.value = settings.targetLang
  $<HTMLSelectElement>("mode").value = settings.mode
  $<HTMLInputElement>("selection").checked = settings.selectionEnabled
  $<HTMLInputElement>("subtitles").checked = settings.subtitlesEnabled
  $<HTMLInputElement>("speech").checked = settings.speechEnabled
  $<HTMLInputElement>("mute").checked = settings.muteOriginal
  status(settings.providerReady ? `模型：${settings.model?.model ?? "已配置"}` : "先打开设置，填写 API key 和模型。")
}
for (const [id, action] of [["translate", "toggle"], ["restore", "restore"], ["retry", "retranslate"]]) {
  const button = $<HTMLButtonElement>(id!)
  button.onclick = () => void busy(button, async () => {
    const r = await rpc("TR_PAGE_ACTION", { action }); status(r.mode === "off" ? "已恢复原文。" : "正在翻译，可继续浏览网页。")
  })
}
$("settings").onclick = () => { void chrome.runtime.openOptionsPage() }
for (const [id, key] of [["targetLang", "targetLang"], ["mode", "mode"], ["selection", "selectionEnabled"], ["mute", "muteOriginal"]]) {
  const el = $<HTMLInputElement | HTMLSelectElement>(id!)
  el.onchange = () => { const value = el instanceof HTMLInputElement ? el.checked : el.value; void rpc("TR_UPDATE_SETTINGS", { patch: { [key!]: value } }).then(() => status("偏好已保存。"), e => status(e.message, true)) }
}
for (const [id, key] of [["subtitles", "subtitlesEnabled"], ["speech", "speechEnabled"]]) {
  const el = $<HTMLInputElement>(id!)
  el.onchange = () => {
    el.disabled = true
    void rpc("VIDEO_TOGGLE", { [key!]: el.checked }).then(refresh).catch(async e => { await refresh(); status(e.message, true) }).finally(() => { el.disabled = false })
  }
}
void refresh().catch(e => status(e.message, true))

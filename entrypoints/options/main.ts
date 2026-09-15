import { $, rpc, languages, status, busy } from "../../src/shared/ui"
import { initTtsSettings } from "./tts"
import { PROVIDERS, type ProviderConfig, type Protocol } from "../../src/shared/provider-config"
const preset = $<HTMLSelectElement>("preset")
const language = $<HTMLSelectElement>("targetLang")
for (const [id, p] of Object.entries(PROVIDERS)) preset.add(new Option(p.name, id))
languages(language)
function config(): ProviderConfig { return { preset: preset.value, apiKey: $<HTMLInputElement>("apiKey").value, model: $<HTMLInputElement>("model").value, baseUrl: $<HTMLInputElement>("baseUrl").value, protocol: $<HTMLSelectElement>("protocol").value as Protocol } }
function showConfig(c: ProviderConfig) { preset.value = c.preset; for (const id of ["apiKey", "model", "baseUrl", "protocol"] as const) $<HTMLInputElement>(id).value = c[id]; $<HTMLDetailsElement>("advanced").open = c.preset === "custom" }
preset.onchange = () => {
  const p = PROVIDERS[preset.value]!
  $<HTMLInputElement>("baseUrl").value = p.baseUrl; $<HTMLSelectElement>("protocol").value = p.protocol
  $<HTMLInputElement>("apiKey").value = ""; $<HTMLInputElement>("model").value = ""; clearModels(); $("testStatus").hidden = true
  $<HTMLDetailsElement>("advanced").open = preset.value === "custom"
  status("已切换服务商，请填写对应密钥和模型并保存。")
}
$("reveal").onclick = () => { const input = $<HTMLInputElement>("apiKey"); input.type = input.type === "password" ? "text" : "password"; $("reveal").textContent = input.type === "password" ? "显示" : "隐藏" }
$<HTMLFormElement>("configForm").onsubmit = e => { e.preventDefault(); void busy($<HTMLButtonElement>("save"), async () => { await rpc("SAVE_CONFIG", { config: config() }); status("API 配置已保存。回到网页，点击扩展图标即可翻译。") }) }
function feedback(id: string, message: string, state: "pending" | "success" | "error") {
  const el = $(id)
  el.hidden = false; el.textContent = message; el.dataset.state = state
}
const modelSelect = $<HTMLSelectElement>("modelSelect")
function clearModels() {
  modelSelect.replaceChildren(new Option("请选择模型", ""))
  $("modelPicker").hidden = true; $("modelsStatus").hidden = true
}
function syncModelSelection() {
  const value = $<HTMLInputElement>("model").value.trim()
  modelSelect.value = [...modelSelect.options].some(o => o.value === value) ? value : ""
}
modelSelect.onchange = () => {
  if (!modelSelect.value) return
  $<HTMLInputElement>("model").value = modelSelect.value
  $("testStatus").hidden = true
}
$<HTMLInputElement>("model").addEventListener("input", () => { syncModelSelection(); $("testStatus").hidden = true })
for (const id of ["preset", "apiKey", "baseUrl", "protocol"]) {
  $(id).addEventListener("input", () => { clearModels(); $("testStatus").hidden = true })
}
function providerIdentity() { const { model, ...provider } = config(); return JSON.stringify(provider) }
$("test").onclick = async () => {
  const button = $<HTMLButtonElement>("test")
  const snapshot = config()
  const identity = JSON.stringify(snapshot)
  button.disabled = true; button.textContent = "测试中…"
  feedback("testStatus", "正在测试翻译，通常需要几秒，最长等待约 25 秒…", "pending")
  try {
    const r = await rpc("TEST_CONFIG", { config: snapshot })
    if (identity !== JSON.stringify(config())) return
    if (typeof r?.text !== "string" || !r.text.trim()) throw new Error("未收到测试译文，请重试。")
    feedback("testStatus", `测试通过：${r.text}。若刚修改配置，请点击保存配置。`, "success")
  } catch (e) {
    if (identity === JSON.stringify(config())) feedback("testStatus", `测试未通过：${e instanceof Error ? e.message : "请重试。"}`, "error")
  } finally { button.disabled = false; button.textContent = "测试翻译" }
}
$("loadModels").onclick = async () => {
  const button = $<HTMLButtonElement>("loadModels")
  const snapshot = config()
  const identity = providerIdentity()
  clearModels()
  button.disabled = true; button.textContent = "获取中…"
  feedback("modelsStatus", "正在获取模型列表…", "pending")
  try {
    const result = await rpc("LIST_MODELS", { config: snapshot })
    if (identity !== providerIdentity()) return
    const models = result?.models
    if (!Array.isArray(models) || models.some(id => typeof id !== "string" || !id)) throw new Error("服务商返回的模型列表格式不正确，请手动填写模型名称。")
    if (!models.length) throw new Error("服务商返回了空列表。请检查密钥的模型权限，或手动填写模型名称。")
    modelSelect.replaceChildren(new Option("请选择模型", ""), ...models.map(id => new Option(id, id)))
    syncModelSelection()
    $("modelPicker").hidden = false
    feedback("modelsStatus", `已获取 ${models.length} 个模型，请在下方选择。选择后点击保存配置。`, "success")
    modelSelect.focus()
  } catch (e) {
    if (identity === providerIdentity()) feedback("modelsStatus", `获取失败：${e instanceof Error ? e.message : "请重试。"}`, "error")
  } finally { button.disabled = false; button.textContent = "获取列表" }
}
$("delete").onclick = () => void busy($<HTMLButtonElement>("delete"), async () => { await rpc("DELETE_CONFIG"); showConfig(await rpc("GET_CONFIG")); clearModels(); $("testStatus").hidden = true; status("保存的 API 配置已删除。") })
let voices: chrome.tts.TtsVoice[] = []
function renderVoices(selected = "") {
  const el = $<HTMLSelectElement>("voice"); el.replaceChildren(new Option("按目标语言自动选择", ""))
  for (const v of voices.filter(v => v.lang?.split("-")[0] === language.value.split("-")[0])) el.add(new Option(`${v.voiceName} · ${v.lang}`, v.voiceName))
  el.value = [...el.options].some(o => o.value === selected) ? selected : ""
}
async function saveSpeech() {
  const rate = Number($<HTMLInputElement>("rate").value)
  $("rateValue").textContent = `${rate.toFixed(1)}×`
  const mode = $<HTMLSelectElement>("speechMode").value as "natural" | "sync"
  await rpc("TR_UPDATE_SETTINGS", { patch: { targetLang: language.value, voiceName: $<HTMLSelectElement>("voice").value, speechRate: rate, muteOriginal: $<HTMLInputElement>("mute").checked, waitForSpeech: mode === "sync", speechMode: mode } })
  status("朗读偏好已保存。")
}
language.onchange = () => { renderVoices(); void saveSpeech().catch(e => status(e.message, true)) }
for (const id of ["voice", "rate", "mute", "speechMode"]) $(id).onchange = () => { void saveSpeech().catch(e => status(e.message, true)) }
$("rate").oninput = () => { $("rateValue").textContent = `${Number($<HTMLInputElement>("rate").value).toFixed(1)}×` }
void (async () => {
  await initTtsSettings()
  const [c, s, v] = await Promise.all([rpc("GET_CONFIG"), rpc("TR_GET_SETTINGS"), rpc("GET_VOICES")])
  showConfig(c); language.value = s.targetLang; voices = v.voices; renderVoices(s.voiceName)
  $<HTMLInputElement>("rate").value = String(s.speechRate); $("rateValue").textContent = `${s.speechRate.toFixed(1)}×`
  $<HTMLInputElement>("mute").checked = s.muteOriginal
  $<HTMLSelectElement>("speechMode").value = s.speechMode
  status(s.providerReady ? "配置已就绪，可返回网页开始翻译。" : "填写 API key 和模型名称，然后保存配置。")
})().catch(e => status(e.message, true))

// Switch presentation panels without changing configuration or provider state.
for (const [index, id] of ["translationTab", "speechTab"].entries()) {
  $(id).onclick = () => {
    for (const [i, tab] of ["translationTab", "speechTab"].entries()) {
      $(tab).classList.toggle("active", i === index)
      $(tab).setAttribute("aria-pressed", String(i === index))
    }
    $("translationPanel").hidden = index !== 0
    $("speechPanel").hidden = index !== 1
  }
}

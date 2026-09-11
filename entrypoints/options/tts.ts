import { $, rpc } from "../../src/shared/ui"
import { defaultTts, presetVoices, TTS_MODELS, TTS_PROVIDERS, type TtsConfig, type TtsProvider, type VoiceOption } from "../../src/shared/tts-config"

export async function initTtsSettings() {
  const provider = $<HTMLSelectElement>("ttsProvider")
  const voiceSelect = $<HTMLSelectElement>("ttsVoiceSelect")
  const voiceInput = $<HTMLInputElement>("ttsVoice")
  const style = $<HTMLSelectElement>("ttsStyle")
  const models = $<HTMLSelectElement>("ttsModel")
  const region = $<HTMLSelectElement>("ttsRegion")
  const drafts: Partial<Record<TtsProvider, TtsConfig>> = {}
  let shown: TtsProvider = "system"
  let voices: VoiceOption[] = []
  let revision = 0
  let previewRevision = 0
  let testing = false
  const feedback = (id: string, text: string, state: string) => { const el = $(id); el.hidden = false; el.textContent = text; el.dataset.state = state }
  for (const [id, p] of Object.entries(TTS_PROVIDERS)) provider.add(new Option(p.name, id))
  function config(): TtsConfig {
    return { provider: shown, apiKey: $<HTMLInputElement>("ttsKey").value, region: shown === "azure" ? $<HTMLInputElement>("azureRegion").value : region.value, model: models.value, voice: voiceInput.value, style: style.value }
  }
  function renderStyles(selected = "") {
    const labels: Record<string, string> = { chat: "自然聊天", calm: "平静", cheerful: "温暖愉快", happy: "开心", neutral: "平和", gentle: "温柔", newscast: "新闻播报", "narration-relaxed": "轻松讲述" }
    const options = shown === "dashscope" && models.value.includes("instruct") ? ["chat", "calm", "cheerful"] : shown === "minimax" ? ["calm", "happy"] : shown === "azure" ? voices.find(v => v.id === voiceInput.value)?.styles ?? [] : []
    style.replaceChildren(new Option("默认 · 随文本自然表达", ""), ...options.map(id => new Option(labels[id] ?? id, id)))
    style.value = options.includes(selected) ? selected : ""
    $("ttsStyleLabel").hidden = !options.length
  }
  function renderVoices(selected: string) {
    voiceSelect.replaceChildren(new Option("选择音色，或在下方手填 ID", ""), ...voices.map(v => new Option(v.name, v.id)))
    voiceInput.value = selected
    voiceSelect.value = voices.some(v => v.id === selected) ? selected : ""
  }
  function show(c: TtsConfig) {
    shown = c.provider; provider.value = c.provider
    $("ttsCloud").hidden = c.provider === "system"
    $("systemVoiceLabel").hidden = c.provider !== "system"
    $("ttsDelete").hidden = c.provider === "system"
    const p = TTS_PROVIDERS[c.provider]
    $("ttsHelp").textContent = p.help
    const link = $<HTMLAnchorElement>("ttsRegister"); link.hidden = !p.url; link.href = c.provider === "minimax" && c.region === "global" ? "https://platform.minimax.io/" : p.url
    $<HTMLInputElement>("ttsKey").value = c.apiKey
    $<HTMLInputElement>("azureRegion").value = c.region
    region.replaceChildren(...(c.provider === "minimax" ? [["cn", "国内站"], ["global", "国际站"]] : [["beijing", "北京 · 国内"], ["singapore", "新加坡 · 国际"]]).map(([id, name]) => new Option(name, id)))
    region.value = c.region
    $("azureRegionLabel").hidden = c.provider !== "azure"; $("ttsRegionLabel").hidden = c.provider === "azure"
    $("ttsModelLabel").hidden = c.provider === "azure"; $("ttsModelHint").hidden = c.provider === "azure"
    models.replaceChildren(...TTS_MODELS[c.provider].map(id => new Option(id, id))); models.value = c.model
    voices = presetVoices(c.provider)
    if (c.provider === "azure" && c.style) {
      const savedVoice = voices.find(v => v.id === c.voice)
      if (savedVoice) savedVoice.styles = [...new Set([...(savedVoice.styles ?? []), c.style])]
      else voices.push({ id: c.voice, name: `${c.voice} · 已保存`, styles: [c.style] })
    }
    renderVoices(c.voice); renderStyles(c.style)
    $("ttsLoadVoices").textContent = c.provider === "dashscope" ? "查看预设" : "获取音色"
    $("ttsVoicesStatus").hidden = true
    if (c.provider !== "system") feedback("ttsVoicesStatus", "当前显示内置音色预设，可手填其他音色 ID。", "pending")
  }
  function edited() {
    revision++; previewRevision++
    $("ttsTestStatus").hidden = true; $("ttsSaveStatus").hidden = true
    if (testing) void rpc("STOP_VOICE").catch(() => {})
  }
  provider.onchange = () => {
    drafts[shown] = config(); edited()
    const next = provider.value as TtsProvider
    const expected = revision
    // Hide previous secrets immediately while retrieving this provider's own profile.
    show(drafts[next] ?? defaultTts(next))
    if (!drafts[next]) void rpc("GET_TTS_CONFIG", { provider: next }).then(c => { if (revision === expected) show(c) }).catch(() => feedback("ttsSaveStatus", "无法读取朗读配置，请刷新设置页。", "error"))
  }
  for (const id of ["ttsKey", "ttsVoice", "azureRegion", "ttsRegion", "ttsModel", "ttsStyle", "targetLang", "voice", "rate"]) $(id).addEventListener("input", edited)
  voiceInput.oninput = () => { voiceSelect.value = voices.some(v => v.id === voiceInput.value) ? voiceInput.value : ""; renderStyles() }
  voiceSelect.onchange = () => { if (voiceSelect.value) { edited(); voiceInput.value = voiceSelect.value; renderStyles() } }
  models.onchange = () => renderStyles(style.value)
  region.onchange = () => {
    // Regions use different credentials; require the user to supply the matching key.
    $<HTMLInputElement>("ttsKey").value = ""
    if (shown === "minimax") $<HTMLAnchorElement>("ttsRegister").href = region.value === "global" ? "https://platform.minimax.io/" : TTS_PROVIDERS.minimax.url
    feedback("ttsSaveStatus", "区域已切换，请填写该区域的密钥并重新试听。", "pending")
  }
  $("ttsLoadVoices").onclick = async () => {
    const button = $<HTMLButtonElement>("ttsLoadVoices"); button.disabled = true
    const expected = revision
    feedback("ttsVoicesStatus", "正在读取音色…", "pending")
    try {
      const result = shown === "dashscope" ? { voices: presetVoices(shown), source: "官方预设音色，不是账户权限列表；可手填其他 ID。" } : await rpc("LIST_TTS_VOICES", { config: config() })
      if (expected !== revision) return
      voices = result.voices; const selected = voiceInput.value; renderVoices(selected); renderStyles(style.value)
      feedback("ttsVoicesStatus", `${result.source} 共 ${voices.length} 个。`, "success")
    } catch (e) { if (expected === revision) feedback("ttsVoicesStatus", `获取失败：${e instanceof Error ? e.message : "请重试。"}`, "error") }
    finally { button.disabled = false }
  }
  $("preview").onclick = async () => {
    const button = $<HTMLButtonElement>("preview"); button.disabled = true; button.textContent = "测试中…"
    testing = true; const expected = ++previewRevision
    feedback("ttsTestStatus", shown === "system" ? "正在启动本机声音…" : "正在合成试听音频，最长等待约 40 秒；会消耗语音额度…", "pending")
    try {
      await rpc("PREVIEW_VOICE", { config: config(), voiceName: $<HTMLSelectElement>("voice").value, lang: $<HTMLSelectElement>("targetLang").value, rate: Number($<HTMLInputElement>("rate").value) })
      if (expected === previewRevision) feedback("ttsTestStatus", "测试通过：音频已开始播放。确认听感后点击「保存朗读配置」。", "success")
    } catch (e) { if (expected === previewRevision) feedback("ttsTestStatus", `测试未通过：${e instanceof Error ? e.message : "请重试。"}`, "error") }
    finally { testing = false; button.disabled = false; button.textContent = "试听并测试" }
  }
  $("stop").onclick = async () => { previewRevision++; try { await rpc("STOP_VOICE"); feedback("ttsTestStatus", "试听已停止。", "pending") } catch { feedback("ttsTestStatus", "停止失败，请重新加载扩展。", "error") } }
  $("ttsSave").onclick = async () => {
    const button = $<HTMLButtonElement>("ttsSave"); button.disabled = true; const snapshot = config(); const expected = revision
    try { await rpc("SAVE_TTS_CONFIG", { config: snapshot }); drafts[snapshot.provider] = snapshot; if (expected === revision) feedback("ttsSaveStatus", "朗读配置已保存，视频将使用这个服务；其他供应商的配置仍保留。", "success") }
    catch (e) { if (expected === revision) feedback("ttsSaveStatus", e instanceof Error ? e.message : "保存失败。", "error") }
    finally { button.disabled = false }
  }
  $("ttsDelete").onclick = async () => {
    const id = shown; edited(); const expected = revision
    try { await rpc("DELETE_TTS_CONFIG", { provider: id }); delete drafts[id]; if (expected === revision) { show(defaultTts(id)); feedback("ttsSaveStatus", "此服务的保存配置已删除；若它原本正在使用，已切回系统朗读。", "success") } }
    catch { feedback("ttsSaveStatus", "删除失败，请重试。", "error") }
  }
  show(await rpc("GET_TTS_CONFIG"))
}

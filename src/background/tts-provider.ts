import { presetVoices, validateTts, type TtsConfig, type VoiceOption } from "../shared/tts-config"

const languages: Record<string, string> = { zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", ru: "Russian", ar: "Arabic" }
const MAX_BYTES = 10 * 1024 * 1024
function endpoint(c: TtsConfig) {
  if (c.provider === "azure") return `https://${c.region}.tts.speech.microsoft.com`
  if (c.provider === "minimax") return c.region === "global" ? "https://api.minimax.io" : "https://api.minimax.cn"
  return c.region === "singapore" ? "https://dashscope-intl.aliyuncs.com" : "https://dashscope.aliyuncs.com"
}
function headers(c: TtsConfig): Record<string, string> { return c.provider === "azure" ? { "Ocp-Apim-Subscription-Key": c.apiKey } : { Authorization: `Bearer ${c.apiKey}` } }
function statusError(status: number): Error {
  const hint = status === 401 ? "密钥无效或与所选区域不匹配。" : status === 403 ? "服务未开通、权限不足或额度不可用。" : status === 429 ? "请求过多或额度不足，请检查控制台后重试。" : status === 400 ? "模型、音色、语言或风格不匹配，请检查配置。" : status === 402 ? "余额不足，请在服务商控制台充值。" : status === 404 ? "区域、模型或音色不存在。" : "语音服务暂时不可用，请稍后重试。"
  return new Error(`语音请求失败（HTTP ${status}）：${hint}`)
}
async function request(url: string, init: RequestInit, signal: AbortSignal) {
  try {
    const res = await fetch(url, { ...init, signal, credentials: "omit", redirect: "error", cache: "no-store" })
    if (!res.ok) throw statusError(res.status)
    return res
  } catch (e) {
    if (signal.aborted) throw signal.reason
    if (e instanceof TypeError) throw new Error("无法连接语音服务，请检查网络与所选区域。")
    throw e
  }
}
async function bytes(res: Response, max = MAX_BYTES): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length")) > max) throw new Error("语音响应过大，请缩短文本。")
  const reader = res.body?.getReader()
  if (!reader) throw new Error("服务商没有返回音频。")
  const parts: Uint8Array[] = []; let size = 0
  try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > max) throw new Error("语音响应过大，请缩短文本。"); parts.push(r.value) } }
  catch (e) { await reader.cancel(); throw e }
  const output = new Uint8Array(size); let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}
async function json(res: Response): Promise<any> {
  try { return JSON.parse(new TextDecoder().decode(await bytes(res, MAX_BYTES * 2))) }
  catch (e) { if (e instanceof SyntaxError) throw new Error("语音服务返回了无法解析的数据。"); throw e }
}
function checkMini(data: any) {
  const code = data?.base_resp?.status_code
  if (code === 0) return
  if (code === 1004 || code === 2049) throw new Error("MiniMax 密钥无效，请检查密钥与国内 / 国际站选择。")
  if (code === 1008) throw new Error("MiniMax 余额不足，请充值后重试。")
  if (code === 1002) throw new Error("MiniMax 请求过多，请稍后重试。")
  throw new Error("MiniMax 合成失败，请检查账户额度、模型和音色权限。")
}
export function audioDataUrl(data: Uint8Array, mime: string): string {
  if (!data.length || data.length > MAX_BYTES) throw new Error("音频为空或过大，请重试。")
  let binary = ""
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192))
  return `data:${mime};base64,${btoa(binary)}`
}
export function escapeXml(s: string) { return s.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!) }
export async function synthesize(raw: TtsConfig, text: string, lang: string, signal: AbortSignal): Promise<string> {
  const c = validateTts(raw)
  if (!text.trim() || Array.from(text).length > 280) throw new Error("朗读文本为空或未正确分段。")
  if (c.provider === "azure") {
    const voiceLang = c.voice.split("-").slice(0, 2).join("-")
    if (voiceLang.split("-")[0] !== lang.split("-")[0] && !c.voice.includes("Multilingual")) throw new Error("所选 Azure 音色与目标语言不符，请获取并选择对应语言音色。")
    const content = escapeXml(text)
    const styled = c.style ? `<mstts:express-as style="${escapeXml(c.style)}">${content}</mstts:express-as>` : content
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${voiceLang}"><voice name="${escapeXml(c.voice)}">${styled}</voice></speak>`
    const res = await request(`${endpoint(c)}/cognitiveservices/v1`, { method: "POST", headers: { ...headers(c), "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3" }, body: ssml }, signal)
    return audioDataUrl(await bytes(res), "audio/mpeg")
  }
  if (c.provider === "minimax") {
    const data = await json(await request(`${endpoint(c)}/v1/t2a_v2`, { method: "POST", headers: { ...headers(c), "Content-Type": "application/json" }, body: JSON.stringify({ model: c.model, text, stream: false, output_format: "hex", language_boost: languages[lang.split("-")[0]!] ?? "auto", voice_setting: { voice_id: c.voice, speed: 1, vol: 1, pitch: 0, ...(c.style ? { emotion: c.style } : {}) }, audio_setting: { sample_rate: 24000, bitrate: 128000, format: "mp3", channel: 1 } }) }, signal))
    checkMini(data)
    const hex = data?.data?.audio
    if (typeof hex !== "string" || !hex.length || hex.length % 2 || !/^[\da-f]+$/i.test(hex)) throw new Error("MiniMax 未返回有效音频。")
    return audioDataUrl(Uint8Array.from(hex.match(/../g)!, s => parseInt(s, 16)), "audio/mpeg")
  }
  const language = languages[lang.split("-")[0]!]
  if (!language || language === "Arabic") throw new Error("此阿里语音模型不支持所选语言，请选择其他朗读服务。")
  const instructions: Record<string, string> = { chat: "Speak naturally in a relaxed conversational tone, with clear phrasing and restrained emotion. Read only the supplied text without adding fillers.", calm: "Speak calmly and gently with clear natural pauses. Read only the supplied text.", cheerful: "Speak with a warm, cheerful tone, without exaggerated acting or added words." }
  const data = await json(await request(`${endpoint(c)}/api/v1/services/aigc/multimodal-generation/generation`, { method: "POST", headers: { ...headers(c), "Content-Type": "application/json" }, body: JSON.stringify({ model: c.model, input: { text, voice: c.voice, language_type: language, ...(c.model.includes("instruct") && instructions[c.style] ? { instructions: instructions[c.style], optimize_instructions: false } : {}) } }) }, signal))
  if (data?.code) throw new Error("阿里语音合成失败，请检查密钥地域、模型权限、音色和账户额度。")
  let audio: URL
  try { audio = new URL(data?.output?.audio?.url) } catch { throw new Error("阿里未返回音频地址，请检查模型和音色。") }
  // Upgrade the documented signed OSS URL to TLS; never forward the API key.
  if (!/^dashscope-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(audio.hostname) || !["https:", "http:"].includes(audio.protocol) || audio.username || audio.password || audio.port) throw new Error("阿里返回了非预期的音频地址，已停止下载。")
  audio.protocol = "https:"
  return audioDataUrl(await bytes(await request(audio.href, {}, signal)), "audio/wav")
}
export async function listTtsVoices(raw: unknown): Promise<{ voices: VoiceOption[]; source: string }> {
  const c = validateTts(raw, false)
  if (c.provider === "dashscope") return { voices: presetVoices(c.provider), source: "内置官方音色预设，未验证账户权限；可手填其他音色 ID，请用试听确认。" }
  const signal = AbortSignal.timeout(25_000)
  if (c.provider === "azure") {
    const data = await json(await request(`${endpoint(c)}/cognitiveservices/voices/list`, { headers: headers(c) }, signal))
    if (!Array.isArray(data)) throw new Error("Azure 音色列表格式不正确。")
    const voices = data.filter(v => typeof v.ShortName === "string" && typeof v.Locale === "string").map(v => ({ id: v.ShortName, name: `${v.LocalName || v.DisplayName || v.ShortName} · ${v.Locale}`, lang: v.Locale, styles: Array.isArray(v.StyleList) ? v.StyleList.filter((s: unknown) => typeof s === "string") : [] }))
    if (!voices.length) throw new Error("Azure 返回了空音色列表，请检查资源区域。")
    return { voices, source: "已从 Azure 获取音色；部分音色可能需要付费档位。" }
  }
  if (c.provider === "minimax") {
    const data = await json(await request(`${endpoint(c)}/v1/get_voice`, { method: "POST", headers: { ...headers(c), "Content-Type": "application/json" }, body: JSON.stringify({ voice_type: "all" }) }, signal))
    checkMini(data)
    const voices = [data.system_voice, data.voice_cloning, data.voice_generation].flatMap(v => Array.isArray(v) ? v : []).filter(v => typeof v.voice_id === "string").map(v => ({ id: v.voice_id, name: v.voice_name || v.voice_id }))
    if (!voices.length) throw new Error("MiniMax 返回了空音色列表。")
    return { voices, source: "已从 MiniMax 获取音色；使用自定义音色可能另收费。" }
  }
  return { voices: [], source: "系统声音" }
}

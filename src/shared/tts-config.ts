export type TtsProvider = "system" | "dashscope" | "azure" | "minimax"
export type TtsConfig = { provider: TtsProvider; apiKey: string; region: string; model: string; voice: string; style: string }
export type VoiceOption = { id: string; name: string; lang?: string; styles?: string[] }
export const TTS_KEY = "ttsProfiles"
export const TTS_PROVIDERS = {
  system: { name: "系统声音 · 免费", url: "", help: "使用电脑已有声音，没有云端语音费用。" },
  dashscope: { name: "阿里云百炼", url: "https://bailian.console.aliyun.com/", help: "开通百炼并创建对应地域的 API Key。普通按量 API Key 与订阅套餐 Key 不通用；试听会消耗语音额度。" },
  azure: { name: "Microsoft Azure", url: "https://portal.azure.com/", help: "创建 Speech 资源，选择 F0 可用免费额度，填写资源的密钥与区域（如 eastus）。此处支持国际 Azure，不含中国区。" },
  minimax: { name: "MiniMax", url: "https://platform.minimaxi.com/", help: "注册开放平台，创建按量 API Key 并充值或领取可用额度。国内站与国际站的密钥和价格不同；网页配音会员不能直接用于 API。" },
} as const
export const TTS_MODELS: Record<TtsProvider, string[]> = {
  system: [], dashscope: ["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
  azure: [], minimax: ["speech-2.8-turbo", "speech-2.8-hd"],
}
export function defaultTts(provider: TtsProvider = "system"): TtsConfig {
  return { provider, apiKey: "", region: provider === "azure" ? "eastus" : provider === "minimax" ? "cn" : "beijing",
    model: TTS_MODELS[provider][0] ?? "", voice: provider === "dashscope" ? "Cherry" : provider === "azure" ? "zh-CN-XiaoxiaoNeural" : provider === "minimax" ? "Chinese (Mandarin)_Reliable_Executive" : "",
    style: provider === "dashscope" ? "chat" : "" }
}
export function validateTts(raw: unknown, requireVoice = true): TtsConfig {
  if (!raw || typeof raw !== "object") throw new Error("请先配置朗读服务。")
  const c = raw as TtsConfig
  if (!Object.hasOwn(TTS_PROVIDERS, c.provider)) throw new Error("请选择支持的朗读服务商。")
  if (c.provider === "system") return defaultTts()
  for (const field of ["apiKey", "region", "model", "voice", "style"] as const) {
    if (typeof c[field] !== "string" || c[field].length > (field === "apiKey" ? 4096 : 200) || /[\r\n]/.test(c[field])) throw new Error("朗读配置格式不正确。")
  }
  const result = Object.fromEntries(Object.entries(c).filter(([key]) => ["provider", "apiKey", "region", "model", "voice", "style"].includes(key)).map(([key, value]) => [key, value.trim()])) as TtsConfig
  if (!result.apiKey) throw new Error("请填写朗读服务的 API Key。")
  if (requireVoice && !result.voice) throw new Error("请选择或填写音色 ID。")
  if (c.provider === "azure") {
    if (!/^[a-z][a-z0-9]{1,39}$/.test(result.region)) throw new Error("Azure 区域格式不正确，例如 eastus、southeastasia。")
    if (requireVoice && !/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9:]+Neural$/.test(result.voice)) throw new Error("请填写有效的 Azure 音色 ID，或先获取音色。")
  } else {
    if (!TTS_MODELS[c.provider].includes(result.model)) throw new Error("请选择列表中的语音模型。")
    if (!(c.provider === "dashscope" ? ["beijing", "singapore"] : ["cn", "global"]).includes(result.region)) throw new Error("请选择正确的服务区域。")
  }
  if (!/^[a-z-]*$/.test(result.style)) throw new Error("朗读风格格式不正确。")
  return result
}
export function presetVoices(provider: TtsProvider): VoiceOption[] {
  if (provider === "dashscope") return [{ id: "Cherry", name: "芊悦 · 女声" }, { id: "Ethan", name: "晨煦 · 男声" }, { id: "Chelsie", name: "千雪 · 女声" }, { id: "Serena", name: "苏瑶 · 女声" }]
  if (provider === "azure") return [{ id: "zh-CN-XiaoxiaoNeural", name: "晓晓 · 中文女声", lang: "zh-CN", styles: ["chat", "cheerful", "gentle", "newscast"] }, { id: "zh-CN-YunxiNeural", name: "云希 · 中文男声", lang: "zh-CN", styles: ["chat", "cheerful", "narration-relaxed"] }]
  if (provider === "minimax") return [{ id: "Chinese (Mandarin)_Reliable_Executive", name: "沉稳高管 · 中文男声" }, { id: "Chinese (Mandarin)_News_Anchor", name: "新闻女声 · 中文女声" }]
  return []
}

// A conservative 280-code-point bound also fits providers counting Han characters twice.
export function speechChunks(text: string): string[] {
  const chunks: string[] = []
  let current = ""
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)) {
    if (Array.from(current + segment).length > 280 && current) { chunks.push(current); current = "" }
    const chars = Array.from(segment)
    while (chars.length > 280) chunks.push(chars.splice(0, 280).join(""))
    current += chars.join("")
  }
  if (current) chunks.push(current)
  return chunks.filter(s => s.trim())
}

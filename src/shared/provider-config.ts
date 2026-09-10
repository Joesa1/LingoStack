export type Protocol = "openai-compatible" | "openai-responses" | "anthropic" | "gemini"
export type ProviderConfig = { preset: string; protocol: Protocol; baseUrl: string; model: string; apiKey: string }

// Protocol families and base URL conventions extracted from DimAgent's built-in drivers.
export const PROVIDERS: Record<string, { name: string; protocol: Protocol; baseUrl: string }> = {
  custom: { name: "自定义 / 中转服务", protocol: "openai-compatible", baseUrl: "" },
  deepseek: { name: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" },
  siliconflow: { name: "硅基流动", protocol: "openai-compatible", baseUrl: "https://api.siliconflow.cn/v1" },
  openai: { name: "OpenAI", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  anthropic: { name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  gemini: { name: "Google Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  moonshot: { name: "Moonshot / Kimi", protocol: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1" },
  openrouter: { name: "OpenRouter", protocol: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" },
  dashscope: { name: "阿里云百炼", protocol: "openai-compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
}
export const EMPTY_PROVIDER: ProviderConfig = { preset: "custom", protocol: "openai-compatible", baseUrl: "", apiKey: "", model: "" }
export const PROVIDER_KEY = "providerConfig"

export function validateProvider(value: unknown, requireModel = true): ProviderConfig {
  if (typeof value !== "object" || value === null) throw new Error("请先配置模型服务。")
  const r = value as Record<string, unknown>
  if (!["openai-compatible", "openai-responses", "anthropic", "gemini"].includes(String(r.protocol))) throw new Error("请选择支持的接口协议。")
  for (const field of ["baseUrl", "apiKey", "model"]) {
    if (typeof r[field] !== "string" || (r[field] as string).length > 4096) throw new Error("API 配置格式不正确。")
  }
  let url: URL
  try { url = new URL((r.baseUrl as string).trim()) } catch { throw new Error("请填写完整的 API 地址，例如 https://服务商地址/v1。") }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname)
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) throw new Error("API 地址需使用 HTTPS；仅本机服务可以使用 HTTP。地址中不要包含密钥或查询参数。")
  const apiKey = (r.apiKey as string).trim()
  if (!local && !apiKey) throw new Error("请填写 API key。")
  if (/[\r\n]/.test(apiKey)) throw new Error("API key 中不能有换行。")
  const model = (r.model as string).trim()
  if (requireModel && !model) throw new Error("请填写或选择模型名称。")
  let baseUrl = url.href.replace(/\/+$/, "").replace(/\/(chat\/completions|responses|messages)$/, "")
  if (r.protocol === "anthropic" && !/\/v1$/.test(baseUrl)) baseUrl += "/v1"
  if (r.protocol === "gemini" && !/\/v1(beta)?$/.test(baseUrl)) baseUrl += "/v1beta"
  return { preset: typeof r.preset === "string" && r.preset in PROVIDERS ? r.preset : "custom", protocol: r.protocol as Protocol, baseUrl, apiKey, model }
}

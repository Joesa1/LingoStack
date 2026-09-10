import type { TranslateParams, TranslateResult, WebTranslateRpcErrorCode } from "../shared/types"
import { validateProvider, type ProviderConfig } from "../shared/provider-config"
import { buildSystemPrompt, buildSelectionSystemPrompt, buildUserPrompt, parseTranslationReply, parseSelectionDictionaryReply } from "./prompts"

export class ProviderError extends Error {
  constructor(public code: WebTranslateRpcErrorCode, message: string) { super(message) }
}

function headers(c: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" }
  if (c.protocol === "anthropic") {
    h["x-api-key"] = c.apiKey
    h["anthropic-version"] = "2023-06-01"
    h["anthropic-dangerous-direct-browser-access"] = "true"
  } else if (c.protocol === "gemini") h["x-goog-api-key"] = c.apiKey
  else if (c.apiKey) h.Authorization = `Bearer ${c.apiKey}`
  return h
}

async function request(c: ProviderConfig, path: string, body: unknown, fetchFn: typeof fetch): Promise<any> {
  try {
    const response = await fetchFn(`${c.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: headers(c),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25_000), redirect: "error", credentials: "omit", cache: "no-store",
    })
    if (!response.ok) {
      // Provider bodies may echo credentials or source text; show only a safe status.
      const hint = response.status === 401 || response.status === 403 ? "请检查 API key 和模型使用权限。"
        : response.status === 429 ? "请求限流或额度不足，请稍后再试并检查账户余额。"
        : response.status === 404 ? "请检查 API 地址、接口协议和模型名称。" : "请检查请求配置，或稍后重试。"
      throw new ProviderError(response.status < 500 ? "provider_not_ready" : "provider_error", `HTTP ${response.status}：${hint}`)
    }
    return await response.json()
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new ProviderError("timeout", "模型响应超时，请重试或换用更快的模型。")
    throw new ProviderError("provider_error", "无法连接模型服务，请检查 API 地址和网络连接。")
  }
}

export async function complete(config: ProviderConfig, system: string, user: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const c = validateProvider(config)
  let data: any
  let text = ""
  if (c.protocol === "anthropic") {
    data = await request(c, "/messages", { model: c.model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] }, fetchFn)
    if (data.stop_reason === "max_tokens") throw new ProviderError("parse_error", "模型输出被截断，请缩短选区或更换模型。")
    text = data.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("") ?? ""
  } else if (c.protocol === "gemini") {
    data = await request(c, `/models/${encodeURIComponent(c.model.replace(/^models\//, ""))}:generateContent`, { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }] }, fetchFn)
    if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new ProviderError("parse_error", "模型输出被截断。")
    text = data.candidates?.[0]?.content?.parts?.filter((p: any) => !p.thought && typeof p.text === "string").map((p: any) => p.text).join("") ?? ""
  } else if (c.protocol === "openai-responses") {
    data = await request(c, "/responses", { model: c.model, instructions: system, input: user, store: false, stream: false }, fetchFn)
    if (data.status === "incomplete" || data.error) throw new ProviderError("parse_error", "模型未完成翻译，请重试或更换模型。")
    text = data.output?.filter((p: any) => p.type === "message").flatMap((p: any) => p.content ?? []).filter((p: any) => p.type === "output_text").map((p: any) => p.text).join("") ?? ""
  } else {
    data = await request(c, "/chat/completions", { model: c.model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: user }] }, fetchFn)
    if (data.choices?.[0]?.finish_reason === "length") throw new ProviderError("parse_error", "模型输出被截断。")
    const content = data.choices?.[0]?.message?.content
    text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p.type === "text").map(p => p.text).join("") : ""
  }
  if (typeof text !== "string" || !text.trim()) throw new ProviderError("parse_error", "模型没有返回文字，请检查模型是否支持文本翻译。")
  return text
}

export async function listModels(config: ProviderConfig, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const c = validateProvider(config, false)
  const data = await request(c, "/models", undefined, fetchFn)
  const models = c.protocol === "gemini" ? data.models?.filter((m: any) => m.supportedGenerationMethods?.includes("generateContent")).map((m: any) => m.name?.replace(/^models\//, "")) : data.data?.map((m: any) => m.id)
  if (!Array.isArray(models)) throw new Error("服务商不支持模型列表，请手动填写模型名称。")
  return [...new Set(models.filter((m: unknown): m is string => typeof m === "string" && m.length > 0))].sort() as string[]
}

export async function translate(config: ProviderConfig, params: TranslateParams, fetchFn: typeof fetch = fetch): Promise<TranslateResult> {
  if (!Array.isArray(params.items) || !params.items.length || params.items.length > 20 || params.items.some(i => typeof i.text !== "string" || i.text.length > 20_000)) throw new ProviderError("invalid_params", "翻译内容过长或格式不正确。")
  const system = params.selection ? buildSelectionSystemPrompt(params.targetLang, params.sourceLang, params.selection) : buildSystemPrompt(params.targetLang, params.sourceLang)
  const raw = await complete(config, system, buildUserPrompt(params.targetLang, params.items, params.pageTitle, params.selection), fetchFn)
  return params.selection?.dictionary ? parseSelectionDictionaryReply(raw, params.items[0]!) : parseTranslationReply(raw, params.items)
}

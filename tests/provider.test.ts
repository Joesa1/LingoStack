// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import { translate, listModels, complete } from "../src/background/provider"
import { validateProvider, type Protocol } from "../src/shared/provider-config"
const config = { preset: "custom", protocol: "openai-compatible" as Protocol, baseUrl: "https://provider.example/v1", apiKey: "test-secret", model: "test-model" }
const params = { targetLang: "zh-CN", mode: "bilingual" as const, items: [{ id: "a", text: "Hello" }, { id: "b", text: "World" }] }
function mock(body: unknown, status = 200) { return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch }
describe("provider translation contracts", () => {
  it.each([
    ["openai-compatible", "/chat/completions", { choices: [{ message: { content: "你好\n%%\n世界" } }] }],
    ["openai-responses", "/responses", { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "你好\n%%\n世界" }] }] }],
    ["anthropic", "/messages", { content: [{ type: "text", text: "你好\n%%\n世界" }] }],
    ["gemini", "/models/test-model:generateContent", { candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "你好\n%%\n世界" }] } }] }],
  ])("translates and maps IDs through %s", async (protocol, suffix, response) => {
    const fetchFn = mock(response)
    const result = await translate({ ...config, protocol: protocol as Protocol }, params, fetchFn)
    expect(result.results).toEqual([{ id: "a", text: "你好" }, { id: "b", text: "世界" }])
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!
    expect(String(url)).toContain(suffix)
    expect(String(url)).not.toContain(config.apiKey)
    expect(init?.redirect).toBe("error")
    expect(JSON.parse(init?.body as string).model ?? "test-model").toBe(config.model)
  })
  it.each(["openai-compatible", "openai-responses", "anthropic", "gemini"] as Protocol[])("honors a bounded long-job deadline through %s, including response body reads", async protocol => {
    const timeout = vi.spyOn(AbortSignal, "timeout")
    const stalled = vi.fn(async (_url, init) => {
      const signal = init!.signal!
      return { ok: true, json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }) } as Response
    }) as unknown as typeof fetch
    try {
      await expect(complete({ ...config, protocol }, "system", "text", stalled, 30)).rejects.toMatchObject({ code: "timeout" })
      expect(timeout).toHaveBeenLastCalledWith(30)
      await complete(config, "system", "text", mock({ choices: [{ message: { content: "ok" } }] }))
      expect(timeout).toHaveBeenLastCalledWith(25_000)
    } finally { timeout.mockRestore() }
  })
  it("rejects partial output and leaves every unmatched item retryable", async () => {
    const result = await translate(config, params, mock({ choices: [{ message: { content: "合并了两句话" } }] }))
    expect(result.results).toHaveLength(0); expect(result.errors).toHaveLength(2)
  })
  it("never returns credential-echoing error bodies", async () => {
    await expect(complete(config, "system", "text", mock({ error: { message: config.apiKey } }, 401))).rejects.toThrow("HTTP 401")
    await expect(complete(config, "system", "text", mock({ error: { message: config.apiKey } }, 401))).rejects.not.toThrow(config.apiKey)
  })
  it("supports selection dictionary responses", async () => {
    const result = await translate(config, { ...params, items: [params.items[0]!], selection: { dictionary: true } }, mock({ choices: [{ message: { content: '{"translation":"你好","alternatives":["您好"]}' } }] }))
    expect(result.results[0]?.details?.alternatives).toEqual(["您好"])
  })
  it("lists models without a model selection", async () => {
    expect(await listModels({ ...config, model: "" }, mock({ data: [{ id: "b" }, { id: "a" }, { id: "a" }] }))).toEqual(["a", "b"])
  })
  it("requires safe endpoints and normalizes copied completion URLs", () => {
    expect(validateProvider({ ...config, baseUrl: "https://provider.example/v1/chat/completions" }).baseUrl).toBe(config.baseUrl)
    expect(() => validateProvider({ ...config, baseUrl: "http://provider.example/v1" })).toThrow("HTTPS")
    expect(() => validateProvider({ ...config, baseUrl: "https://attacker:secret@provider.example/v1" })).toThrow()
    expect(validateProvider({ ...config, baseUrl: "http://127.0.0.1:11434/v1", apiKey: "" }).apiKey).toBe("")
  })
})

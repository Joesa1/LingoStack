// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest"
import { defaultTts, speechChunks, validateTts } from "../src/shared/tts-config"
import { listTtsVoices, synthesize } from "../src/background/tts-provider"
const signal = () => new AbortController().signal
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
afterEach(() => vi.unstubAllGlobals())
it("bounds provider-sized chunks without losing or duplicating text", () => {
  const text = "Hello world. " + "中文🙂".repeat(300) + "。Next sentence."
  const chunks = speechChunks(text)
  expect(chunks.join("")).toBe(text)
  expect(chunks.every(c => Array.from(c).length <= 280)).toBe(true)
})
it("sends Qwen instructions in input and downloads signed audio without credentials", async () => {
  const c = { ...defaultTts("dashscope"), apiKey: "private-test-key" }
  const fetch = vi.fn().mockResolvedValueOnce(json({ output: { audio: { url: "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sample.wav?Signature=x" } } })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
  vi.stubGlobal("fetch", fetch)
  expect(await synthesize(c, "你好。", "zh-CN", signal())).toBe("data:audio/wav;base64,AQID")
  const body = JSON.parse(fetch.mock.calls[0]![1].body)
  expect(body.input.instructions).toContain("conversational")
  expect(body.input.language_type).toBe("Chinese")
  expect(fetch.mock.calls[1]![0]).toMatch(/^https:/)
  expect(fetch.mock.calls[1]![1].headers).toBeUndefined()
  expect(fetch.mock.calls[0]![1].redirect).toBe("error")
})
it("refuses unexpected audio download hosts and leaks no echoed secrets", async () => {
  const c = { ...defaultTts("dashscope"), apiKey: "private-test-key" }
  const fetch = vi.fn().mockResolvedValueOnce(json({ output: { audio: { url: "https://attacker.example/audio.wav" } } })).mockResolvedValueOnce(json({ message: c.apiKey }, 401))
  vi.stubGlobal("fetch", fetch)
  await expect(synthesize(c, "你好", "zh-CN", signal())).rejects.toThrow("非预期")
  expect(fetch).toHaveBeenCalledTimes(1)
  await expect(synthesize(c, "你好", "zh-CN", signal())).rejects.toThrow("HTTP 401")
})
it("escapes Azure SSML and rejects an incompatible language", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2])))
  vi.stubGlobal("fetch", fetch)
  const c = { ...defaultTts("azure"), apiKey: "private-test-key", style: "chat" }
  await synthesize(c, 'A&B <break time="10s"/>', "zh-CN", signal())
  expect(fetch.mock.calls[0]![1].body).toContain("A&amp;B &lt;break")
  expect(fetch.mock.calls[0]![1].body).toContain('style="chat"')
  expect(fetch.mock.calls[0]![1].headers["Ocp-Apim-Subscription-Key"]).toBe(c.apiKey)
  await expect(synthesize(c, "Bonjour", "fr", signal())).rejects.toThrow("语言不符")
  expect(() => validateTts({ ...c, region: "eastus.attacker.example/" })).toThrow("区域")
})
it("decodes MiniMax hex, lists system and custom voices, reports balance errors", async () => {
  const c = { ...defaultTts("minimax"), apiKey: "private-test-key", style: "calm" }
  const fetch = vi.fn().mockResolvedValueOnce(json({ base_resp: { status_code: 0 }, data: { audio: "010203" } })).mockResolvedValueOnce(json({ base_resp: { status_code: 0 }, system_voice: [{ voice_id: "a", voice_name: "A" }], voice_generation: [{ voice_id: "b" }] })).mockResolvedValueOnce(json({ base_resp: { status_code: 1008, status_msg: c.apiKey } }))
  vi.stubGlobal("fetch", fetch)
  expect(await synthesize(c, "你好", "zh-CN", signal())).toBe("data:audio/mpeg;base64,AQID")
  expect(JSON.parse(fetch.mock.calls[0]![1].body).voice_setting.emotion).toBe("calm")
  expect((await listTtsVoices(c)).voices.map(v => v.id)).toEqual(["a", "b"])
  await expect(synthesize(c, "你好", "zh-CN", signal())).rejects.toThrow("余额不足")
})
it("forwards cancellation and rejects corrupt audio", async () => {
  const controller = new AbortController()
  const fetch = vi.fn(async (_url, init) => { expect(init.signal).toBe(controller.signal); throw new DOMException("Aborted", "AbortError") })
  vi.stubGlobal("fetch", fetch); controller.abort()
  await expect(synthesize({ ...defaultTts("minimax"), apiKey: "x" }, "你好", "zh-CN", controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ base_resp: { status_code: 0 }, data: { audio: "not audio" } })))
  await expect(synthesize({ ...defaultTts("minimax"), apiKey: "x" }, "你好", "zh-CN", signal())).rejects.toThrow("有效音频")
})

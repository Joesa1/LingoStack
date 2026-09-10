import { LANGUAGES } from "./settings-store"
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
export async function rpc<T = any>(type: string, data: Record<string, unknown> = {}): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ type, ...data })
  if (reply === undefined || reply === null) throw new Error("扩展未返回结果，请在扩展管理页重新加载译伴后重试。")
  if (reply?.error) throw new Error(reply.error)
  return reply
}
export function languages(select: HTMLSelectElement) {
  for (const [value, text] of Object.entries(LANGUAGES)) select.add(new Option(text, value))
}
export function status(message: string, error = false) {
  const el = $("status"); el.textContent = message; el.dataset.error = String(error)
}
export async function busy(button: HTMLButtonElement, task: () => Promise<void>) {
  button.disabled = true
  try { await task() } catch (error) { status(error instanceof Error ? error.message : "操作失败，请重试。", true) }
  finally { button.disabled = false }
}

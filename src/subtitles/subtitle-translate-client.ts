/**
 * Promise-based Port client for the subtitle pipeline: speaks the SAME
 * `TR_TRANSLATE` / `TR_TRANSLATE_PARTIAL` protocol as the page-translate
 * client, so the background batcher / cache / retry / extension RPC path is
 * reused with zero background changes (§7.9). Unlike `translate-client.ts`
 * it resolves per-item promises instead of rendering DOM units — subtitle
 * cues live on a timeline, not in the page DOM.
 *
 * Generation semantics: `bumpGeneration()` on toggle-off / video navigation;
 * late results tagged with an older generation reject their pending promises
 * as stale (callers drop them silently).
 *
 * Based on: docs/packages/web-translate/README.md §7.7, §7.9 (D17).
 */
import type {
  TranslateItemError,
  TrTranslateMessage,
  TrTranslatePartialMessage,
} from "../shared/types"

export type SubtitleTranslateResult =
  | { id: string; text: string }
  | { id: string; error: TranslateItemError }

export type SubtitleTranslateClientDeps = {
  connect: () => chrome.runtime.Port
}

export type SubtitleTranslateContext = {
  targetLang: string
  /** The caption track's language (participates in cache key + batch partition). */
  sourceLang?: string
  /** Video title for prompt context (same role as pageTitle on the page path). */
  pageTitle?: string
}

export type SubtitleTranslateClient = {
  bumpGeneration(): void
  /**
   * Translate a batch of cue texts. Resolves with one result per item
   * (success or per-item error) once every item settled. Rejects only when
   * the results can no longer apply: generation bumped or the Port dropped.
   */
  translate(items: { id: string; text: string }[], context: SubtitleTranslateContext): Promise<SubtitleTranslateResult[]>
  disconnect(): void
}

type PendingRequest = {
  generation: number
  expected: number
  results: SubtitleTranslateResult[]
  resolve: (results: SubtitleTranslateResult[]) => void
  reject: (error: Error) => void
}

function isTranslatePartialMessage(message: unknown): message is TrTranslatePartialMessage {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "TR_TRANSLATE_PARTIAL"
}

export function createSubtitleTranslateClient(deps: SubtitleTranslateClientDeps): SubtitleTranslateClient {
  let generation = 0
  let requestCounter = 0
  let port: chrome.runtime.Port | undefined
  const pending = new Map<string, PendingRequest>()

  function handleMessage(message: unknown): void {
    if (!isTranslatePartialMessage(message)) return
    const request = pending.get(message.requestId)
    if (request === undefined) return

    if (request.generation !== generation) {
      pending.delete(message.requestId)
      request.reject(new Error("stale generation"))
      return
    }

    for (const result of message.results ?? []) request.results.push({ id: result.id, text: result.text })
    for (const error of message.errors ?? []) request.results.push({ id: error.id, error })

    if (request.results.length >= request.expected) {
      pending.delete(message.requestId)
      request.resolve(request.results)
    }
  }

  function failAllPending(reason: string): void {
    const requests = [...pending.values()]
    pending.clear()
    for (const request of requests) request.reject(new Error(reason))
  }

  function ensurePort(): chrome.runtime.Port {
    if (port !== undefined) return port
    const p = deps.connect()
    p.onMessage.addListener(handleMessage)
    p.onDisconnect.addListener(() => {
      if (port !== p) return // replaced or torn down intentionally
      port = undefined
      failAllPending("translate port disconnected")
    })
    port = p
    return p
  }

  return {
    bumpGeneration() {
      generation += 1
      const p = port
      port = undefined
      p?.disconnect()
      failAllPending("stale generation")
    },
    translate(items, context) {
      if (items.length === 0) return Promise.resolve([])
      const requestId = `sub-r${++requestCounter}`
      return new Promise<SubtitleTranslateResult[]>((resolve, reject) => {
        pending.set(requestId, { generation, expected: items.length, results: [], resolve, reject })
        const message: TrTranslateMessage = {
          type: "TR_TRANSLATE",
          requestId,
          generation,
          targetLang: context.targetLang,
          ...(context.sourceLang !== undefined ? { sourceLang: context.sourceLang } : {}),
          // Render-only field on this path (D11: prompt/cache are mode-independent).
          mode: "bilingual",
          units: items,
          ...(context.pageTitle !== undefined ? { pageTitle: context.pageTitle } : {}),
        }
        try {
          ensurePort().postMessage(message)
        } catch (error) {
          pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    disconnect() {
      const p = port
      port = undefined // clear first so onDisconnect's `port !== p` guard skips failAllPending
      p?.disconnect()
      failAllPending("client disconnected")
    },
  }
}

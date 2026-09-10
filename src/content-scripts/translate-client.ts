/**
 * Content-side Port client: submits units for translation over a long-lived
 * `chrome.runtime.connect` Port and applies progressive results as they
 * arrive, dropping any result tagged with a stale `generation` (README §7.7
 * — mode/targetLang/toggle changes bump the generation; whatever OTHER code
 * path caused that bump is responsible for re-rendering the affected units
 * fresh, so a dropped stale result never orphans a unit stuck at "loading":
 * a mode/lang change re-submits it under the new generation, and toggling
 * off calls `restoreAll()` regardless of generation).
 * A generation bump also disconnects the old Port, which ends its background
 * page session so stale queued work cannot continue spending provider quota.
 *
 * Every DOM write here (`renderLoading`/`renderDone`/`renderError`) runs
 * inside the injected `withPaused`, so the MutationObserver never sees these
 * as new translatable content (README §7.3).
 *
 * Based on: docs/packages/web-translate/README.md §7.7
 */
import type {
  TranslateItemError,
  TranslateMode,
  TrTranslateMessage,
  TrTranslatePartialMessage,
} from "../shared/types"

import { normalizeText } from "../shared/text-normalize"
import { renderDone, renderError, renderLoading, renderSameAsSource } from "./backfill"
import type { TranslationUnit } from "./walker"

export type TranslateContext = {
  targetLang: string
  sourceLang?: string
  mode: TranslateMode
  skipCache?: boolean
  pageTitle?: string
}

export type TranslateClientDeps = {
  connect: () => chrome.runtime.Port
  withPaused: <T>(fn: () => T) => T
}

export type TranslateClient = {
  /** Mode/targetLang/toggle changed — later results tagged with an older generation get dropped on arrival. */
  bumpGeneration(): number
  getGeneration(): number
  /** Submit a batch of units for translation. Renders loading immediately (paused), then done/error progressively. No-op for an empty batch. */
  submit(units: TranslationUnit[], context: TranslateContext): void
  /** Re-submit a unit that previously rendered an error (the error chip's click target). No-op for an unknown id or after a generation change (the mode/lang switch already re-rendered everything). */
  retryUnit(unitId: string): void
  disconnect(): void
}

type PendingEntry = { unit: TranslationUnit; context: TranslateContext; generation: number }

function isTranslatePartialMessage(message: unknown): message is TrTranslatePartialMessage {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "TR_TRANSLATE_PARTIAL"
}

export function createTranslateClient(deps: TranslateClientDeps): TranslateClient {
  let generation = 0
  let requestCounter = 0
  let port: chrome.runtime.Port | undefined
  const pendingByRequest = new Map<string, Map<string, PendingEntry>>()
  // Units that rendered an error chip, kept so a chip click can re-submit
  // them (the chip is the ONLY holder of retry affordance in the DOM, but the
  // DOM cannot store the live TranslationUnit/context). Cleared on
  // generation bumps — a mode/lang switch re-renders everything anyway.
  const failedById = new Map<string, PendingEntry>()

  function handlePartial(message: unknown): void {
    if (!isTranslatePartialMessage(message)) return
    const byId = pendingByRequest.get(message.requestId)
    if (byId === undefined) return

    const results = message.results ?? []
    const errors: TranslateItemError[] = message.errors ?? []
    deps.withPaused(() => {
      for (const result of results) {
        const entry = byId.get(result.id)
        if (entry === undefined) continue
        byId.delete(result.id)
        if (entry.generation !== generation) continue
        failedById.delete(result.id)
        // Model echoed the source (already-target-language text past the
        // fail-open filter) — showing it would duplicate the line (#1684).
        // sourceText is already normalized by the walker.
        if (normalizeText(result.text) === entry.unit.sourceText) {
          renderSameAsSource(entry.unit)
        } else {
          renderDone(entry.unit, entry.context.mode, result.text, entry.context.targetLang)
        }
      }
      for (const error of errors) {
        const entry = byId.get(error.id)
        if (entry === undefined) continue
        byId.delete(error.id)
        if (entry.generation !== generation) continue
        failedById.set(error.id, entry)
        renderError(entry.unit, entry.context.mode, { code: error.code, message: error.message })
      }
    })

    if (message.done === true) pendingByRequest.delete(message.requestId)
  }

  /**
   * A port dropped by the OTHER end (SW recycle, extension reload) fires this
   * listener; a local `api.disconnect()` clears `port` first, so `port !== p`
   * skips the fail path there. On an unexpected drop the in-flight results
   * will never arrive, so current-generation pending units — which would
   * otherwise spin at "loading" forever — become retryable error chips.
   * Stale-generation entries were already re-rendered by the mode/lang switch
   * that bumped the generation, so they are just cleared.
   */
  function failCurrentGenerationPending(): void {
    const entries: PendingEntry[] = []
    for (const byId of pendingByRequest.values()) {
      for (const entry of byId.values()) {
        if (entry.generation === generation) entries.push(entry)
      }
    }
    pendingByRequest.clear()
    if (entries.length === 0) return
    deps.withPaused(() => {
      for (const entry of entries) {
        failedById.set(entry.unit.id, entry)
        renderError(entry.unit, entry.context.mode, { code: "connection_lost", message: "翻译连接中断，点击重试" })
      }
    })
  }

  function ensurePort(): chrome.runtime.Port {
    if (port !== undefined) return port
    const p = deps.connect()
    p.onMessage.addListener(handlePartial)
    p.onDisconnect.addListener(() => {
      if (port !== p) return // already replaced or torn down intentionally
      port = undefined
      failCurrentGenerationPending()
    })
    port = p
    return p
  }

  function endPageSession(): void {
    const p = port
    port = undefined // clear first so the onDisconnect listener skips the unexpected-drop error path
    p?.disconnect()
    pendingByRequest.clear()
  }

  const api: TranslateClient = {
    bumpGeneration() {
      generation += 1
      endPageSession()
      failedById.clear()
      return generation
    },
    getGeneration() {
      return generation
    },
    submit(units, context) {
      if (units.length === 0) return
      const requestId = `r${++requestCounter}`
      const byId = new Map<string, PendingEntry>(units.map((unit) => [unit.id, { unit, context, generation }]))
      pendingByRequest.set(requestId, byId)

      deps.withPaused(() => {
        for (const unit of units) renderLoading(unit, context.mode)
      })

      const message: TrTranslateMessage = {
        type: "TR_TRANSLATE",
        requestId,
        generation,
        targetLang: context.targetLang,
        ...(context.sourceLang !== undefined ? { sourceLang: context.sourceLang } : {}),
        mode: context.mode,
        units: units.map((unit) => ({ id: unit.id, text: unit.sourceText })),
        ...(context.skipCache === true ? { skipCache: true } : {}),
        ...(context.pageTitle !== undefined ? { pageTitle: context.pageTitle } : {}),
      }
      ensurePort().postMessage(message)
    },
    retryUnit(unitId) {
      const entry = failedById.get(unitId)
      if (entry === undefined) return
      failedById.delete(unitId)
      if (entry.generation !== generation) return
      api.submit([entry.unit], entry.context)
    },
    disconnect() {
      endPageSession()
      failedById.clear()
    },
  }
  return api
}

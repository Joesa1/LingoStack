/**
 * Background message bridge: the content script's two entry points into the
 * translate pipeline (T7's `TranslateBatcher`).
 *
 * - `TR_TRANSLATE` (long-lived Port, named `lingo-translate`): a batch of units
 *   for one tab. Each unit resolves independently through the batcher (which
 *   does its own cache/dedup/partition-batching underneath); as each one
 *   settles, a `TR_TRANSLATE_PARTIAL` is pushed back immediately — this is
 *   what makes translation progressive rather than "wait for the whole page".
 *   The LAST settling unit's message carries `done: true`.
 *   Each Port is also the page-session cancellation boundary: disconnecting it
 *   aborts that subscriber's pending batcher work without touching selection
 *   requests or another Port sharing the same in-flight cache key.
 * - `TR_SELECTION_TRANSLATE` (one-shot `chrome.runtime.sendMessage`): the
 *   selection toolbar's single blob of text, answered once (no Port, no
 *   progressive results needed for one string).
 *
 * Based on: docs/packages/web-translate/README.md §7.7
 */
import { LANGUAGES } from "../shared/settings-store"
import type {
  TranslateItemError,
  TrSelectionTranslateMessage,
  TrSelectionTranslateReply,
  TrTranslateMessage,
  TrTranslatePartialMessage,
} from "../shared/types"

import type { PageTranslationSession, TranslateBatcher, UnitResult } from "./translate-batcher"

function toInternalErrorResult(id: string, error: unknown): UnitResult {
  return { id, error: { code: "internal_error", message: error instanceof Error ? error.message : "Translate request failed." } }
}

export const TRANSLATE_PORT_NAME = "lingo-translate"

type MinimalSender = { tab?: { id?: number }; frameId?: number; documentId?: string; origin?: string; url?: string }

type MinimalPort = {
  name: string
  sender?: MinimalSender
  postMessage(message: unknown): void
  onMessage: { addListener(cb: (message: unknown) => void): void }
  onDisconnect: { addListener(cb: () => void): void }
}

type MinimalRuntimeConnect = { onConnect: { addListener(cb: (port: MinimalPort) => void): void } }
type MinimalRuntimeMessage = {
  onMessage: {
    addListener(cb: (message: unknown, sender: unknown, sendResponse: (reply: unknown) => void) => boolean | void): void
  }
}

let anonymousSenderCounter = 0
let pageSessionCounter = 0

type SenderIdentity = { senderKey: string; cacheScope: string }

function originOf(sender: MinimalSender | undefined): string | undefined {
  if (typeof sender?.origin === "string" && sender.origin !== "" && sender.origin !== "null") return sender.origin
  if (typeof sender?.url === "string" && sender.url !== "") {
    try {
      return new URL(sender.url).origin
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Two identities from one sender:
 * - `senderKey` (document-granular) partitions wire batches — `documentId`
 *   when Chrome reports one, else `tab:<id>:frame:<id>`, else a per-connection
 *   anon id. Every real frame gets its own, so no two documents' `u1` units
 *   share a batch.
 * - `cacheScope` (origin-granular) scopes the cache + in-flight dedup — the
 *   frame's origin so same-origin pages/tabs still share, falling back to the
 *   document key (no cross-document sharing) when no origin is available.
 */
function senderIdentityFor(sender: MinimalSender | undefined): SenderIdentity {
  const documentId = sender?.documentId
  const tabId = sender?.tab?.id
  let senderKey: string
  if (typeof documentId === "string" && documentId !== "") senderKey = `doc:${documentId}`
  else if (tabId !== undefined) senderKey = `tab:${tabId}:frame:${sender?.frameId ?? 0}`
  else senderKey = `anon:${++anonymousSenderCounter}`
  return { senderKey, cacheScope: originOf(sender) ?? senderKey }
}

function validLanguage(value: unknown): boolean { return typeof value === "string" && value in LANGUAGES }
function isTrTranslateMessage(message: unknown): message is TrTranslateMessage {
  if (!message || typeof message !== "object") return false
  const m = message as TrTranslateMessage
  return m.type === "TR_TRANSLATE" && typeof m.requestId === "string" && Number.isInteger(m.generation)
    && validLanguage(m.targetLang) && (m.mode === "bilingual" || m.mode === "only")
    && Array.isArray(m.units) && m.units.length <= 5000
    && m.units.every(u => u && typeof u.id === "string" && typeof u.text === "string" && u.text.length <= 20_000)
    && (m.sourceLang === undefined || typeof m.sourceLang === "string")
    && (m.pageTitle === undefined || typeof m.pageTitle === "string")
}
function isSelectionTranslateMessage(message: unknown): message is TrSelectionTranslateMessage {
  if (!message || typeof message !== "object") return false
  const m = message as TrSelectionTranslateMessage
  if (!(m.type === "TR_SELECTION_TRANSLATE" && typeof m.text === "string" && m.text.length <= 5000 && validLanguage(m.targetLang) && (m.mode === "bilingual" || m.mode === "only"))) return false
  if (m.selection === undefined) return true
  if (!m.selection || typeof m.selection.dictionary !== "boolean") return false
  const c = m.selection.context
  return c === undefined || (typeof c.text === "string" && c.text.length <= 800 && Number.isInteger(c.selectionStart) && Number.isInteger(c.selectionEnd) && c.selectionStart >= 0 && c.selectionEnd > c.selectionStart && c.text.slice(c.selectionStart, c.selectionEnd) === m.text)
}

function safePost(port: MinimalPort, isDisconnected: () => boolean, message: TrTranslatePartialMessage): void {
  if (isDisconnected()) return
  try {
    port.postMessage(message)
  } catch {
    // The port died between the disconnect check and postMessage — nothing more to do.
  }
}

async function handleTranslateMessage(
  port: MinimalPort,
  message: TrTranslateMessage,
  batcher: TranslateBatcher,
  isDisconnected: () => boolean,
  identity: SenderIdentity,
  pageSession: PageTranslationSession,
): Promise<void> {
  const context = {
    targetLang: message.targetLang,
    sourceLang: message.sourceLang,
    mode: message.mode,
    skipCache: message.skipCache,
    pageTitle: message.pageTitle,
    senderKey: identity.senderKey,
    cacheScope: identity.cacheScope,
    pageSession,
  }
  if (message.units.length === 0) {
    safePost(port, isDisconnected, { type: "TR_TRANSLATE_PARTIAL", requestId: message.requestId, generation: message.generation, done: true })
    return
  }
  let remaining = message.units.length
  for (const unit of message.units) {
    // `batcher.translate()` is documented never to reject, but the router
    // settles every unit regardless — a defensive backstop, not the primary
    // fix — so a future/foreign batcher implementation can't strand a unit
    // in "loading" forever.
    void batcher
      .translate(unit, context)
      .catch((error) => toInternalErrorResult(unit.id, error))
      .then((result) => {
        remaining -= 1
        const partial: TrTranslatePartialMessage = {
          type: "TR_TRANSLATE_PARTIAL",
          requestId: message.requestId,
          generation: message.generation,
          ...("text" in result ? { results: [{ id: result.id, text: result.text }] } : { errors: [{ id: result.id, ...result.error }] }),
          ...(remaining === 0 ? { done: true } : {}),
        }
        safePost(port, isDisconnected, partial)
      })
  }
}

/** Register the `lingo-translate` Port handler. `runtime` is injected (`chrome.runtime`) for testability. */
export function registerTranslatePort(runtime: MinimalRuntimeConnect, batcher: TranslateBatcher): void {
  runtime.onConnect.addListener((port) => {
    if (port.name !== TRANSLATE_PORT_NAME) return
    let disconnected = false
    const identity = senderIdentityFor(port.sender)
    const controller = new AbortController()
    const pageSession: PageTranslationSession = {
      key: `${identity.senderKey}:session:${++pageSessionCounter}`,
      signal: controller.signal,
    }
    port.onDisconnect.addListener(() => {
      disconnected = true
      controller.abort()
    })
    port.onMessage.addListener((message) => {
      if (disconnected || !isTrTranslateMessage(message)) return
      void handleTranslateMessage(port, message, batcher, () => disconnected, identity, pageSession)
    })
  })
}

let selectionUnitCounter = 0

async function handleSelectionTranslate(
  message: TrSelectionTranslateMessage,
  batcher: TranslateBatcher,
  identity: SenderIdentity,
): Promise<TrSelectionTranslateReply> {
  const id = `sel${++selectionUnitCounter}`
  // No pageTitle on the selection path (privacy): the user selected a phrase,
  // not the page — the full document.title must not ride along into the
  // system prompt.
  // Same defensive backstop as handleTranslateMessage above: batcher.translate()
  // is documented never to reject, but a settled error reply here (instead of
  // a dropped sendResponse) is what keeps the toolbar bubble out of a
  // permanent "Translating…" state on an unexpected throw.
  const result = await batcher
    .translate({ id, text: message.text }, {
      targetLang: message.targetLang,
      mode: message.mode,
      ...(message.selection !== undefined ? { selection: message.selection } : {}),
      senderKey: identity.senderKey,
      cacheScope: identity.cacheScope,
    })
    .catch((error) => toInternalErrorResult(id, error))
  if ("text" in result) {
    return {
      ok: true,
      text: result.text,
      ...(result.details !== undefined ? { details: result.details } : {}),
    }
  }
  const error: TranslateItemError = { id: result.id, code: result.error.code, message: result.error.message }
  return { ok: false, error }
}

/** Register the one-shot `TR_SELECTION_TRANSLATE` handler. `runtime` is injected (`chrome.runtime`) for testability. */
export function registerSelectionTranslateHandler(runtime: MinimalRuntimeMessage, batcher: TranslateBatcher): void {
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isSelectionTranslateMessage(message)) return undefined
    void handleSelectionTranslate(message, batcher, senderIdentityFor(sender as MinimalSender | undefined)).then(sendResponse)
    return true // keep the message channel open for the async sendResponse
  })
}

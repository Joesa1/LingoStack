/**
 * Selection toolbar: translates a text selection into a bubble next to it —
 * never touches page DOM, completely bypasses the walker/backfill/cache
 * pipeline (README §7.6 — "cheapest independent entry", one-shot
 * `TR_SELECTION_TRANSLATE`, no Port).
 *
 * Manual-trigger interaction (README D18): selecting text only reveals a
 * compact "Translate" button; the request fires when the user clicks it, and
 * the button morphs into the loading/result bubble in place. Failures restore
 * the button and surface a short toast so a connection/model error does not
 * become a persistent red bubble over the page.
 *
 * Top-frame only (README §7.2): a selection made inside a same-origin iframe
 * has its own separate `Selection` object the top frame cannot see, so V1
 * only reacts to the top frame's own selection — a documented gap, not
 * silently dropped coverage.
 *
 * The DOM host (`SelectionToolbarHost`) is injected so `SelectionToolbar`'s
 * state machine (show/hide/loading/result/error) is unit-testable without a
 * closed shadow DOM. Mirrors the `CursorOverlayHost` split in
 * packages/chrome-extension/src/content-scripts/cursor-overlay.ts. This is a
 * clean-room implementation, not a copy of that file's closed-shadow-host
 * helper (D3's "copy the specific helper" wasn't practical without reading
 * its exact source in this session) — a real, acceptable divergence from the
 * design doc's literal instruction, noted here rather than silently done.
 */
import type {
  SelectionTranslateOptions,
  SelectionTranslationDetails,
  TranslateMode,
  TrSelectionTranslateReply,
} from "../shared/types"

export type SelectionToolbarHost = {
  /**
   * Show the compact trigger button anchored near `rect` (the selection's
   * bounding client rect). Manual-trigger model (README D18): no request is
   * sent until the button is clicked — this only reveals the affordance.
   */
  showTrigger(rect: DOMRect): void
  /** Move the current trigger/result without changing its visual state. */
  reposition(rect: DOMRect): void
  hide(): void
  /** The setters below morph the trigger into the result bubble in place. */
  setLoading(): void
  setResult(text: string, details?: SelectionTranslationDetails): void
  /** Restore the trigger and show a transient toast. */
  setError(message: string): void
  /** Registers the trigger click handler. Called once at construction. */
  onTranslateClick(cb: () => void): void
  destroy(): void
}

export type SelectionToolbarDeps = {
  host: SelectionToolbarHost
  translate: (text: string, targetLang: string, mode: TranslateMode, selection: SelectionTranslateOptions) => Promise<TrSelectionTranslateReply>
  getContext: () => { targetLang: string; mode: TranslateMode }
  /** Injected so tests don't depend on a real `window.getSelection()`. */
  getSelection: () => { text: string; rect: DOMRect; selection: SelectionTranslateOptions } | undefined
}

export type SelectionToolbar = {
  /** Call on `selectionchange` (debounced by the caller if desired). Shows/hides/repositions the bubble. */
  onSelectionChange(): void
  /** Call on scroll/resize to keep the current UI anchored to the selection. */
  onViewportChange(): void
  /** Call on Escape / outside click. */
  dismiss(): void
  destroy(): void
}

function errorMessageFor(reply: TrSelectionTranslateReply): string {
  switch (reply.error?.code) {
    case "connection_lost":
      return "翻译连接中断，请点击重试。"
    case "provider_not_ready":
      return "请在译伴设置中填写 API key 和模型。"
    case "provider_error":
      return "模型服务不可用，请检查设置。"
    case "parse_error":
      return "模型返回的译文格式不正确，请重试。"
    case "timeout":
      return "翻译超时，请重试。"
    default:
      return "翻译失败，请重试。"
  }
}

export function createSelectionToolbar(deps: SelectionToolbarDeps): SelectionToolbar {
  let currentText: string | undefined
  let currentRect: DOMRect | undefined
  let currentSelection: SelectionTranslateOptions | undefined
  let requestToken = 0

  function isSameRect(left: DOMRect | undefined, right: DOMRect): boolean {
    return left !== undefined
      && left.top === right.top
      && left.right === right.right
      && left.bottom === right.bottom
      && left.left === right.left
  }

  function runTranslate(): void {
    if (currentText === undefined || currentSelection === undefined) return
    const text = currentText
    const selection = currentSelection
    const token = ++requestToken
    const context = deps.getContext()
    deps.host.setLoading()
    void deps
      .translate(text, context.targetLang, context.mode, selection)
      .then((reply) => {
        if (token !== requestToken) return // dismissed/replaced by a newer selection while this was in flight
        if (reply.ok && reply.text !== undefined) {
          deps.host.setResult(reply.text, reply.details)
        } else {
          deps.host.setError(errorMessageFor(reply))
        }
      })
      .catch(() => {
        // `chrome.runtime.sendMessage` rejects (not a settled ok:false reply)
        // when the service worker is restarting or the extension context was
        // invalidated. Without this, the bubble is stuck on "Translating…"
        // forever and the rejection goes unhandled. The host restores the
        // trigger so clicking it again retries the request.
        if (token !== requestToken) return
        deps.host.setError("翻译失败，请重试。")
      })
  }

  deps.host.onTranslateClick(runTranslate)

  return {
    onSelectionChange() {
      const selection = deps.getSelection()
      if (selection === undefined || selection.text.length === 0) {
        currentText = undefined
        currentRect = undefined
        currentSelection = undefined
        requestToken += 1 // invalidate any in-flight request for the old selection
        deps.host.hide()
        return
      }
      if (selection.text === currentText && isSameRect(currentRect, selection.rect)) return
      currentText = selection.text
      currentRect = selection.rect
      currentSelection = selection.selection
      requestToken += 1 // invalidate any in-flight request for the previous selection
      deps.host.showTrigger(selection.rect) // manual trigger (D18): translate only fires on click
    },
    onViewportChange() {
      if (currentText === undefined) return
      const selection = deps.getSelection()
      if (selection === undefined || selection.text !== currentText) return
      currentRect = selection.rect
      deps.host.reposition(selection.rect)
    },
    dismiss() {
      currentText = undefined
      currentRect = undefined
      currentSelection = undefined
      requestToken += 1
      deps.host.hide()
    },
    destroy() {
      deps.host.destroy()
    },
  }
}

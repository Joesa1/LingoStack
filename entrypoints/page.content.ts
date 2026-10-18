/**
 * Web Translate content script.
 *
 * Declarative injection (`matches`/`allFrames`/`runAt`, no `registration:
 * "runtime"` override) — unlike Chrome Control's on-demand injection, every
 * page needs the walker/backfill logic available immediately for full-page
 * translate to work (README §10).
 *
 * Walker/backfill/observer/full-page-mode run in every frame (README §7.2:
 * each frame translates its own content). The selection toolbar is gated to
 * the top frame only (§7.2), and so is the `TR_GET_PAGE_STATE` responder —
 * the top frame's mode IS the tab's translate state (D8), and a single
 * responder avoids multiple frames racing to answer.
 *
 * Translation is per-tab and manual (D8): a fresh page always starts "off"
 * and only a user action (context menu / popup / Alt+T) flips it via a
 * background-sent TR_SET_MODE. There is deliberately no settings catch-up
 * that auto-applies a mode on load.
 *
 * Orphaned-script handling (extension reload, README §7.8): an
 * already-injected copy of this script survives an extension reload with
 * dead chrome.* APIs ("Extension context invalidated"). Every DOM listener
 * goes through `ctx.addEventListener` (auto-removed on invalidation), every
 * event/observer entry point checks `ctx.isInvalid` (which also TRIGGERS
 * WXT's teardown), all submit paths go through a guarded client wrapper, and
 * `ctx.onInvalidated` disconnects the observers and removes the injected UI.
 *
 * Based on: docs/packages/web-translate/README.md §7.2, §7.6, §7.7, §7.8, §10, D8
 */
import type { TrPageStateReply, TrSettingsReply } from "../src/shared/types"

import { readChangedSettings, parseSettings } from "../src/shared/settings-store"
import { TRANSLATE_PORT_NAME } from "../src/background/message-router"
import { ensureStyleInjected } from "../src/content-scripts/backfill"

import { chromeDetectLanguage, createLanguageFilter } from "../src/content-scripts/language-filter"
import { createMutationWatcher } from "../src/content-scripts/mutation-watcher"
import { createPageModeClient, isSetModeMessage, readPageTitle } from "../src/content-scripts/page-mode-client"
import { selectionOptionsFor } from "../src/content-scripts/selection-context"
import { createSelectionToolbar } from "../src/content-scripts/selection-toolbar"
import { createSelectionToolbarHost } from "../src/content-scripts/selection-toolbar-host"
import { resolveSiteRules } from "../src/content-scripts/site-rules"
import { createTranslateClient, type TranslateContext } from "../src/content-scripts/translate-client"
import { createViewportScheduler, domObserverFactory } from "../src/content-scripts/viewport-scheduler"
import { createDomWalker } from "../src/content-scripts/walker"


const SELECTION_DEBOUNCE_MS = 150
/** A selection only translates if a trusted pointerup/keyup landed within this window — a page script driving `document.getSelection()` programmatically can't forge a trusted gesture, so it can't spend the user's provider quota. */
const SELECTION_GESTURE_WINDOW_MS = 2_000
/** Selection translate is a quick word/phrase lookup; a selection beyond this is likely abuse (or would be slow as one un-chunked unit) — the bubble stays hidden. */
const SELECTION_MAX_CHARS = 5_000
/** A selection anchored inside an editable region is the user's own draft — never send it to the provider. */
const EDITABLE_SELECTION_SELECTOR = '[contenteditable]:not([contenteditable="false"]), [role="textbox"], input, textarea, select'

function isEditableSelection(selection: Selection): boolean {
  const node = selection.getRangeAt(0).commonAncestorContainer
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement
  return el !== null && el.closest(EDITABLE_SELECTION_SELECTOR) !== null
}

function isGetPageStateMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "TR_GET_PAGE_STATE"
}

export default defineContentScript({
  matches: ["<all_urls>"],
  allFrames: true,
  runAt: "document_idle",
  main(ctx) {
    const isTopFrame = window.top === window

    const walker = createDomWalker()
    const languageFilter = createLanguageFilter({ detect: chromeDetectLanguage })
    const scheduler = createViewportScheduler({ createObserver: domObserverFactory })
    // Resolved once from this frame's own hostname (§7.1a) — none of the
    // built-in site rules are path-scoped, so no need to re-resolve per walk
    // or on SPA route changes within the same host.
    const siteRules = resolveSiteRules(location.hostname)
    ensureStyleInjected(document)

    // Tracks the user's language preference independent of whether this page
    // is translated — the selection toolbar needs it even when `pageMode` is
    // "off". Seeded from TR_GET_SETTINGS, then kept live by both TR_SET_MODE
    // and chrome.storage.onChanged.
    let preferredTargetLang = "zh-CN"
    // Selection-toolbar toggle (extension-local preference). Seeded from
    // TR_GET_SETTINGS and kept live via chrome.storage.onChanged.
    let selectionEnabled = true

    const client = createTranslateClient({
      connect: () => chrome.runtime.connect({ name: TRANSLATE_PORT_NAME }),
      withPaused: (fn) => watcher.withPaused(fn),
    })

    // Orphaned-script protection: after an extension reload, this script keeps
    // living in already-open tabs with its chrome.* APIs dead ("Extension
    // context invalidated"). `ctx.isInvalid` both detects that state and
    // triggers WXT's invalidation teardown (which fires onInvalidated below
    // and aborts every ctx.addEventListener). All submit paths go through
    // this wrapper — chrome.runtime.connect is the throw site.
    const guardedClient: typeof client = {
      ...client,
      submit: (units, context) => {
        if (ctx.isInvalid) return
        client.submit(units, context)
      },
      retryUnit: (unitId) => {
        if (ctx.isInvalid) return
        client.retryUnit(unitId)
      },
    }

    const watcher = createMutationWatcher({
      walker,
      siteRules,
      getTargetLang: () => pageMode.getTargetLang(),
      onUnitsDiscovered: (units) => {
        if (ctx.isInvalid) return // orphaned after an extension reload — MutationObserver outlives the runtime
        const mode = pageMode.getMode()
        if (mode === "off") return
        const generation = client.getGeneration()
        // Snapshot once per discovery batch, not inside the (possibly
        // repeatedly-firing) scheduler callback — see page-mode-client.ts's
        // applyMode for why a live re-read would fragment the batch/cache key.
        const pageTitle = readPageTitle(document)
        void languageFilter.filterUnits(units, pageMode.getTargetLang()).then((kept) => {
          if (client.getGeneration() !== generation) return // mode/lang changed mid-filter
          // Mutation-discovered units go through the viewport scheduler too —
          // SPA-appended content far below the fold waits until scrolled near.
          scheduler.schedule(kept, (visible) => {
            if (client.getGeneration() !== generation) return
            guardedClient.submit(visible, {
              targetLang: pageMode.getTargetLang(),
              mode,
              pageTitle,
            })
          })
        })
      },
    })

    const pageMode = createPageModeClient({ walker, client: guardedClient, watcher, languageFilter, scheduler, root: document, siteRules })

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (isGetPageStateMessage(message)) {
        if (!isTopFrame) return undefined // only the top frame speaks for the tab
        sendResponse({ mode: pageMode.getMode() } satisfies TrPageStateReply)
        return undefined // responded synchronously
      }
      if (!isSetModeMessage(message)) return undefined
      const targetLang = message.targetLang ?? pageMode.getTargetLang()
      preferredTargetLang = targetLang
      pageMode.applyMode(message.mode, targetLang, message.skipCache)
      return undefined
    })

    // Error-chip retry (README §7.4: "error 可点/回车重排队"). Every frame
    // wires its own document — units live in the frame that walked them.
    const retryFromEvent = (event: Event): void => {
      if (ctx.isInvalid) return
      const target = event.target
      if (!(target instanceof Element)) return
      const chip = target.closest('[data-lingo-tr-wrapper][data-lingo-tr-state="error"]')
      const unitId = chip?.getAttribute("data-lingo-tr-for")
      if (unitId == null) return
      event.preventDefault()
      guardedClient.retryUnit(unitId)
    }
    ctx.addEventListener(document, "click", retryFromEvent)
    ctx.addEventListener(document, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") retryFromEvent(event)
    })

    function applyTranslationColor(raw: unknown) {
      const settings = parseSettings(raw)
      document.documentElement.style.setProperty("--lingo-translation-color", settings.translationColorMode === "custom" ? settings.translationColor : "inherit")
    }

    // Seed the language preference for the selection toolbar (a fresh page is
    // always mode "off" — D8 — so no mode is applied here).
    chrome.runtime
      .sendMessage({ type: "TR_GET_SETTINGS" })
      .then((reply: TrSettingsReply | undefined) => {
        if (reply === undefined) return
        applyTranslationColor(reply)
        preferredTargetLang = reply.targetLang
        selectionEnabled = reply.selectionEnabled
      })
      .catch(() => {
        // Background not ready yet (extension just installed/updated) — the
        // first TR_SET_MODE this tab receives still carries targetLang.
      })

    chrome.storage.onChanged.addListener((changes, area) => {
      const next = readChangedSettings(changes, area)
      if (next === undefined) return
      applyTranslationColor(next)
      preferredTargetLang = next.targetLang
      selectionEnabled = next.selectionEnabled
    })

    if (isTopFrame) {
      // First layer of the selection abuse gate (README D18): the trigger
      // button only appears after a real user gesture, so a page script that
      // mutates document.getSelection() can't even flash the UI. The request
      // itself needs a trusted click on the button (checked in the host) — a
      // trusted pointerup/keyup/click can't be forged (isTrusted is
      // read-only), so neither layer is reachable programmatically.
      let lastGestureAt = Number.NEGATIVE_INFINITY
      const hasRecentGesture = (): boolean => performance.now() - lastGestureAt < SELECTION_GESTURE_WINDOW_MS

      const toolbar = createSelectionToolbar({
        host: createSelectionToolbarHost(document),
        translate: (text, targetLang, mode, selection) =>
          chrome.runtime.sendMessage({ type: "TR_SELECTION_TRANSLATE", text, targetLang, mode, selection }),
        getContext: () => ({ targetLang: preferredTargetLang, mode: "only" }),
        getSelection: () => {
          const selection = window.getSelection()
          const text = selection?.toString().trim() ?? ""
          if (text.length === 0 || text.length > SELECTION_MAX_CHARS || selection === null || selection.rangeCount === 0) return undefined
          if (isEditableSelection(selection)) return undefined // the user's own draft — never send it
          const range = selection.getRangeAt(0)
          const clientRects = range.getClientRects()
          return {
            text,
            rect: clientRects.item(clientRects.length - 1) ?? range.getBoundingClientRect(),
            selection: selectionOptionsFor(range, text),
          }
        },
      })

      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      const syncSelection = (): void => {
        debounceTimer = undefined
        if (selectionEnabled && ctx.isValid && hasRecentGesture()) toolbar.onSelectionChange()
      }
      const scheduleSelectionSync = (delayMs: number): void => {
        if (ctx.isInvalid) return
        if (!selectionEnabled) {
          toolbar.dismiss()
          return
        }
        if (debounceTimer !== undefined) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(syncSelection, delayMs)
      }
      const markGestureAndSync = (event: Event): void => {
        if (!event.isTrusted) return
        lastGestureAt = performance.now()
        // selectionchange can settle before pointerup/keyup. Re-check after
        // the trusted gesture so a slow drag selection cannot lose the only
        // scheduled toolbar update.
        scheduleSelectionSync(0)
      }
      ctx.addEventListener(document, "pointerup", markGestureAndSync)
      ctx.addEventListener(document, "keyup", markGestureAndSync)
      ctx.addEventListener(document, "selectionchange", () => {
        scheduleSelectionSync(SELECTION_DEBOUNCE_MS)
      })

      let repositionFrame: number | undefined
      const scheduleReposition = (): void => {
        if (ctx.isInvalid || repositionFrame !== undefined) return
        repositionFrame = requestAnimationFrame(() => {
          repositionFrame = undefined
          if (ctx.isValid) toolbar.onViewportChange()
        })
      }
      ctx.addEventListener(window, "scroll", scheduleReposition, { capture: true, passive: true })
      ctx.addEventListener(window, "resize", scheduleReposition, { passive: true })
      ctx.addEventListener(document, "keydown", (event) => {
        if ((event as KeyboardEvent).key === "Escape") toolbar.dismiss()
      })
      ctx.onInvalidated(() => {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer)
        if (repositionFrame !== undefined) cancelAnimationFrame(repositionFrame)
        toolbar.destroy()
      })
    }

    // Invalidation teardown for the machinery that outlives the runtime:
    // MutationObserver / IntersectionObserver keep firing in an orphaned
    // script, so they are disconnected the moment invalidation is detected
    // (any guarded event/callback touching ctx.isInvalid triggers this).
    ctx.onInvalidated(() => {
      watcher.disconnect()
      scheduler.disconnect()
      client.disconnect()
    })

    // Debug hook, dev channel only: exercise the full round trip by hand —
    // content walk -> Port -> background batcher -> extension -> backfill.
    if (import.meta.env.DEV) {
      ;(globalThis as unknown as { __lingoWebTranslateDebug: unknown }).__lingoWebTranslateDebug = {
        walker,
        client,
        watcher,
        pageMode,
        translateVisible(context: TranslateContext) {
          pageMode.applyMode(context.mode, context.targetLang)
          return `mode=${pageMode.getMode()} targetLang=${pageMode.getTargetLang()}`
        },
      }
    }
  },
})

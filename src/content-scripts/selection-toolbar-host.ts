/**
 * Real DOM implementation of `SelectionToolbarHost` — a closed shadow DOM
 * trigger button + result bubble, not unit-tested directly (same convention as
 * `cursor-overlay.ts`'s host split in packages/chrome-extension): the pure
 * state machine in `selection-toolbar.ts` is what gets tested against a fake
 * host.
 *
 * Two anchored forms (README D18): `showTrigger` reveals a compact text
 * button; `setLoading`/`setResult` swaps it for the bubble in place. Errors
 * restore the button and appear in a transient viewport toast. Trigger clicks
 * are the request-side abuse gate — a page script can dispatch synthetic
 * clicks at the host element but cannot forge `isTrusted`, so untrusted
 * clicks are dropped here rather than in the state machine.
 */
import type { SelectionToolbarHost } from "./selection-toolbar"

const VIEWPORT_MARGIN = 25
const ANCHOR_CLEARANCE = 20

const STYLE = `
  :host {
    --lingo-tr-popover: oklch(1 0 0);
    --lingo-tr-popover-foreground: oklch(0.141 0.005 285.823);
    --lingo-tr-accent: oklch(0.967 0.001 286.375);
    --lingo-tr-border: oklch(0.92 0.004 286.32);
    --lingo-tr-ring: oklch(0.705 0.015 286.067);
    --lingo-tr-shadow: 0 8px 40px 0 rgb(0 0 0 / 0.08), 0 0 1px 0 rgb(0 0 0 / 0.08);
    font-family: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --lingo-tr-popover: oklch(0.21 0.006 285.885);
      --lingo-tr-popover-foreground: oklch(0.985 0 0);
      --lingo-tr-accent: oklch(0.274 0.006 286.033);
      --lingo-tr-border: oklch(1 0 0 / 10%);
      --lingo-tr-ring: oklch(0.552 0.016 285.938);
      --lingo-tr-shadow: 0 8px 40px 0 rgb(0 0 0 / 0.28), 0 0 1px 0 rgb(0 0 0 / 0.28);
    }
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    height: 28px;
    padding: 0 10px;
    background: var(--lingo-tr-popover);
    color: var(--lingo-tr-popover-foreground);
    border: 1px solid color-mix(in oklch, var(--lingo-tr-border) 50%, transparent);
    border-radius: 6px;
    box-shadow: var(--lingo-tr-shadow);
    cursor: pointer;
    font: 500 13px/1 ui-sans-serif, system-ui, sans-serif;
    line-height: 1;
    letter-spacing: 0;
    user-select: none;
    white-space: nowrap;
    transition: background-color 150ms ease, border-color 150ms ease, transform 100ms ease;
  }
  .trigger:hover { background: var(--lingo-tr-accent); }
  .trigger:active { transform: translateY(1px); }
  .trigger:focus-visible {
    outline: 3px solid color-mix(in oklch, var(--lingo-tr-ring) 50%, transparent);
    outline-offset: 1px;
  }
  .bubble {
    box-sizing: border-box;
    min-width: min(240px, calc(100vw - 50px));
    max-width: min(500px, calc(100vw - 50px));
    padding: 16px;
    border: 1px solid var(--lingo-tr-border);
    border-radius: 10px;
    background: var(--lingo-tr-popover);
    color: var(--lingo-tr-popover-foreground);
    box-shadow: var(--lingo-tr-shadow);
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    cursor: default;
  }
  .bubble__spinner {
    display: none;
    box-sizing: border-box;
    width: 16px;
    height: 16px;
    margin-right: 8px;
    border: 1.6px solid color-mix(in oklch, var(--lingo-tr-popover-foreground) 24%, transparent);
    border-top-color: var(--lingo-tr-popover-foreground);
    border-radius: 50%;
    vertical-align: -3px;
    animation: lingo-tr-spin 700ms linear infinite;
  }
  .bubble--loading .bubble__spinner { display: inline-block; }
  .bubble__primary {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.45;
  }
  .bubble__meta {
    margin-top: 4px;
    color: color-mix(in oklch, var(--lingo-tr-popover-foreground) 62%, transparent);
    font-size: 12px;
    line-height: 1.35;
  }
  .bubble__alternatives {
    margin-top: 10px;
    color: color-mix(in oklch, var(--lingo-tr-popover-foreground) 78%, transparent);
    font-size: 13px;
    line-height: 1.45;
  }
  @keyframes lingo-tr-spin { to { transform: rotate(360deg); } }
  .toast {
    position: fixed;
    right: 16px;
    bottom: 16px;
    transform: translateY(8px);
    box-sizing: border-box;
    width: max-content;
    max-width: min(356px, calc(100vw - 32px));
    padding: 14px 16px;
    border: 1px solid var(--lingo-tr-border);
    border-radius: 8px;
    background: var(--lingo-tr-popover);
    color: var(--lingo-tr-popover-foreground);
    box-shadow: var(--lingo-tr-shadow);
    font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0;
    opacity: 0;
    visibility: hidden;
    transition: opacity 120ms ease, transform 120ms ease, visibility 0s linear 120ms;
    pointer-events: none;
  }
  .toast--visible {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
    transition-delay: 0s;
  }
  @media (max-width: 480px) {
    .toast {
      right: 12px;
      bottom: 12px;
      max-width: calc(100vw - 24px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .trigger, .toast { transition: none; }
    .bubble__spinner { animation: none; }
  }
  .hidden { display: none; }
`

export function createSelectionToolbarHost(doc: Document): SelectionToolbarHost {
  const host = doc.createElement("div")
  host.style.cssText = "position:fixed; z-index:2147483647; display:none; visibility:hidden; width:max-content; max-width:calc(100vw - 50px);"
  doc.documentElement.appendChild(host)
  const shadow = host.attachShadow({ mode: "closed" })

  const style = doc.createElement("style")
  style.textContent = STYLE
  const trigger = doc.createElement("button")
  trigger.type = "button"
  trigger.className = "trigger"
  trigger.textContent = "译伴翻译"
  trigger.title = "Translate selection"
  const bubble = doc.createElement("div")
  bubble.className = "bubble hidden"
  bubble.setAttribute("role", "status")
  const spinner = doc.createElement("span")
  spinner.className = "bubble__spinner"
  spinner.setAttribute("aria-hidden", "true")
  const bubblePrimary = doc.createElement("div")
  bubblePrimary.className = "bubble__primary"
  const bubbleMeta = doc.createElement("div")
  bubbleMeta.className = "bubble__meta hidden"
  const bubbleAlternatives = doc.createElement("div")
  bubbleAlternatives.className = "bubble__alternatives hidden"
  bubble.append(spinner, bubblePrimary, bubbleMeta, bubbleAlternatives)
  const toast = doc.createElement("div")
  toast.className = "toast"
  toast.setAttribute("role", "alert")
  shadow.append(style, trigger, bubble, toast)

  let clickCb: (() => void) | undefined
  let anchorRect: DOMRect | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const fireIfTrusted = (event: MouseEvent): void => {
    if (event.isTrusted) clickCb?.()
  }
  trigger.addEventListener("click", fireIfTrusted)

  const positionAt = (rect: DOMRect): void => {
    anchorRect = rect
    const view = doc.defaultView
    if (view === null) return
    const isOutsideViewport = rect.bottom < 0 || rect.top > view.innerHeight || rect.right < 0 || rect.left > view.innerWidth
    host.style.visibility = isOutsideViewport ? "hidden" : "visible"
    if (isOutsideViewport) return

    host.style.left = `${Math.max(VIEWPORT_MARGIN, rect.right)}px`
    host.style.top = `${rect.bottom + ANCHOR_CLEARANCE}px`
    const activeSurface = trigger.classList.contains("hidden") ? bubble : trigger
    const bounds = activeSurface.getBoundingClientRect()
    if (bounds.right > view.innerWidth - VIEWPORT_MARGIN) {
      host.style.left = `${Math.max(VIEWPORT_MARGIN, view.innerWidth - bounds.width - VIEWPORT_MARGIN)}px`
    }
    if (bounds.bottom > view.innerHeight - VIEWPORT_MARGIN) {
      host.style.top = `${Math.max(VIEWPORT_MARGIN, rect.top - bounds.height - ANCHOR_CLEARANCE)}px`
    }
  }

  const showTriggerForm = (): void => {
    bubble.className = "bubble hidden"
    trigger.classList.remove("hidden")
    if (anchorRect !== undefined) positionAt(anchorRect)
  }

  const showBubbleForm = (className: string): void => {
    trigger.classList.add("hidden")
    bubble.className = className
    if (anchorRect !== undefined) positionAt(anchorRect)
  }

  const hideToast = (): void => {
    if (toastTimer !== undefined) {
      clearTimeout(toastTimer)
      toastTimer = undefined
    }
    toast.classList.remove("toast--visible")
  }

  const showToast = (message: string): void => {
    hideToast()
    toast.textContent = message
    toast.classList.add("toast--visible")
    toastTimer = setTimeout(() => {
      toast.classList.remove("toast--visible")
      toastTimer = undefined
    }, 4_000)
  }

  return {
    showTrigger(rect) {
      host.style.display = "block"
      hideToast()
      anchorRect = rect
      showTriggerForm()
    },
    reposition(rect) {
      if (host.style.display !== "none") positionAt(rect)
    },
    hide() {
      host.style.display = "none"
      host.style.visibility = "hidden"
      anchorRect = undefined
      hideToast()
    },
    setLoading() {
      bubblePrimary.textContent = "译伴 · 正在翻译…"
      bubbleMeta.classList.add("hidden")
      bubbleAlternatives.classList.add("hidden")
      showBubbleForm("bubble bubble--loading")
    },
    setResult(text, details) {
      bubblePrimary.textContent = text
      if (details?.partOfSpeech !== undefined) {
        bubbleMeta.textContent = details.partOfSpeech
        bubbleMeta.classList.remove("hidden")
      } else {
        bubbleMeta.textContent = ""
        bubbleMeta.classList.add("hidden")
      }
      if (details?.alternatives !== undefined && details.alternatives.length > 0) {
        bubbleAlternatives.textContent = `其他含义： ${details.alternatives.join(" · ")}`
        bubbleAlternatives.classList.remove("hidden")
      } else {
        bubbleAlternatives.textContent = ""
        bubbleAlternatives.classList.add("hidden")
      }
      showBubbleForm("bubble")
    },
    setError(message) {
      showTriggerForm()
      showToast(message)
    },
    onTranslateClick(cb) {
      clickCb = cb
    },
    destroy() {
      hideToast()
      host.remove()
    },
  }
}

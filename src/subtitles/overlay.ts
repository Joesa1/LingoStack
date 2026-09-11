/**
 * Bilingual subtitle overlay — one fixed look, no runtime knobs
 * (D17: no style customization):
 * - Shadow-DOM host appended into `#movie_player`, `position:absolute;
 *   inset:0; pointer-events:none; z-index:9999`.
 * - Cue box centered at `bottom:10%`: `max-width:90%`,
 *   `background:rgba(0,0,0,0.75)`, radius 4px, padding 6px/8px, centered
 *   white 400 text on `system-ui`, 8px row gap.
 * - Translation line ABOVE the original (`DEFAULT_TRANSLATION_POSITION =
 *   "above"`); hidden while missing or identical to the original
 *   (passthrough / model echo).
 * - Base font = player height x 0.03 (`BASE_FONT_RATIO`), tracked by
 *   ResizeObserver.
 * - Status pill bottom-left (`bottom:72px; left:16px`,
 *   `background:rgba(0,0,0,0.5)`): loading blue / error red, error auto-hides
 *   after 5s.
 * - `hideNativeCaptions()` injects a <style> in the page head that hides
 *   YouTube's own caption window (`.ytp-caption-window-container`); `destroy()`
 *   removes it (safe even if it was never called). Deliberately NOT part of
 *   mount: the caller must only hide native captions once it actually has
 *   cues to show in their place — hiding them at mount time (before fetch
 *   even resolves) would strand the user with no captions at all if the fetch
 *   then fails.
 *
 * Based on: docs/packages/web-translate/README.md §7.9 (D17).
 */
import type { SubtitleCue, SubtitleOverlayState } from "./types"
import { normalizeText } from "../shared/text-normalize"

export const HIDE_NATIVE_CAPTIONS_STYLE_ID = "lingo-tr-hide-native-captions"
export const OVERLAY_HOST_ID = "lingo-tr-subtitles-host"
export const NATIVE_CAPTIONS_SELECTOR = ".ytp-caption-window-container"

const BASE_FONT_RATIO = 0.03
const ERROR_AUTO_HIDE_MS = 5_000

const OVERLAY_CSS = `
:host { all: initial; }
.window {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cue-anchor {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 10%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.cue-box {
  display: flex;
  flex-direction: column;
  row-gap: 0.4em;
  max-width: 90%;
  border-radius: 4px;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.75);
  text-align: center;
  color: #ffffff;
  font-weight: 400;
  line-height: 1.25;
  pointer-events: auto;
  user-select: text;
}
.cue-box[hidden] { display: none; }
.line { font-size: 1em; }
.line[hidden] { display: none; }
.pill {
  position: absolute;
  left: 16px;
  bottom: 72px;
  border-radius: 6px;
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.5);
  font-size: 12px;
  pointer-events: none;
}
.pill[hidden] { display: none; }
.pill.loading { color: oklch(70% 0.19 250); }
.pill.error { color: oklch(63% 0.24 25); }
`

export type SubtitleOverlay = {
  setCue(cue: SubtitleCue | undefined): void
  setState(state: SubtitleOverlayState, message?: string): void
  /** Hide YouTube's native caption window. Call only once cues are actually ready to display in its place. */
  hideNativeCaptions(): void
  /** Remove the overlay host and un-hide YouTube's native captions (safe even if hideNativeCaptions() was never called). */
  destroy(): void
}

/**
 * Mount the overlay into `playerContainer` (made `position:relative` if
 * static). Does NOT touch YouTube's native captions — call
 * `hideNativeCaptions()` once cues are ready.
 */
export function mountSubtitleOverlay(playerContainer: HTMLElement): SubtitleOverlay {
  const doc = playerContainer.ownerDocument
  const view = doc.defaultView

  if (view !== null && view.getComputedStyle(playerContainer).position === "static") {
    playerContainer.style.position = "relative"
  }

  doc.getElementById(OVERLAY_HOST_ID)?.remove() // stale host from a previous mount

  const host = doc.createElement("div")
  host.id = OVERLAY_HOST_ID
  host.translate = false
  host.className = "notranslate"
  host.setAttribute("data-lingo-tr-skip", "")
  host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:9999;"
  const shadow = host.attachShadow({ mode: "open" })

  const styleEl = doc.createElement("style")
  styleEl.textContent = OVERLAY_CSS

  const windowEl = doc.createElement("div")
  windowEl.className = "window"

  const anchor = doc.createElement("div")
  anchor.className = "cue-anchor"

  const cueBox = doc.createElement("div")
  cueBox.className = "cue-box"
  cueBox.hidden = true

  const translationLine = doc.createElement("div")
  translationLine.className = "line"
  translationLine.hidden = true

  const originalLine = doc.createElement("div")
  originalLine.className = "line"

  const pill = doc.createElement("div")
  pill.className = "pill"
  pill.hidden = true

  // Translation ABOVE the original.
  cueBox.append(translationLine, originalLine)
  anchor.appendChild(cueBox)
  windowEl.append(anchor, pill)
  shadow.append(styleEl, windowEl)
  playerContainer.appendChild(host)

  function applyFontSize(): void {
    const height = playerContainer.getBoundingClientRect().height
    if (height > 0) windowEl.style.fontSize = `${Math.round(height * BASE_FONT_RATIO)}px`
  }
  applyFontSize()

  const ResizeObserverCtor = view?.ResizeObserver
  const resizeObserver = ResizeObserverCtor !== undefined ? new ResizeObserverCtor(applyFontSize) : undefined
  resizeObserver?.observe(playerContainer)

  let errorHideTimer: ReturnType<typeof setTimeout> | undefined

  return {
    hideNativeCaptions() {
      if (doc.getElementById(HIDE_NATIVE_CAPTIONS_STYLE_ID) !== null) return
      const style = doc.createElement("style")
      style.id = HIDE_NATIVE_CAPTIONS_STYLE_ID
      style.textContent = `${NATIVE_CAPTIONS_SELECTOR}, ${NATIVE_CAPTIONS_SELECTOR} * { display: none !important; opacity: 0 !important; visibility: hidden !important; }`
      doc.head.appendChild(style)
    },
    setCue(cue) {
      if (cue === undefined || cue.text.length === 0) {
        cueBox.hidden = true
        return
      }
      cueBox.hidden = false
      originalLine.textContent = cue.text
      const translation = cue.translation
      // Identical translation = passthrough / model echo — one line is enough.
      if (translation === undefined || translation.length === 0 || normalizeText(translation) === normalizeText(cue.text)) {
        translationLine.hidden = true
        translationLine.textContent = ""
      } else {
        translationLine.hidden = false
        translationLine.textContent = translation
      }
    },
    setState(state, message) {
      if (errorHideTimer !== undefined) {
        clearTimeout(errorHideTimer)
        errorHideTimer = undefined
      }
      if (state === "idle") {
        pill.hidden = true
        return
      }
      pill.hidden = false
      pill.className = `pill ${state}`
      pill.textContent = state === "loading" ? "正在获取或翻译字幕…" : (message ?? "字幕翻译失败，请关闭字幕后重新开启。")
      if (state === "error") {
        errorHideTimer = setTimeout(() => {
          pill.hidden = true
        }, ERROR_AUTO_HIDE_MS)
      }
    },
    destroy() {
      if (errorHideTimer !== undefined) clearTimeout(errorHideTimer)
      resizeObserver?.disconnect()
      host.remove()
      doc.getElementById(HIDE_NATIVE_CAPTIONS_STYLE_ID)?.remove()
    },
  }
}

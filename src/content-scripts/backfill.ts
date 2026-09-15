/**
 * Backfill: render a `TranslationUnit`'s loading/done/error state into the
 * DOM, and restore (undo) it.
 *
 * The original content is NEVER destroyed:
 * - `bilingual` keeps the unit's existing children untouched and APPENDS a
 *   wrapper span holding the translation.
 * - `only` moves the existing children into a hidden `data-lingo-tr-source`
 *   span (not deleted) and appends a wrapper showing the translation as
 *   plain text. Known V1 limitation: rich inline structure (links, bold) in
 *   the ORIGINAL is preserved (just hidden), but the wrapper's translated
 *   text is always plain text — no attempt to reproduce that structure in
 *   the translation.
 *
 * Bilingual layout (D10 — the page must stay calm instead of exploding):
 * - BLOCK unit: (a) a real block-display element (paragraph, list item,
 *   heading, ...), or (b) a walker segment span whose PARENT is not a flex
 *   container. `<br>` line break, then the translation as an `inline-block`
 *   span with `margin: 8px 0` breathing room — its own line under the
 *   original.
 * - INLINE unit: (a) a real inline-display anchor element, or (b) a walker
 *   segment span whose PARENT computed display includes "flex". NO line
 *   break — the translation flows on the SAME line after a two-space
 *   separator.
 * - The same-line decision is `forceBlockTranslation = !isFlexParent`, where
 *   `isFlexParent` reads the RUN's parent container, not the run itself. Nav
 *   bars / button rows are typically flex, so their loose runs stay
 *   same-line; lyric lines and prose sit in a non-flex container (e.g. plain
 *   `<div>`), so each line's translation gets its own line by default —
 *   segments are NOT unconditionally same-line.
 * - Translation follows source color by default. A validated user color
 *   overrides only translated text, in both bilingual and replacement modes.
 *
 * Every unit's wrapper is APPENDED as the unit element's last child, never
 * inserted as a sibling.
 *
 * Based on: docs/packages/web-translate/README.md §7.4, D10
 */
import type { TranslateMode, WebTranslateRpcErrorCode } from "../shared/types"

import type { TranslationUnit } from "./walker"
import {
  clearWrapperIntegrity,
  recordCompletedBilingualWrapper,
  resetWrapperTamperRepairs,
} from "./wrapper-integrity"

const RTL_LANGS = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd"])

function isRtlLang(targetLang: string): boolean {
  const base = targetLang.toLowerCase().split("-")[0] ?? ""
  return RTL_LANGS.has(base)
}

function doc(node: Node): Document {
  return node.ownerDocument ?? (node as unknown as Document)
}

/** Tag fallback for detached nodes / environments without computed style (mirrors walker.ts's fallback set). */
const INLINE_TAGS_FALLBACK = new Set([
  "A", "SPAN", "B", "STRONG", "EM", "I", "U", "SMALL", "SUB", "SUP", "ABBR", "CITE", "Q", "MARK", "TIME", "LABEL",
])

/**
 * Same-line vs own-line layout decision (D10). A walker segment span (loose
 * inline run) goes by its PARENT's computed display — flex parent (nav
 * bars, button rows) => same-line; anything else (plain <div>, lyric/prose
 * containers) => own line.
 * Everything else (real elements) goes by its OWN computed display.
 */
function isInlineUnit(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  if (el.hasAttribute("data-lingo-tr-segment")) {
    const parent = el.parentElement
    const parentDisplay = parent === null ? undefined : view?.getComputedStyle?.(parent).display
    return parentDisplay !== undefined && parentDisplay.includes("flex")
  }
  const display = view?.getComputedStyle?.(el).display
  if (display !== undefined && display !== "") return display.startsWith("inline")
  return INLINE_TAGS_FALLBACK.has(el.tagName)
}

function queryDirectChild(el: Element, selector: string): HTMLElement | null {
  for (const child of Array.from(el.children)) {
    if (child.matches(selector)) return child as HTMLElement
  }
  return null
}

/**
 * Ensure the unit's wrapper (and, for `only` mode, its hidden source span)
 * exist. Idempotent: re-rendering the same unit reuses the existing wrapper
 * instead of appending a second one.
 */
function ensureWrapper(unit: TranslationUnit, mode: TranslateMode): HTMLElement {
  const el = unit.element
  const d = doc(el)

  if (mode === "only") {
    let source = queryDirectChild(el, "[data-lingo-tr-source]")
    if (source === null) {
      source = d.createElement("span")
      source.setAttribute("data-lingo-tr-source", "")
      source.hidden = true
      const existingChildren = Array.from(el.childNodes).filter(
        (n) => !(n instanceof Element && n.hasAttribute("data-lingo-tr-wrapper")),
      )
      for (const child of existingChildren) source.appendChild(child)
      el.insertBefore(source, el.firstChild)
    }
  }

  let wrapper = queryDirectChild(el, "[data-lingo-tr-wrapper]")
  if (wrapper === null) {
    wrapper = d.createElement("span")
    wrapper.setAttribute("data-lingo-tr-for", unit.id)
    el.appendChild(wrapper)
  }
  wrapper.setAttribute("data-lingo-tr-wrapper", mode)
  return wrapper
}

export function renderLoading(unit: TranslationUnit, mode: TranslateMode): void {
  const wrapper = ensureWrapper(unit, mode)
  clearWrapperIntegrity(wrapper)
  wrapper.setAttribute("data-lingo-tr-state", "loading")
  wrapper.removeAttribute("data-lingo-tr-error")
  wrapper.removeAttribute("role")
  wrapper.removeAttribute("tabindex")
  wrapper.className = "lingo-tr"
  wrapper.innerHTML = '<span class="lingo-tr__spinner" aria-label="translating"></span>'
  unit.element.setAttribute("data-lingo-tr-state", "loading")
}

export function renderDone(unit: TranslationUnit, mode: TranslateMode, translatedText: string, targetLang: string): void {
  const wrapper = ensureWrapper(unit, mode)
  clearWrapperIntegrity(wrapper)
  const d = doc(wrapper)
  wrapper.setAttribute("data-lingo-tr-state", "done")
  wrapper.removeAttribute("data-lingo-tr-error")
  wrapper.removeAttribute("role")
  wrapper.removeAttribute("tabindex")
  wrapper.setAttribute("lang", targetLang)
  wrapper.setAttribute("dir", isRtlLang(targetLang) ? "rtl" : "ltr")
  wrapper.innerHTML = ""
  if (mode === "bilingual") {
    const textEl = d.createElement("span")
    textEl.textContent = translatedText
    if (isInlineUnit(unit.element)) {
      // Same line, two-space separator — never a line break inside an inline run (D10).
      wrapper.className = "lingo-tr lingo-tr--bi lingo-tr--inline"
      textEl.className = "lingo-tr__text lingo-tr__text--inline"
      const space = d.createElement("span")
      space.className = "lingo-tr__space"
      space.textContent = "  "
      wrapper.append(space, textEl)
    } else {
      wrapper.className = "lingo-tr lingo-tr--bi lingo-tr--block"
      textEl.className = "lingo-tr__text lingo-tr__text--block"
      const br = d.createElement("br")
      br.className = "lingo-tr__br"
      wrapper.append(br, textEl)
    }
  } else {
    wrapper.className = "lingo-tr lingo-tr--only"
    wrapper.textContent = translatedText
  }
  unit.element.setAttribute("data-lingo-tr-state", "done")
  recordCompletedBilingualWrapper(wrapper)
}

/**
 * The model returned text identical to the source — content already in the
 * target language that slipped past the language filter (short/ambiguous
 * text gives unreliable detection; the filter deliberately fails open).
 * Rendering it would show a duplicate line, so undo
 * the loading UI instead: remove the wrapper and (for `only` mode) move the
 * original back out of the hidden source span. Bookkeeping attributes stay,
 * with state `"same"` — a re-walk skips this unit via rule 7 without
 * expecting a wrapper to exist.
 */
export function renderSameAsSource(unit: TranslationUnit): void {
  const el = unit.element
  const wrapper = queryDirectChild(el, "[data-lingo-tr-wrapper]")
  if (wrapper !== null) {
    clearWrapperIntegrity(wrapper)
    wrapper.remove()
  }
  const source = queryDirectChild(el, "[data-lingo-tr-source]")
  if (source !== null) {
    while (source.firstChild !== null) el.insertBefore(source.firstChild, source)
    source.remove()
  }
  el.setAttribute("data-lingo-tr-state", "same")
}

export function renderError(
  unit: TranslationUnit,
  mode: TranslateMode,
  error: { code: WebTranslateRpcErrorCode; message: string },
): void {
  const wrapper = ensureWrapper(unit, mode)
  clearWrapperIntegrity(wrapper)
  wrapper.setAttribute("data-lingo-tr-state", "error")
  wrapper.setAttribute("data-lingo-tr-error", error.code)
  wrapper.setAttribute("role", "button")
  wrapper.setAttribute("tabindex", "0")
  wrapper.title = "翻译失败，点击重试"
  wrapper.className = "lingo-tr lingo-tr--error"
  wrapper.innerHTML = '<span class="lingo-tr__err-icon">⚠</span><span class="lingo-tr__err-text">重试</span>'
  unit.element.setAttribute("data-lingo-tr-state", "error")
}

/** Undo a single unit's backfill and fully unmark it (a later walk treats it as brand new — the cache still absorbs the cost). */
export function restoreUnit(element: Element): void {
  const wrapper = queryDirectChild(element, "[data-lingo-tr-wrapper]")
  if (wrapper !== null) {
    clearWrapperIntegrity(wrapper)
    wrapper.remove()
  }
  resetWrapperTamperRepairs(element)

  const source = queryDirectChild(element, "[data-lingo-tr-source]")
  if (source !== null) {
    while (source.firstChild !== null) element.insertBefore(source.firstChild, source)
    source.remove()
  }

  element.removeAttribute("data-lingo-tr-paragraph")
  element.removeAttribute("data-lingo-tr-id")
  element.removeAttribute("data-lingo-tr-hash")
  element.removeAttribute("data-lingo-tr-state")
  element.removeAttribute("data-lingo-tr-remounts")

  // A synthetic segment span (walker-created anchor for a loose inline/text
  // run in a mixed container) is unwrapped entirely — the original nodes move
  // back to where they were, restoring the pre-translation DOM byte-for-byte.
  if (element.hasAttribute("data-lingo-tr-segment")) {
    const parent = element.parentNode
    if (parent !== null) {
      while (element.firstChild !== null) parent.insertBefore(element.firstChild, element)
      parent.removeChild(element)
    }
  }
}

/** Restore every backfilled unit under `root` (used by the "off" toggle — README §7.6/§11 restoreAll). */
export function restoreAll(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll("[data-lingo-tr-paragraph]"))) {
    restoreUnit(element)
  }
}

const STYLE_MARKER_ATTR = "data-lingo-tr-style"

/**
 * D10 (bilingual pages must stay calm):
 * - block translation: inline-block + `margin: 8px 0` on its own line.
 * - inline translation: flows in place, no layout impact beyond the text.
 * - translated text inherits source color or the user-selected CSS variable.
 * - spinner: 6px thin muted arc (a page of pending units must not become a
 *   field of high-contrast rings).
 * - `overflow-wrap: anywhere` keeps long translated words from blowing out
 *   containers; CJK targets get a proper native font stack.
 */
const INJECTED_CSS = `
[data-lingo-tr-wrapper], [data-lingo-tr-wrapper] * { overflow-wrap: anywhere; word-break: normal; }
[data-lingo-tr-wrapper="only"] { color: var(--lingo-translation-color, inherit); }
[data-lingo-tr-wrapper] .lingo-tr__text {
  color: var(--lingo-translation-color, inherit);
  font-family: inherit; font-style: inherit;
}
[data-lingo-tr-wrapper] .lingo-tr__text--block { display: inline-block; margin: 8px 0 !important; }
[data-lingo-tr-wrapper] .lingo-tr__text--inline { display: inline; }
[data-lingo-tr-wrapper][lang^="zh"] .lingo-tr__text {
  font-family: "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans SC", -apple-system, sans-serif;
}
[data-lingo-tr-wrapper][lang="zh-TW"] .lingo-tr__text {
  font-family: "PingFang TC", "Microsoft JhengHei", "Source Han Sans TC", "Noto Sans TC", -apple-system, sans-serif;
}
[data-lingo-tr-wrapper][lang="ja"] .lingo-tr__text {
  font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Noto Sans JP", -apple-system, sans-serif;
}
[data-lingo-tr-wrapper][data-lingo-tr-state="loading"] .lingo-tr__spinner {
  display: inline-block; width: 6px; height: 6px; margin: 0 4px; vertical-align: middle;
  border: 1.5px solid transparent; border-top-color: currentColor; border-radius: 50%;
  opacity: 0.45; animation: lingo-tr-spin 0.6s linear infinite;
}
@keyframes lingo-tr-spin { to { transform: rotate(360deg); } }
[data-lingo-tr-wrapper][data-lingo-tr-state="error"] { cursor: pointer; color: #b3261e; }
[data-lingo-tr-wrapper] .lingo-tr__err-icon { margin-right: 0.25em; }
`

/** Idempotent per-root style injection (README §7.4) — a second call on the same root is a no-op. */
export function ensureStyleInjected(root: Document | ShadowRoot): void {
  if (root.querySelector(`style[${STYLE_MARKER_ATTR}]`) !== null) return
  const d = root instanceof Document ? root : (root.ownerDocument as Document)
  const style = d.createElement("style")
  style.setAttribute(STYLE_MARKER_ATTR, "")
  style.textContent = INJECTED_CSS
  const target = root instanceof Document ? (root.head ?? root.documentElement) : root
  target.appendChild(style)
}

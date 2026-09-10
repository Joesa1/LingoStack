/**
 * DOM walker: collects `TranslationUnit`s from a subtree.
 *
 * An element with no block-level element children AND no `<br>` child becomes
 * ONE unit covering its whole text content. A MIXED container (block/`<br>`
 * children alongside loose inline/text children, e.g.
 * `<div>intro text<p>a paragraph</p></div>` or genius.com's
 * `<div>line1<br>line2<br>line3</div>` with NO real block sibling at all)
 * collects the block children AND wraps each loose inline/text run in a
 * synthetic `<span data-lingo-tr-segment>` that anchors the run's unit — bare
 * Text nodes have nowhere to store `data-lingo-tr-*` bookkeeping, so the wrap is
 * what makes them addressable. `<br>` splits runs (each visual line is its
 * own unit — matters for lyrics/poetry sites like genius.com; a `<br>` child
 * forces the MIXED path even when it is the only element child — see
 * `hasBrChild`).
 * The wrap happens only after every emit precondition passes (has letters,
 * not already target-language), so a declined run never leaves an orphan
 * span behind; `restoreUnit` unwraps segments to restore the original DOM.
 * NOTE: wrapping mutates the page during the walk — callers that run under a
 * live MutationObserver must pause it (see mutation-watcher.ts).
 *
 * "Block child" is judged structurally, not just by the child's OWN computed
 * display (see `isStructuralElement`/`containsBlockDescendant`): a child that
 * is itself `display: inline` but has a block descendant buried anywhere
 * inside it is still recursed into, never flattened into a run. Framework
 * mount points default to inline with no content of their own (an unstyled
 * `<span>`, or a custom element like `<routable-page>`) — without this check,
 * the walker would treat the ENTIRE wrapped subtree as one inline-run member
 * and glue the whole page's text into a single unit.
 *
 * Skip rules (early return, do not descend):
 * 1. Already-produced output (`[data-lingo-tr-wrapper]`/`[data-lingo-tr-source]`) —
 *    the walker must never translate its own previous output.
 * 2. `.notranslate`, `[translate="no"]`, `[contenteditable]` (V1 skips
 *    editable regions) — these three are the page's machine-translation
 *    opt-out markers, bypassable per site rule (`ignoreOptOutSelector`,
 *    e.g. Notion share pages blanket-mark read-only content); plus the
 *    never-bypassed `[data-lingo-tr-skip]` and `[aria-hidden="true"]`.
 * 3. Non-content tags (script/style/code/media/embeds/form controls/svg/math).
 * 4. Invisible (`display:none`/`visibility:hidden`/zero client rects) — only
 *    checked when `opts.checkVisibility` is on (full-page mode; a
 *    single-target hover/selection walk skips this check).
 * 5. Empty after trim, or no letters (`\p{L}`) — pure punctuation/digits.
 * 6. `guessIsTargetLanguage` — cheap script-sampling heuristic; unknown script
 *    fails open (translates anyway) rather than guessing wrong and skipping.
 * 7. Already handled: hash of the current text matches the stored
 *    `data-lingo-tr-hash` AND state is `done` (translation mounted — wrapper
 *    presence and completed bilingual content are verified first: a framework
 *    re-render that stripped or rewrote the wrapper triggers a capped repair)
 *    or
 *    `same` (model output was identical to the source; deliberately no
 *    wrapper, see backfill `renderSameAsSource`).
 *
 * `open` shadow roots are walked as additional roots; `closed` ones are
 * unreachable and skipped (no error — just no units from inside them).
 *
 * Site rules (§7.1a, `siteRules` option): `excludeSelector` plugs into the
 * SAME skip check as `NON_CONTENT_TAGS` below (recursion early-return,
 * inline-run boundary, parent leaf-text ancestor rejection — no new code
 * path); `includeSelector` is a separate whitelist gate checked only at
 * EMIT time (`emitLeafUnit` and the pre-wrap precondition loop in
 * `collectInlineRuns`), not at recursion — the walker still fully descends
 * through excluded-from-emission subtrees to find matching descendants.
 *
 * Based on: docs/packages/web-translate/README.md §7.1, §7.1a
 */
import { normalizeText } from "../shared/text-normalize"
import type { ResolvedSiteRules } from "./site-rules"
import {
  claimWrapperTamperRepair,
  clearWrapperIntegrity,
  isCompletedWrapperContentTampered,
  resetWrapperTamperRepairs,
  stopWrapperIntegrityChecks,
} from "./wrapper-integrity"

export type TranslationUnit = {
  id: string
  element: Element
  sourceText: string
  hash: string
}

const NO_SITE_RULES: ResolvedSiteRules = { excludeSelector: null, includeSelector: null, ignoreOptOutSelector: null }

export type CollectUnitsOptions = {
  /** Full-page mode checks visibility; a single hover/selection target does not. Default true. */
  checkVisibility?: boolean
  targetLang: string
  siteRules?: ResolvedSiteRules
}

const NON_CONTENT_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "VAR",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "AUDIO",
  "VIDEO",
  "IMG",
])

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML"

/**
 * A real `<svg>`/`<math>` element's `.tagName` is lowercase (foreign-content
 * case preservation), NOT `"SVG"`/`"MATH"` — a former `NON_CONTENT_TAGS`
 * entry for those two literal uppercase strings never matched (verified in
 * jsdom). `namespaceURI` is the robust check and covers the whole
 * foreign-content subtree, not just the two root tag names.
 */
function isForeignContentRoot(el: Element): boolean {
  return el.namespaceURI === SVG_NAMESPACE || el.namespaceURI === MATHML_NAMESPACE
}

/** Used only when computed style is unavailable (e.g. a detached node in a test). */
const INLINE_TAGS_FALLBACK = new Set([
  "A",
  "SPAN",
  "B",
  "STRONG",
  "EM",
  "I",
  "U",
  "SMALL",
  "SUB",
  "SUP",
  "ABBR",
  "CITE",
  "Q",
  "MARK",
  "TIME",
  "LABEL",
  "BR",
])

const LETTER_RE = /\p{L}/u

function isOwnOutput(el: Element): boolean {
  return el.hasAttribute("data-lingo-tr-wrapper") || el.hasAttribute("data-lingo-tr-source")
}

function isContentEditable(el: Element): boolean {
  const value = el.getAttribute("contenteditable")
  return value !== null && value !== "false"
}

/** `.sr-only`/`.visually-hidden`: the standard a11y-only-content classes (Bootstrap, Tailwind, WordPress, ...). */
function isAccessibilityHiddenClass(el: Element): boolean {
  return el.classList.contains("sr-only") || el.classList.contains("visually-hidden")
}

/** The page's machine-translation opt-out markers — bypassable by a site rule's `ignoreOptOutSelector` (see `ResolvedSiteRules`), unlike every other skip. */
function isTranslateOptOut(el: Element): boolean {
  return el.classList.contains("notranslate") || el.getAttribute("translate") === "no" || isContentEditable(el)
}

function bypassesOptOut(el: Element, siteRules: ResolvedSiteRules): boolean {
  return siteRules.ignoreOptOutSelector !== null && el.closest(siteRules.ignoreOptOutSelector) !== null
}

function shouldSkipElement(el: Element, siteRules: ResolvedSiteRules): boolean {
  if (NON_CONTENT_TAGS.has(el.tagName)) return true
  if (isForeignContentRoot(el)) return true
  if (isOwnOutput(el)) return true
  if (el.closest('[data-lingo-tr-wrapper], [data-lingo-tr-source]') !== null) return true
  if (isTranslateOptOut(el) && !bypassesOptOut(el, siteRules)) return true
  if (el.hasAttribute("data-lingo-tr-skip")) return true
  if (el.getAttribute("aria-hidden") === "true") return true
  if (isAccessibilityHiddenClass(el)) return true
  if ((el as HTMLElement).hidden === true) return true
  if (siteRules.excludeSelector !== null && el.matches(siteRules.excludeSelector)) return true
  return false
}

/** Whitelist gate (site rules `includeSelector`, §7.1a) — a no-op when the resolved rules don't declare one. */
function isWithinIncludeScope(el: Element, siteRules: ResolvedSiteRules): boolean {
  return siteRules.includeSelector === null || el.closest(siteRules.includeSelector) !== null
}

function isBlockElement(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  const display = view?.getComputedStyle?.(el).display
  if (display !== undefined && display !== "") {
    // Only true inline flow ("inline") and the box-dissolving "contents"
    // count as non-structural. inline-block / inline-flex / inline-grid
    // establish their own self-contained box: their text is a separate
    // visual unit, and flattening it into the surrounding run glues a whole
    // card's worth of unrelated strings into one mega-unit (dashboard/app
    // UIs built from inline-block children).
    return display !== "inline" && display !== "contents"
  }
  return !INLINE_TAGS_FALLBACK.has(el.tagName)
}

/**
 * An inline-computed element still counts as "structural" (recurse into it,
 * never flatten it into an inline run) if ANY descendant, however deep, is
 * itself block. Framework mount points (`<span>`, unstyled custom elements
 * like `<routable-page>`) default to `display: inline` with zero content of
 * their own — without this recursive check, the walker would treat "the
 * entire routed page" as one loose inline-run member and glue its whole text
 * into a single unit (see `isStructuralElement`).
 */
function containsBlockDescendant(el: Element, siteRules: ResolvedSiteRules): boolean {
  for (const child of Array.from(el.children)) {
    if (shouldSkipElement(child, siteRules)) continue
    if (isBlockElement(child)) return true
    if (containsBlockDescendant(child, siteRules)) return true
  }
  return false
}

/**
 * Decides whether a direct child is recursed into (`collectFromElement`) or
 * folded into a loose inline run (`collectInlineRuns`). EVERY child is
 * recursed into before it is classified — an earlier version only recursed
 * into children already judged block, so a child judged inline (but
 * structurally wrapping real block content many layers deep) was never
 * opened up. Genius.com's real DOM
 * is `<span><routable-page><ng-outlet><article-page><div>...article...`,
 * where the first four wrapper layers are all computed `display: inline`.
 */
function isStructuralElement(el: Element, siteRules: ResolvedSiteRules): boolean {
  return isBlockElement(el) || containsBlockDescendant(el, siteRules)
}

/**
 * V1 checks computed `display`/`visibility` only. The design also mentions a
 * zero-`getClientRects()` fallback (catches elements hidden by other CSS
 * tricks without literally `display:none`) — dropped for V1: it needs a real
 * layout engine (jsdom returns zero rects for every element, hidden or not,
 * so the check can't be verified in tests, and would be unreliable disguised
 * as "verified"). `display:none`/`visibility:hidden` covers the common case.
 */
function isInvisible(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  const style = view?.getComputedStyle?.(el)
  if (style === undefined) return false
  return style.display === "none" || style.visibility === "hidden"
}

/** Text content of `el`, excluding any subtree rooted at a skip-worthy descendant. */
function extractLeafText(el: Element, siteRules: ResolvedSiteRules): string {
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let ancestor = node.parentElement
      while (ancestor !== null && ancestor !== el) {
        if (shouldSkipElement(ancestor, siteRules)) return NodeFilter.FILTER_REJECT
        ancestor = ancestor.parentElement
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let text = ""
  let node = walker.nextNode()
  while (node !== null) {
    text += node.textContent ?? ""
    node = walker.nextNode()
  }
  return text
}

/**
 * Cheap sync fast-path for "is this text already in the target language" —
 * NOT the final arbiter (that is the async `chrome.i18n.detectLanguage`
 * filter in language-filter.ts, D9). This layer only skips what Unicode
 * script membership can prove cheaply, counting Han / kana / hangul
 * SEPARATELY so one CJK language never masquerades as another:
 * - zh target: Han-dominant AND zero kana AND zero hangul (any kana means
 *   Japanese, any hangul means Korean — both must be translated).
 * - ja target: Han+kana dominant AND kana actually present (Han-only text is
 *   likely Chinese — translate it) AND zero hangul.
 * - ko target: hangul-dominant.
 * Latin-script targets get NO sync skip: an ASCII ratio cannot tell English
 * from French/German/etc., so the decision defers to the detect filter.
 * Anything ambiguous fails open (`false`, meaning "translate it").
 */
export function guessIsTargetLanguage(text: string, targetLang: string): boolean {
  const letters = text.match(LETTER_RE) === null ? "" : text.replace(/[^\p{L}]/gu, "")
  if (letters.length < 4) return false
  const hanCount = (letters.match(/\p{Script=Han}/gu) ?? []).length
  const kanaCount = (letters.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length
  const hangulCount = (letters.match(/\p{Script=Hangul}/gu) ?? []).length
  const lang = targetLang.toLowerCase()
  if (lang.startsWith("zh")) {
    return hanCount / letters.length > 0.6 && kanaCount === 0 && hangulCount === 0
  }
  if (lang.startsWith("ja")) {
    return (hanCount + kanaCount) / letters.length > 0.6 && kanaCount > 0 && hangulCount === 0
  }
  if (lang.startsWith("ko")) {
    return hangulCount / letters.length > 0.6
  }
  return false
}

/** Cheap, fast, non-cryptographic change-detection hash (djb2 variant) — not the background's cache key. */
function fastHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

type WalkState = {
  units: TranslationUnit[]
  options: Required<CollectUnitsOptions>
  visitedRoots: Set<Document | ShadowRoot>
}

const REMOUNT_ATTR = "data-lingo-tr-remounts"
/** After this many remounts the element degrades to "leave untranslated" — a framework that relentlessly strips our wrapper is a tug-of-war we must not fight forever (README §7.3). */
const MAX_WRAPPER_REMOUNTS = 3

function directChildWithAttribute(el: Element, attr: string): Element | null {
  for (const child of Array.from(el.children)) {
    if (child.hasAttribute(attr)) return child
  }
  return null
}

/**
 * §7.3 remount repair: the element's bookkeeping says a translation was
 * rendered here, but the wrapper is gone — a framework re-render (React /
 * Lexical reconciliation) stripped our appended output while the element and
 * its `data-lingo-tr-*` attributes survived. Without repair, rule 7 would skip
 * the element forever and the translation is silently lost. In `only` mode
 * the original text is still trapped in
 * the hidden source span, so it is moved back first — otherwise
 * `extractLeafText` sees an empty element and bails before rule 7. Clearing
 * the state lets the walk below re-emit; the background cache absorbs the
 * re-translate cost. Remounts are capped per element via `REMOUNT_ATTR`.
 */
function repairStrippedWrapper(el: Element): void {
  if (el.getAttribute("data-lingo-tr-state") !== "done") return
  if (directChildWithAttribute(el, "data-lingo-tr-wrapper") !== null) return

  const remounts = Number(el.getAttribute(REMOUNT_ATTR) ?? "0")
  if (remounts >= MAX_WRAPPER_REMOUNTS) return
  el.setAttribute(REMOUNT_ATTR, String(remounts + 1))

  const source = directChildWithAttribute(el, "data-lingo-tr-source")
  if (source !== null) {
    while (source.firstChild !== null) el.insertBefore(source.firstChild, source)
    source.remove()
  }
  el.removeAttribute("data-lingo-tr-state")
}

function emitLeafUnit(el: Element, nextId: () => string, state: WalkState): void {
  if (!isWithinIncludeScope(el, state.options.siteRules)) return
  repairStrippedWrapper(el)
  const rawText = extractLeafText(el, state.options.siteRules)
  const normalized = normalizeText(rawText)
  if (normalized.length === 0) return
  if (!LETTER_RE.test(normalized)) return
  if (guessIsTargetLanguage(normalized, state.options.targetLang)) return

  const hash = fastHash(normalized)
  const existingId = el.getAttribute("data-lingo-tr-id")
  const existingState = el.getAttribute("data-lingo-tr-state")
  const existingHash = el.getAttribute("data-lingo-tr-hash")
  if (existingHash !== null && existingHash !== hash) resetWrapperTamperRepairs(el)
  if (existingId !== null && existingHash === hash && (existingState === "done" || existingState === "same")) {
    const wrapper = directChildWithAttribute(el, "data-lingo-tr-wrapper")
    if (existingState === "done" && wrapper !== null && isCompletedWrapperContentTampered(wrapper)) {
      if (!claimWrapperTamperRepair(el)) {
        stopWrapperIntegrityChecks(wrapper)
        return
      }
      clearWrapperIntegrity(wrapper)
      wrapper.remove()
      el.removeAttribute("data-lingo-tr-state")
    } else {
      // Rule 7: already handled, text unchanged. "done" = translation mounted
      // (wrapper presence verified by repairStrippedWrapper above); "same" =
      // model returned text identical to the source, deliberately no wrapper.
      return
    }
  }

  const id = existingId ?? nextId()
  el.setAttribute("data-lingo-tr-paragraph", "")
  el.setAttribute("data-lingo-tr-id", id)
  el.setAttribute("data-lingo-tr-hash", hash)
  el.setAttribute("data-lingo-tr-state", "pending")

  state.units.push({ id, element: el, sourceText: normalized, hash })
}

/** Text a run would contribute, for the pre-wrap emit checks (mirrors `extractLeafText`'s skip handling). */
function runText(run: Node[], siteRules: ResolvedSiteRules): string {
  let text = ""
  for (const node of run) {
    text += node.nodeType === 3 ? (node.textContent ?? "") : extractLeafText(node as Element, siteRules)
  }
  return text
}

/**
 * Collect loose inline/text runs of a MIXED container (block children present)
 * as segment units. Runs are maximal stretches of consecutive text/inline
 * nodes; block children, `<br>`, skip-worthy elements, and previously created
 * segment spans all end the current run (an existing segment is re-emitted
 * as-is, never re-wrapped — that keeps a re-walk idempotent).
 */
function collectInlineRuns(el: Element, nextId: () => string, state: WalkState): void {
  const siteRules = state.options.siteRules
  const runs: Node[][] = []
  let current: Node[] = []
  const endRun = () => {
    if (current.length > 0) {
      runs.push(current)
      current = []
    }
  }

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      current.push(node)
      continue
    }
    if (node.nodeType !== 1) continue // comments etc. — ignored, do not break the run
    const child = node as Element
    if (child.hasAttribute("data-lingo-tr-segment")) {
      endRun()
      emitLeafUnit(child, nextId, state)
      continue
    }
    // `shouldSkipElement` checked BEFORE `isStructuralElement`: the latter
    // calls `getComputedStyle`, which jsdom cannot compute for a foreign-
    // content (SVG/MathML) element and throws — `shouldSkipElement`'s
    // namespace check must short-circuit first for those elements.
    if (child.tagName === "BR" || shouldSkipElement(child, siteRules) || isStructuralElement(child, siteRules)) {
      endRun()
      continue
    }
    current.push(child)
  }
  endRun()

  for (const run of runs) {
    // All emit preconditions BEFORE mutating: a declined run must not leave an
    // orphan segment span that restoreUnit would never visit. The include-scope
    // check here is on `el` (the run's container), equivalent to checking the
    // not-yet-created segment span (`segment.closest()` would resolve through
    // the same container) — preserves the same no-orphan invariant.
    if (!isWithinIncludeScope(el, siteRules)) continue
    const normalized = normalizeText(runText(run, siteRules))
    if (normalized.length === 0) continue
    if (!LETTER_RE.test(normalized)) continue
    if (guessIsTargetLanguage(normalized, state.options.targetLang)) continue

    const first = run[0]
    if (first === undefined) continue
    const segment = el.ownerDocument.createElement("span")
    segment.setAttribute("data-lingo-tr-segment", "")
    el.insertBefore(segment, first)
    for (const node of run) segment.appendChild(node)
    emitLeafUnit(segment, nextId, state)
  }
}

function hasBrChild(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (child.tagName === "BR") return true
  }
  return false
}

function collectFromElement(el: Element, nextId: () => string, state: WalkState): void {
  const siteRules = state.options.siteRules
  if (shouldSkipElement(el, siteRules)) return
  if (state.options.checkVisibility && isInvisible(el)) return

  const shadow = el.shadowRoot
  if (shadow !== null && shadow !== undefined) {
    collectFromRoot(shadow, nextId, state)
  }

  const blockChildren: Element[] = []
  for (const child of Array.from(el.children)) {
    // `shouldSkipElement` checked first — see the matching comment in
    // `collectInlineRuns` (jsdom throws computing style for foreign content).
    if (!shouldSkipElement(child, siteRules) && isStructuralElement(child, siteRules)) blockChildren.push(child)
  }

  // A `<br>` child always forces the inline-run split path, even with zero
  // real block siblings — a
  // container whose only element children are text + <br> (e.g. genius.com's
  // `<blockquote><div class="referent">line1<br>line2<br>line3</div>`) would
  // otherwise report zero block children and collapse every line into one
  // glued leaf unit.
  if (blockChildren.length === 0 && !hasBrChild(el)) {
    emitLeafUnit(el, nextId, state)
    return
  }
  for (const child of blockChildren) collectFromElement(child, nextId, state)
  collectInlineRuns(el, nextId, state)
}

function collectFromRoot(root: Document | ShadowRoot, nextId: () => string, state: WalkState): void {
  if (state.visitedRoots.has(root)) return
  state.visitedRoots.add(root)
  const rootEl = root instanceof Document ? root.body : (root as ShadowRoot).host
  if (rootEl === null) return
  if (root instanceof Document) {
    collectFromElement(rootEl as Element, nextId, state)
  } else {
    // A shadow root's own children are walked directly (the host element
    // itself was already classified by the caller before descending here).
    for (const child of Array.from(root.children)) {
      if (child instanceof Element) collectFromElement(child, nextId, state)
    }
  }
}

export type DomWalker = {
  collectUnits(root: Element | Document, options: CollectUnitsOptions): TranslationUnit[]
}

/** Each walker instance owns its own monotonic unit-id counter (`u1`, `u2`, ...), scoped to one content-script lifetime. */
export function createDomWalker(): DomWalker {
  let counter = 0
  const nextId = () => `u${++counter}`

  return {
    collectUnits(root, options) {
      const resolvedOptions: Required<CollectUnitsOptions> = {
        checkVisibility: options.checkVisibility ?? true,
        targetLang: options.targetLang,
        siteRules: options.siteRules ?? NO_SITE_RULES,
      }
      const state: WalkState = { units: [], options: resolvedOptions, visitedRoots: new Set() }
      if (root instanceof Document) {
        collectFromRoot(root, nextId, state)
      } else {
        collectFromElement(root, nextId, state)
      }
      return state.units
    },
  }
}

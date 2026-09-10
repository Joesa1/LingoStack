/**
 * Incremental re-translation for SPA-style DOM updates.
 *
 * Double guard against a self-triggered translate loop (README §7.3):
 * 1. `withPaused(fn)` disconnects the observer before `fn` runs and
 *    reconnects after — mutations `fn` causes are never even queued by the
 *    browser (not filtered after the fact), so there is no async-callback
 *    timing race for the common case: a caller wraps a *synchronous*
 *    backfill DOM write (`renderDone`/`renderLoading`/`renderError`/
 *    `restoreUnit`) in `withPaused`.
 * 2. Every mutation record is ALSO filtered by content (`isSelfCaused`) —
 *    this catches writes that land outside a `withPaused` window. A completed
 *    bilingual wrapper is ignored only while its text still matches the
 *    snapshot recorded by backfill; later divergence is a site rewrite.
 *
 * Debounces bursts of mutations, then re-walks only the affected
 * elements — NOT the whole document again — deduplicating nested scopes so
 * a subtree isn't walked twice when both it and an ancestor mutated in the
 * same burst.
 *
 * `attributes` are NOT observed: this only reacts to actual text content
 * changes (childList/characterData), not incidental attribute churn (class
 * toggles, etc.) unrelated to translatable text.
 *
 * Framework-reconciliation tug-of-war is bounded: the walker caps both whole
 * wrapper remounts and completed-wrapper content repairs (README §7.3).
 *
 * Based on: docs/packages/web-translate/README.md §7.3
 */
import type { ResolvedSiteRules } from "./site-rules"
import type { CollectUnitsOptions, DomWalker, TranslationUnit } from "./walker"
import { isCompletedWrapperContentTampered } from "./wrapper-integrity"

const OBSERVE_OPTIONS: MutationObserverInit = { childList: true, subtree: true, characterData: true }

function hasOwnMarker(el: Element): boolean {
  return el.hasAttribute("data-lingo-tr-wrapper") || el.hasAttribute("data-lingo-tr-source")
}

function ownOutputAncestor(record: MutationRecord): Element | null {
  const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement
  return target?.closest("[data-lingo-tr-wrapper], [data-lingo-tr-source]") ?? null
}

/**
 * A childList record is self-caused if every added node is our own
 * wrapper/source output or a walker-created segment span (regardless of what
 * was removed — e.g. "only" mode relocates original children into a new
 * source span, and segment wrapping relocates an inline run into a new span).
 * Segment spans count ONLY here, not in the characterData check below: the
 * span element itself is ours, but the text INSIDE it is page content whose
 * later edits must still trigger re-translation. `nodeType` check, not
 * `instanceof Element`: this runs inside an async MutationObserver callback,
 * where a cross-realm identity check on a global constructor is a needless
 * fragility.
 */
function isSelfCausedChildList(record: MutationRecord): boolean {
  const added = Array.from(record.addedNodes)
  if (added.length === 0) return false
  return added.every(
    (node) => node.nodeType === 1 && (hasOwnMarker(node as Element) || (node as Element).hasAttribute("data-lingo-tr-segment")),
  )
}

function isSelfCaused(record: MutationRecord): boolean {
  const ownOutput = ownOutputAncestor(record)
  if (ownOutput?.hasAttribute("data-lingo-tr-source")) return true
  if (ownOutput?.hasAttribute("data-lingo-tr-wrapper")) {
    return !isCompletedWrapperContentTampered(ownOutput)
  }
  if (record.type === "childList") return isSelfCausedChildList(record)
  return false
}

function scopeElementFor(record: MutationRecord): Element | null {
  const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement
  if (target === null) return null
  const wrapper = target.closest("[data-lingo-tr-wrapper]")
  if (wrapper !== null && isCompletedWrapperContentTampered(wrapper)) return wrapper.parentElement
  return target
}

/** Drop any scope that is a descendant of another pending scope in the same batch — its ancestor's re-walk already covers it. */
function dedupeNestedScopes(scopes: Element[]): Element[] {
  return scopes.filter((el) => !scopes.some((other) => other !== el && other.contains(el)))
}

export type MutationWatcherDeps = {
  walker: DomWalker
  onUnitsDiscovered: (units: TranslationUnit[]) => void
  getTargetLang: () => CollectUnitsOptions["targetLang"]
  /** Resolved once from `location.hostname` at content-script init (§7.1a) — static for this watcher's whole lifetime. */
  siteRules: ResolvedSiteRules
  debounceMs?: number
}

export type MutationWatcher = {
  observe(root: Document | ShadowRoot): void
  disconnect(): void
  withPaused<T>(fn: () => T): T
}

export function createMutationWatcher(deps: MutationWatcherDeps): MutationWatcher {
  const debounceMs = deps.debounceMs ?? 300
  const observedRoots = new Set<Document | ShadowRoot>()
  const pendingScopes = new Set<Element>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush(): void {
    timer = undefined
    const scopes = dedupeNestedScopes(Array.from(pendingScopes))
    pendingScopes.clear()
    const units: TranslationUnit[] = []
    // The walk itself now mutates the page (segment wrapping in mixed
    // containers, walker.ts) — pause observation around it so those inserts
    // are never queued at all; the isSelfCaused segment filter stays as the
    // second guard for walks running outside this function.
    pauseWhile(() => {
      for (const scope of scopes) {
        units.push(...deps.walker.collectUnits(scope, { targetLang: deps.getTargetLang(), siteRules: deps.siteRules }))
      }
    })
    if (units.length > 0) deps.onUnitsDiscovered(units)
  }

  const observer = new MutationObserver((records) => {
    let scheduled = false
    for (const record of records) {
      if (isSelfCaused(record)) continue
      const scope = scopeElementFor(record)
      if (scope === null) continue
      pendingScopes.add(scope)
      scheduled = true
    }
    if (!scheduled) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  })

  function observeTarget(root: Document | ShadowRoot): void {
    const target = root instanceof Document ? root.body : root
    observer.observe(target, OBSERVE_OPTIONS)
  }

  function pauseWhile<T>(fn: () => T): T {
    observer.disconnect()
    try {
      return fn()
    } finally {
      for (const root of observedRoots) observeTarget(root)
    }
  }

  return {
    observe(root) {
      if (observedRoots.has(root)) return
      observedRoots.add(root)
      observeTarget(root)
    },
    disconnect() {
      observer.disconnect()
      observedRoots.clear()
      pendingScopes.clear()
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
    withPaused(fn) {
      return pauseWhile(fn)
    },
  }
}
